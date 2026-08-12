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
/// A 401 from our own API means the 15-minute access cookie lapsed. One refresh
/// runs at a time (`RefreshCoordinator`) and every caller that raced into a 401
/// awaits that same refresh and then replays once. Without the single-flight, a
/// screen that fires five parallel requests on appear would trigger five
/// refreshes — and since the backend *rotates* refresh tokens single-use, four of
/// them would present an already-consumed token and force a spurious sign-out.
///
/// ## Reached-and-refused vs never-asked
///
/// The refresh result is deliberately three-valued, because collapsing it to a
/// Bool is what made this client sign people out for no reason. "Refresh failed"
/// conflates *the server rejected my token* with *I could not reach the server* —
/// offline, DNS, timeout, a proxy 502 mid-deploy, a 429 from a rate limiter keyed
/// on a shared clinic IP, a 500 because Redis blinked. Only the first proves the
/// session is over. For the rest the 30-day refresh token is still perfectly
/// good, so the request fails as `.transport` (retryable) and nothing is
/// discarded. Deleting a valid credential because the network hiccuped costs the
/// user their password, and it is not recoverable once the cookie is gone.
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
    ///
    /// `userInfo[detailKey]` carries the server's own sentence when it sent one, so
    /// a revoked mobile grant can reach the screen written to explain it instead of
    /// being flattened into "your session expired". `userInfo[denialKey]` carries the
    /// backend's denial code for that case — the sentence is what gets shown, the
    /// code is what decides which of the two denial screens shows it.
    static let sessionExpiredNotification = Notification.Name("RxHiveSessionExpired")
    static let detailKey = "detail"
    static let statusKey = "status"
    static let denialKey = "denial"

    /// Bumped on every successful refresh. A request that was already on the wire
    /// when someone else refreshed comes back 401 through no fault of the session;
    /// comparing the generation it was sent under against the current one tells us
    /// to simply replay rather than burn a second rotation.
    private var refreshGeneration = 0

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
            // `encode` is mutating on SingleValueEncodingContainer, so the container
            // has to be bound to a var — it cannot be called on the returned value.
            var container = encoder.singleValueContainer()
            try container.encode(RxDate.format(date))
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
        // Read before the request leaves, so a refresh that lands while we are in
        // flight is detectable when we come back holding a 401.
        let sentUnderGeneration = refreshGeneration

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

        if http.statusCode == 401, !isRetry, Self.isOurAPI(request.url), !Self.skipsRefresh(request.url) {
            // Somebody else already rotated while this request was on the wire: the
            // cookie it carried was merely stale, so replay instead of refreshing
            // again. Rotating a second time here would be wasted and, on a busy
            // screen, would churn the server's refresh table for nothing.
            if refreshGeneration != sentUnderGeneration {
                return try await performRaw(request, isRetry: true)
            }

            let outcome = await refreshCoordinator.refresh { [weak self] in
                guard let self else { return .unreachable(reason: "Client released") }
                return await self.performRefresh()
            }

            switch outcome {
            case .refreshed:
                return try await performRaw(request, isRetry: true)

            case .rejected(let status, let detail, let denial):
                // The server was reached and said no. This is the only branch that
                // may end the session.
                await Self.announceSessionEnded(status: status, detail: detail, denial: denial)
                throw status == 403
                    ? APIError.forbidden(detail: detail, denial: denial)
                    : APIError.unauthorized

            case .unreachable(let reason):
                // Nothing was established. Report it as what it is — a delivery
                // failure — so `isRetryable` holds and AuthStore leaves the session
                // (and the refresh cookie) exactly where they are.
                log.notice("Refresh undelivered (\(reason, privacy: .public)); session left intact")
                throw APIError.transport(underlying: reason)
            }
        }

        // 401 on an auth path, or on a replay: report what the server said rather
        // than asserting an expiry. `signIn` shows this verbatim.
        if http.statusCode == 401 {
            let detail = (try? decoder.decode(APIErrorBody.self, from: data))?.detail ?? ""
            if Self.skipsRefresh(request.url) { throw APIError.credentials(detail: detail) }
        }

        throw Self.error(status: http.statusCode, data: data, headers: http, decoder: decoder)
    }

    /// The bare refresh call. Deliberately does not go through `performRaw`, so a
    /// 401 here cannot recurse back into the refresh path.
    private func performRefresh() async -> RefreshOutcome {
        let presented = refreshCookieValue()
        var outcome = await postRefresh()

        // A 401 can also mean our cookie was rotated out from under us between
        // reading the jar and posting — another process sharing this app's cookie
        // store, or a rotation whose response we lost and have since re-received.
        // If the jar has moved on, the token we just presented was simply the old
        // one; try the new one once before declaring the session dead.
        if case .rejected(let status, _, _) = outcome, status == 401 {
            let current = refreshCookieValue()
            if let current, current != presented {
                log.notice("Refresh token rotated underneath us; retrying with the current one")
                outcome = await postRefresh()
            }
        }

        if case .refreshed = outcome { refreshGeneration &+= 1 }
        return outcome
    }

    private func postRefresh() async -> RefreshOutcome {
        guard var request = try? makeRequest(.post, "/api/auth/refresh", query: [:], body: nil) else {
            return .unreachable(reason: "Could not build the refresh request")
        }
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            let (body, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .unreachable(reason: "Non-HTTP response to refresh")
            }
            switch http.statusCode {
            case 200:
                return .refreshed

            case 401, 403:
                // Reached and refused: an unknown/consumed/expired token (401), or
                // the mobile grant withdrawn mid-session (403). The detail is the
                // backend's own prose and is carried through to the screen; the code
                // beside it is what decides *which* screen.
                let envelope = try? decoder.decode(APIErrorBody.self, from: body)
                log.notice("Refresh refused with \(http.statusCode); session is over")
                return .rejected(
                    status: http.statusCode,
                    detail: envelope?.detail ?? "",
                    denial: Self.denial(in: envelope)
                )

            case 429:
                // Shared-IP throttling. Dozens of phones off one clinic NAT all
                // foreground at shift change and each needs a refresh; treating the
                // bucket being full as proof of expiry would sign the whole ward out.
                let retryAfter = http.value(forHTTPHeaderField: "Retry-After") ?? "unspecified"
                return .unreachable(reason: "Refresh throttled (retry after \(retryAfter))")

            default:
                // 5xx, or anything else. A proxy 502 during a deploy and a 500 from
                // a Redis blip both land here, and neither says anything about the
                // token we hold.
                return .unreachable(reason: "Refresh answered \(http.statusCode)")
            }
        } catch let error as URLError {
            return .unreachable(reason: error.localizedDescription)
        } catch {
            return .unreachable(reason: error.localizedDescription)
        }
    }

    private func refreshCookieValue() -> String? {
        session.configuration.httpCookieStorage?
            .cookies(for: AppConfig.apiBaseURL)?
            .first { $0.name == Self.refreshCookieName }?
            .value
    }

    /// Endpoints whose 401 means "the credentials in this request are wrong", not
    /// "the access cookie lapsed" — refreshing in response to one of these would be
    /// pointless at best and a loop at worst.
    ///
    /// Note what is *not* here: `/api/auth/me`. It was previously excluded along
    /// with the rest of `/api/auth/`, which meant the one call every cold launch
    /// and every foreground revalidation makes could never trigger a refresh. A
    /// user returning after the 15-minute access cookie lapsed was sent to sign-in
    /// while holding a refresh token good for another 30 days.
    private static let nonRefreshablePaths: Set<String> = [
        "/api/auth/login",
        "/api/auth/refresh",
        "/api/auth/change-password",
    ]

    private static func skipsRefresh(_ url: URL?) -> Bool {
        guard let path = url?.path else { return false }
        // Tolerate a trailing slash so routing cosmetics cannot change the
        // classification of an auth endpoint.
        let normalised = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
        return nonRefreshablePaths.contains(normalised)
    }

    /// True only for our own API origin. `data(fromAbsoluteURL:)` fetches presigned
    /// storage URLs, and a 401 from object storage or a CDN must not be able to
    /// drive a session refresh — let alone sign the user out of the app.
    private static func isOurAPI(_ url: URL?) -> Bool {
        guard let url, let base = URLComponents(url: AppConfig.apiBaseURL, resolvingAgainstBaseURL: false),
              let target = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return false }
        return target.scheme == base.scheme
            && target.host?.lowercased() == base.host?.lowercased()
            && target.port == base.port
    }

    @MainActor
    private static func announceSessionEnded(status: Int, detail: String, denial: MobileDenialKind?) {
        var userInfo: [String: Any] = [statusKey: status, detailKey: detail]
        // Only present for a mobile denial, so a listener can route on the code
        // rather than re-deriving it from the sentence it is about to display.
        if let denial { userInfo[denialKey] = denial.rawValue }
        NotificationCenter.default.post(
            name: sessionExpiredNotification,
            object: nil,
            userInfo: userInfo
        )
    }

    private static func error(
        status: Int,
        data: Data,
        headers: HTTPURLResponse,
        decoder: JSONDecoder
    ) -> APIError {
        let body = try? decoder.decode(APIErrorBody.self, from: data)
        let detail = body?.detail ?? ""
        switch status {
        case 401: return .unauthorized
        case 403: return .forbidden(detail: detail, denial: Self.denial(in: body))
        case 404: return .notFound
        case 400, 409, 422: return .validation(detail: detail)
        case 429:
            let retryAfter = (headers.value(forHTTPHeaderField: "Retry-After")).flatMap(TimeInterval.init)
            return .rateLimited(retryAfter: retryAfter)
        default:
            return .server(status: status, detail: detail.isEmpty ? nil : detail)
        }
    }

    /// The mobile denial the server named, if it named one we know.
    ///
    /// An unrecognised code is deliberately nil rather than a guess: a denial this
    /// build has never heard of must not be routed to one of the two screens written
    /// for the two it has.
    private static func denial(in body: APIErrorBody?) -> MobileDenialKind? {
        body?.code.flatMap(MobileDenialKind.init(rawValue:))
    }

    // MARK: - Cookie lifecycle

    /// Drop every RX HIVE cookie. Called after logout so the next sign-in starts
    /// clean, and after a *proven* session failure so a stale `rx_refresh` can't be
    /// replayed. Never call this for a delivery failure: the cookie it deletes is
    /// the only credential the user has, and losing it costs them their password.
    ///
    /// `cookies(for:)` rather than filtering `cookies` by hand: it applies real
    /// cookie-domain matching, so a session shared from a parent domain (a
    /// deployment that sets `RXHIVE_COOKIE_DOMAIN=.rxhive.example.com` to share
    /// with the web app) is actually cleared. The previous substring test asked
    /// whether ".rxhive.example.com" contained "api.rxhive.example.com", which is
    /// false, so Sign Out silently left the session alive.
    func clearSessionCookies() {
        guard let storage = session.configuration.httpCookieStorage else { return }
        for cookie in storage.cookies(for: AppConfig.apiBaseURL) ?? [] {
            storage.deleteCookie(cookie)
        }
    }

    /// True when a persisted refresh cookie exists — i.e. it is worth trying
    /// `/api/auth/me` on launch instead of going straight to sign-in.
    func hasPersistedSession() -> Bool {
        guard let storage = session.configuration.httpCookieStorage,
              let cookies = storage.cookies(for: AppConfig.apiBaseURL) else { return false }
        return cookies.contains { $0.name == Self.refreshCookieName }
    }

    /// The refresh cookie alone is enough to restore a session; the access cookie
    /// carries a 15-minute Max-Age and is routinely absent, so its absence must not
    /// be read as "signed out".
    private static let refreshCookieName = "rx_refresh"
}

