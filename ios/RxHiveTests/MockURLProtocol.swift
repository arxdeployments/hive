import Foundation

/// A scripted `URLProtocol` so `APIClient` can be driven without a network.
///
/// Installed on the `URLSession` handed to `APIClient(session:)`. Every request is
/// recorded — path, method and the order it arrived in — because most of what these
/// tests assert is not the value that came back but *how many times* the client
/// went to the wire. In particular: exactly one POST to `/api/auth/refresh`.
///
/// The counters are behind an `NSLock` deliberately. `startLoading()` is called on
/// URLSession's own delegate threads, several at once when the test fires parallel
/// requests, so an unsynchronised array here would both lose requests and trip the
/// exclusivity checker.
final class MockURLProtocol: URLProtocol {

    // MARK: - Scripting

    /// One scripted answer.
    struct Reply {
        var status: Int = 200
        var body: Data = Data()
        var headers: [String: String] = ["Content-Type": "application/json"]
        /// When set, the request fails with this error instead of answering at all —
        /// how "offline" is expressed to the client.
        var failure: Error?
        /// Held for this long before answering. Used to keep a refresh in flight long
        /// enough for concurrent 401s to arrive and join the same single-flight.
        var delay: TimeInterval = 0

        static func json(
            _ status: Int,
            _ text: String,
            headers: [String: String] = [:],
            delay: TimeInterval = 0
        ) -> Reply {
            var merged = ["Content-Type": "application/json"]
            for (key, value) in headers { merged[key] = value }
            return Reply(status: status, body: Data(text.utf8), headers: merged, delay: delay)
        }

        static func failing(_ error: Error, delay: TimeInterval = 0) -> Reply {
            Reply(failure: error, delay: delay)
        }
    }

    /// `(request, nth request to this same path) -> Reply`. The ordinal is what lets a
    /// script answer 401 first and 200 on the replay.
    typealias Handler = (URLRequest, Int) -> Reply

    /// One request as it reached the wire.
    struct Record {
        let method: String
        let url: URL
        var path: String { url.path }
    }

    private static let lock = NSLock()
    private static var installedHandler: Handler?
    private static var records: [Record] = []

    private static let deliveryQueue = DispatchQueue(
        label: "ai.rhythmrx.rxhive.tests.MockURLProtocol",
        attributes: .concurrent
    )

    /// Install the script for one test. Replaces any previous one.
    static func install(_ handler: @escaping Handler) {
        lock.lock()
        installedHandler = handler
        lock.unlock()
    }

    /// Forget the script and every recorded request.
    static func reset() {
        lock.lock()
        installedHandler = nil
        records = []
        lock.unlock()
    }

    /// Every request seen, in arrival order.
    static var requests: [Record] {
        lock.lock()
        defer { lock.unlock() }
        return records
    }

    /// How many requests hit `path`, optionally restricted to one HTTP method.
    static func count(path: String, method: String? = nil) -> Int {
        requests.filter { record in
            record.path == path && (method == nil || record.method == method)
        }.count
    }

    /// Records the request and hands back the script plus this request's ordinal for
    /// its path. One critical section so the count can never be read torn.
    private static func consume(_ request: URLRequest) -> (Handler?, Int) {
        let url = request.url ?? URL(string: "about:blank")!
        lock.lock()
        defer { lock.unlock() }
        records.append(Record(method: request.httpMethod ?? "GET", url: url))
        let ordinal = records.filter { $0.path == url.path }.count
        return (installedHandler, ordinal)
    }

    // MARK: - URLProtocol

    private let stopped = NSLock()
    private var isStopped = false

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (handler, ordinal) = Self.consume(request)

        guard let handler else {
            client?.urlProtocol(self, didFailWithError: NSError(
                domain: "MockURLProtocol",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey:
                    "No script installed for \(request.url?.absoluteString ?? "?")"]
            ))
            return
        }

        let reply = handler(request, ordinal)
        if reply.delay > 0 {
            Self.deliveryQueue.asyncAfter(deadline: .now() + reply.delay) { [weak self] in
                self?.deliver(reply)
            }
        } else {
            deliver(reply)
        }
    }

    override func stopLoading() {
        stopped.lock()
        isStopped = true
        stopped.unlock()
    }

    private func deliver(_ reply: Reply) {
        stopped.lock()
        let cancelled = isStopped
        stopped.unlock()
        guard !cancelled else { return }

        if let failure = reply.failure {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }

        guard
            let url = request.url,
            let response = HTTPURLResponse(
                url: url,
                statusCode: reply.status,
                httpVersion: "HTTP/1.1",
                headerFields: reply.headers
            )
        else {
            client?.urlProtocol(self, didFailWithError: NSError(
                domain: "MockURLProtocol",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "Could not build a response"]
            ))
            return
        }

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !reply.body.isEmpty { client?.urlProtocol(self, didLoad: reply.body) }
        client?.urlProtocolDidFinishLoading(self)
    }
}
