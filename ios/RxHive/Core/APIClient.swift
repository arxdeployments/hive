import Foundation
import os

/// The one path to the RX HIVE API.
///
/// ## Why cookies, on a native client
///
/// The backend issues auth as two httpOnly cookies (`rx_access`, `rx_refresh`)
/// and never puts a token in a response body — see `backend/app/api/auth.py`.
/// It *will* accept `Authorization: Bearer` on HTTP requests, but the token to
/// put there is unobtainable by design, and the WebSocket handshake
/// (`core/deps.py:get_current_user_ws`) reads the access cookie and *only* falls
/// back to a query-param token outside production. So cookies are not merely the
/// easier option here, they are the only transport that works for the socket.
///
/// URLSession handles this natively: `HTTPCookieStorage` persists cookies with a
/// `Max-Age` to the app container, so a session survives relaunch exactly as it
/// survives a browser restart, and `URLSessionWebSocketTask` attaches them to the
/// handshake without any help from us.
///
/// ## Refresh
///
/// A 401 on any call means the 15-minute access cookie lapsed. One refresh runs
/// at a time (`RefreshCoordinator`) and every caller that raced into a 401 awaits
/// that same refresh and then replays once. Without the single-flight, a screen
/// that fires five parallel requests on appear would trigger five refreshes —
/// and since the backend *rotates* refresh tokens single-use, four of them would
/// present an already-consumed token and force a spurious sign-out.
actor APIClient {

    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private let refreshCoordinator = RefreshCoordinator()
    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "api")

    /// Fires when the session is unrecoverable. `AuthStore` listens and tears the
    /// UI back to sign-in. A notification rather than a closure because any layer
    /// (a socket, a background upload) can discover expiry.
    static let sessionExpiredNotification = Notification.Name("RxHiveSessionExpired")

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.httpCookieStorage = .shared
            config.httpCookieAcceptPolicy = .always
            config.httpShouldSetCookies = true
            config.timeoutIntervalForRequest = AppConfig.requestTimeout
            // The API is the source of truth for freshness; a cached conversation
            // list that silently shadows new messages is worse than a round trip.
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }

        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = RxDate.parse(text) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Unparseable date: \(text)")
                )
            }
            return date
        }

        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            try encoder.singleValueContainer().encode(RxDate.format(date))
        }
    }

    // MARK: - Public surface

    /// GET/DELETE with no body.
    func send<Response: Decodable>(
        _ method: HTTPMethod,
        _ path: String,
        query: [String: String?] = [:],
        as type: Response.Type = Response.self
    ) async throws -> Response {
        let request = try makeRequest(method, path, query: query, body: nil)
        return try await perform(request, as: type)
    }

    /// POST/PUT/PATCH with a JSON body.
    func send<Body: Encodable, Response: Decodable>(
        _ method: HTTPMethod,
        _ path: String,
        body: Body,
        query: [String: String?] = [:],
        as type: Response.Type = Response.self
    ) async throws -> Response {
        let data = try encoder.encode(body)
        let request = try makeRequest(method, path, query: query, body: data)
        return try await perform(request, as: type)
    }

    /// A call whose response body we don't need (or that returns `{"message": …}`).
    @discardableResult
    func sendIgnoringResponse(
        _ method: HTTPMethod,
        _ path: String,
        query: [String: String?] = [:]
    ) async throws -> Data {
        let request = try makeRequest(method, path, query: query, body: nil)
        return try await performRaw(request)
    }

    @discardableResult
    func sendIgnoringResponse<Body: Encodable>(
        _ method: HTTPMethod,
        _ path: String,
        body: Body,
        query: [String: String?] = [:]
    ) async throws -> Data {
        let data = try encoder.encode(body)
        let request = try makeRequest(method, path, query: query, body: data)
        return try await performRaw(request)
    }

    /// Multipart upload. Built here rather than at call sites so the CSRF header
    /// and the refresh-and-replay behaviour can't be forgotten on the one code
    /// path that carries user files.
    func upload<Response: Decodable>(
        _ path: String,
        parts: [MultipartPart],
        fields: [String: String] = [:],
        as type: Response.Type = Response.self
    ) async throws -> Response {
        let boundary = "rxhive.\(UUID().uuidString)"
        var request = try makeRequest(.post, path, query: [:], body: nil)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = AppConfig.uploadTimeout
        request.httpBody = MultipartBuilder.body(boundary: boundary, parts: parts, fields: fields)
        return try await perform(request, as: type)
    }

    /// Raw bytes for an authenticated media GET (attachments are served by the
    /// API, not by public object-storage URLs, so they need the session cookie).
    func data(forPath path: String) async throws -> Data {
        let request = try makeRequest(.get, path, query: [:], body: nil)
        return try await performRaw(request)
    }

    /// Absolute-URL variant, for a presigned storage URL the API handed us.
    func data(fromAbsoluteURL url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = HTTPMethod.get.rawValue
        request.setValue(AppConfig.csrfHeader.value, forHTTPHeaderField: AppConfig.csrfHeader.name)
        return try await performRaw(request)
    }

    // MARK: - Request construction

    private func makeRequest(
        _ method: HTTPMethod,
        _ path: String,
        query: [String: String?],
        body: Data?
    ) throws -> URLRequest {
        guard var components = URLComponents(
            url: AppConfig.apiBaseURL.appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.transport(underlying: "Could not build a URL for \(path)")
        }

        let items = query.compactMap { key, value -> URLQueryItem? in
            guard let value, !value.isEmpty else { return nil }
            return URLQueryItem(name: key, value: value)
        }
        if !items.isEmpty { components.queryItems = items.sorted { $0.name < $1.name } }

        guard let url = components.url else {
            throw APIError.transport(underlying: "Could not build a URL for \(path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(AppConfig.csrfHeader.value, forHTTPHeaderField: AppConfig.csrfHeader.name)
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    // MARK: - Execution

    private func perform<Response: Decodable>(
        _ request: URLRequest,
        as type: Response.Type
    ) async throws -> Response {
        let data = try await performRaw(request)
        // 204, or a body-less 200: only legal if the caller asked for EmptyResponse.
        if data.isEmpty, let empty = EmptyResponse() as? Response { return empty }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            log.error("Decode failed for \(request.url?.path ?? "?"): \(String(describing: error))")
            throw APIError.decoding(underlying: String(describing: error))
        }
    }

    private func performRaw(_ request: URLRequest, isRetry: Bool = false) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.transport(underlying: error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(underlying: "Non-HTTP response")
        }

        if (200..<300).contains(http.statusCode) { return data }

        // 401 on a non-auth path: refresh once, then replay once.
        //
        // Auth paths are excluded because /login and /refresh answer 401 to mean
        // "these credentials are wrong" — refreshing in response to that would
        // loop. This mirrors the web client's `isAuthPath` guard in api/client.js.
        if http.statusCode == 401, !isRetry, !Self.isAuthPath(request.url) {
            let refreshed = await refreshCoordinator.refresh { [weak self] in
                guard let self else { return false }
                return await self.performRefresh()
            }
            if refreshed {
                return try await performRaw(request, isRetry: true)
            }
            await Self.announceSessionExpired()
            throw APIError.unauthorized
        }

        throw Self.error(status: http.statusCode, data: data, headers: http, decoder: decoder)
    }

    /// The bare refresh call. Deliberately does not go through `performRaw`, so a
    /// 401 here cannot recurse back into the refresh path.
    private func performRefresh() async -> Bool {
        guard var request = try? makeRequest(.post, "/api/auth/refresh", query: [:], body: nil) else {
            return false
        }
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200 { return true }
            // 403 here is the mobile grant being revoked mid-session, which the
            // backend enforces on refresh. Same outcome as 401: back to sign-in.
            log.notice("Refresh rejected with \(status); session is over")
            return false
        } catch {
            // Offline. Not a session problem — do not sign the user out for it.
            log.notice("Refresh could not reach the server: \(error.localizedDescription)")
            return false
        }
    }

    private static func isAuthPath(_ url: URL?) -> Bool {
        guard let path = url?.path else { return false }
        return path.hasPrefix("/api/auth/")
    }

    @MainActor
    private static func announceSessionExpired() {
        NotificationCenter.default.post(name: sessionExpiredNotification, object: nil)
    }

    private static func error(
        status: Int,
        data: Data,
        headers: HTTPURLResponse,
        decoder: JSONDecoder
    ) -> APIError {
        let detail = (try? decoder.decode(APIErrorBody.self, from: data))?.detail ?? ""
        switch status {
        case 401: return .unauthorized
        case 403: return .forbidden(detail: detail)
        case 404: return .notFound
        case 400, 409, 422: return .validation(detail: detail)
        case 429:
            let retryAfter = (headers.value(forHTTPHeaderField: "Retry-After")).flatMap(TimeInterval.init)
            return .rateLimited(retryAfter: retryAfter)
        default:
            return .server(status: status, detail: detail.isEmpty ? nil : detail)
        }
    }

    // MARK: - Cookie lifecycle

    /// Drop every RX HIVE cookie. Called after logout so the next sign-in starts
    /// clean, and after a hard session failure so a stale `rx_refresh` can't be
    /// replayed. Scoped to the API host — this app shares the process cookie jar.
    func clearSessionCookies() {
        guard let storage = session.configuration.httpCookieStorage else { return }
        let host = AppConfig.apiBaseURL.host
        for cookie in storage.cookies ?? [] where cookie.domain.contains(host ?? "\u{0}") {
            storage.deleteCookie(cookie)
        }
    }

    /// True when a persisted refresh cookie exists — i.e. it is worth trying
    /// `/api/auth/me` on launch instead of going straight to sign-in.
    func hasPersistedSession() -> Bool {
        guard let storage = session.configuration.httpCookieStorage,
              let cookies = storage.cookies(for: AppConfig.apiBaseURL) else { return false }
        return cookies.contains { $0.name == "rx_refresh" || $0.name == "rx_access" }
    }
}

