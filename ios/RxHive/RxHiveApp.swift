import SwiftUI

@main
struct RxHiveApp: App {
    @StateObject private var auth = AuthStore()
    @StateObject private var chat = ChatStore()
    @StateObject private var calls = CallStore()
    @StateObject private var toasts = ToastCenter()

    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(auth)
                .environmentObject(chat)
                .environmentObject(calls)
                .environmentObject(toasts)
                // The web app is dark-only: `index.css` has a single `:root` block
                // and `body` hard-codes #0A0A0A, with no light-mode override. Mirror
                // that rather than inventing a light theme the brand has never had.
                .preferredColorScheme(.dark)
                .tint(Theme.Color.primary)
                .task {
                    chat.attach(auth: auth)
                    calls.attach(auth: auth, chat: chat, toasts: toasts)
                    await auth.restoreSession()
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                auth.applicationDidEnterBackground()
            case .active:
                auth.applicationWillEnterForeground()
            default:
                break
            }
        }
    }
}

/// Chooses the screen for the current auth phase.
///
/// Deliberately a single switch with no navigation container around it: sign-in
/// and the app are different worlds, and pushing/popping between them leaves a
/// back button pointing at a screen the user is no longer entitled to.
struct RootView: View {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var calls: CallStore
    @EnvironmentObject private var toasts: ToastCenter

    var body: some View {
        ZStack {
            Theme.Color.bg.ignoresSafeArea()

            switch auth.phase {
            case .launching:
                SplashView()
                    .transition(.opacity)

            case .signedOut:
                SignInView()
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))

            case .accessDenied(let reason):
                AccessDeniedView(reason: reason) {
                    auth.dismissAccessDenied()
                }
                .transition(.opacity)

            case .signedIn:
                HomeView()
                    .transition(.opacity)
            }

            // Call UI lives above every screen, as it does on the web
            // (`App.jsx` mounts the call overlays outside the router) — a call must
            // survive navigating anywhere in the app.
            CallOverlayHost()

            ToastHost()
        }
        // `Phase` is Equatable by synthesis (CurrentUser is Hashable, String is
        // Equatable), which is what lets the root cross-fade be driven by value.
        .animation(Theme.Motion.easeSlow, value: auth.phase)
    }
}
