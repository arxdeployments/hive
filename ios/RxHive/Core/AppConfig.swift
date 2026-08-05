import Foundation

/// Where this build points, and the handful of protocol constants the API demands.
enum AppConfig {

    /// API origin.
    ///
    /// Read from `RXHIVE_API_URL` in Info.plist so the value is set per build
    /// configuration rather than compiled into source — a TestFlight build must
    /// not be one edited constant away from talking to a laptop. If the key is
    /// missing the app fails loudly at launch instead of silently defaulting to
    /// localhost and looking like a network outage on a tester's phone.
    static let apiBaseURL: URL = {
        guard
            let raw = Bundle.main.object(forInfoDictionaryKey: "RXHIVE_API_URL") as? String,
            let url = URL(string: raw.trimmingCharacters(in: .whitespaces)),
            url.scheme != nil, url.host != nil
        else {
            fatalError(
                """
                RXHIVE_API_URL is missing or malformed in Info.plist.
                Set it per configuration, e.g. Debug -> http://localhost:8000,
                Release -> your production API origin.
                """
            )
        }
        #if !DEBUG
        // The guard above only rejects a URL that is missing or malformed, and
        // the placeholder this repo ships in the Release configuration —
        // https://rxhive.example.com, marked "CHANGE ME before shipping" — is
        // neither. It parses, so the app launches, and then every single request
        // fails against a domain that does not exist. Nothing before this point
        // could tell the difference between "not configured" and "offline".
        //
        // Refusing to launch mirrors what the backend already does with its own
        // placeholders (Settings._reject_placeholder_secrets_in_prod), and what
        // this very property already does for a malformed URL. A crash at launch
        // is caught by whoever builds the archive; a silently dead network layer
        // is caught by a tester, or by a user.
        if isPlaceholderHost(url) {
            fatalError(
                """
                RXHIVE_API_URL is still the shipped placeholder (\(url.host ?? "?")).
                Set the production API origin on the Release configuration before archiving.
                """
            )
        }
        #endif
        return url
    }()

    /// True for the example.com hosts this repo ships as placeholders.
    ///
    /// Separate and non-private so it can be tested without building for release;
    /// the call site above is the only thing gated on configuration.
    static func isPlaceholderHost(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == "example.com" || host.hasSuffix(".example.com")
    }

    /// WebSocket origin, derived from `apiBaseURL` so the two can never disagree.
    /// http -> ws, https -> wss.
    static let webSocketBaseURL: URL = {
        var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false)!
        components.scheme = (apiBaseURL.scheme == "https") ? "wss" : "ws"
        return components.url!
    }()

    /// The CSRF header the API requires on every cookie-authenticated mutation.
    ///
    /// `main.py` rejects any mutating `/api` request that has cookies but no
    /// `X-Requested-With: XMLHttpRequest` with 403 "Missing CSRF header". A native
    /// client is not a browser and is not at risk from cross-site forms, but the
    /// server does not know that, so we send it on every request.
    static let csrfHeader = (name: "X-Requested-With", value: "XMLHttpRequest")

    /// Sent on login so the backend can apply the mobile-access gate. The server
    /// treats a missing value as "web", so this must be present on every login.
    static let clientKind = "mobile"

    /// Access-token lifetime is server-controlled (`RXHIVE_ACCESS_TOKEN_MINUTES`,
    /// 15 by default). We never read the token — it is httpOnly — so the client
    /// discovers expiry by receiving a 401 and refreshing. Nothing here to tune.
    static let requestTimeout: TimeInterval = 30
    /// Uploads get a longer budget than JSON calls; a voice note on a bad cell
    /// connection legitimately takes a while.
    static let uploadTimeout: TimeInterval = 120
}