/// What a refresh attempt actually established.
///
/// Three cases, not a Bool, and the distinction is the whole point: `rejected` is
/// the server refusing a token we successfully delivered, `unreachable` is never
/// having got an answer. Only the former is evidence about the session.
enum RefreshOutcome {
    case refreshed
    /// `denial` is set only when the refusal was the mobile gate and the server said
    /// so by code, so the screen that explains it can be chosen without reading prose.
    case rejected(status: Int, detail: String, denial: MobileDenialKind?)
    case unreachable(reason: String)
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
    private var inFlight: Task<RefreshOutcome, Never>?

    func refresh(_ operation: @escaping () async -> RefreshOutcome) async -> RefreshOutcome {
        if let inFlight { return await inFlight.value }
        let task = Task { await operation() }
        inFlight = task
        // `defer` rather than clearing after the await: if this ever becomes a
        // throwing or cancellable task, an early exit would otherwise leave a
        // completed task cached here and wedge every future refresh on its result.
        defer { inFlight = nil }
        return await task.value
    }
}

/// One part of a multipart upload.
struct MultipartPart {
    let name: String
    let filename: String
    let mimeType: String
    let data: Data
}

// Not `private`: `MultipartBuilderTests` reaches this through `@testable import`.
// A malformed body has no UI symptom until an upload fails, so the wire format is
// asserted directly rather than inferred from a failing request.
enum MultipartBuilder {

    /// A filename arrives here straight from the document picker
    /// (`MessageComposer.stage`, `url.lastPathComponent`) and nothing between there
    /// and this line rewrites it, so it can carry a quote or a newline. Interpolated
    /// raw, a quote closes the quoted string early and a CRLF starts a header line of
    /// its own — either way the body stops being well-formed multipart, and a name as
    /// ordinary as `patient "smith" scan.pdf` fails to upload.
    ///
    /// Stripped rather than percent-escaped, to match what the backend already does
    /// with this very value on the way back out (`services/storage.py:414`). Escaping
    /// instead would round-trip the name back to the user as `%22`.
    private static func headerSafe(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\"", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
    }

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
                "Content-Disposition: form-data; name=\"\(part.name)\"; filename=\"\(headerSafe(part.filename))\"\(crlf)"
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