// MARK: - Supporting types

enum HTTPMethod: String {
    case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
}

/// For endpoints that answer `{"message": "..."}` or nothing we care about.
struct EmptyResponse: Codable { init() {} }

/// Serialises refresh attempts so N concurrent 401s cause exactly one refresh.
///
/// The backend rotates refresh tokens single-use, so parallel refreshes are not
/// merely wasteful — the losers present a consumed token, get 401, and sign the
/// user out of a session that was fine.
private actor RefreshCoordinator {
    private var inFlight: Task<Bool, Never>?

    func refresh(_ operation: @escaping () async -> Bool) async -> Bool {
        if let inFlight { return await inFlight.value }
        let task = Task { await operation() }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }
}

/// One part of a multipart upload.
struct MultipartPart {
    let name: String
    let filename: String
    let mimeType: String
    let data: Data
}

private enum MultipartBuilder {
    static func body(boundary: String, parts: [MultipartPart], fields: [String: String]) -> Data {
        var body = Data()
        let crlf = "\r\n"

        for (key, value) in fields {
            body.append("--\(boundary)\(crlf)")
            body.append("Content-Disposition: form-data; name=\"\(key)\"\(crlf)\(crlf)")
            body.append("\(value)\(crlf)")
        }
        for part in parts {
            body.append("--\(boundary)\(crlf)")
            body.append(
                "Content-Disposition: form-data; name=\"\(part.name)\"; filename=\"\(part.filename)\"\(crlf)"
            )
            body.append("Content-Type: \(part.mimeType)\(crlf)\(crlf)")
            body.append(part.data)
            body.append(crlf)
        }
        body.append("--\(boundary)--\(crlf)")
        return body
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(Data(string.utf8))
    }
}
