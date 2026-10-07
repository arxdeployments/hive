import SwiftUI

/// The app entry point. Owns the four app-wide stores, injects them into
/// `RootView`, and forwards scene-phase changes to the stores that react to them.
@main
struct RxHiveApp: App {
    @StateObject private var auth = AuthStore()
    @StateObject private var chat = ChatStore()
    @StateObject private var calls = CallStore()
    @StateObject private var toasts = ToastCenter()

    @Environment(\.scenePhase) private var scenePhase

    /// One window holding `RootView`. Wires the stores together and restores the
    /// session on first appearance; on foreground it revalidates auth and, for a
    /// running session only, reconciles call state with the server.
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
            // Read receipts need the app in the foreground, not just the thread on the
            // navigation stack (`ChatStore.isThreadOnScreen`).
            chat.scenePhaseChanged(isActive: phase == .active)
            switch phase {
            case .background:
                auth.applicationDidEnterBackground()
            case .active:
                auth.applicationWillEnterForeground()
                // Returning to the foreground is the other moment call state can be
                // stale: while backgrounded (with no call live) the socket is down, so
                // any `call:*` frame published in that window went to a channel with no
                // subscriber and is gone. Asking the server is the only way to find out
                // that a call is ringing right now.
                //
                // Only for a running session. `currentUser` is nil while the account
                // is held at the change-password screen (batch 73), where every call
                // route answers 403 and nothing session-scoped may start. A cold
                // launch, where it is nil too, loses nothing: the socket's `connected`
                // frame runs this same reconcile once the session is up
                // (`CallStore.attach`, `onReconnected`).
                if auth.currentUser != nil {
                    Task { await calls.reconcileWithServer() }
                }
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

    /// The screen for `auth.phase`, with the call overlays and toasts layered above
    /// whichever it is. A held account gets `ForcedPasswordChangeView` in place of
    /// `HomeView` (batch 73).
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

            case .accessDenied(let reason, let denial):
                AccessDeniedView(reason: reason, denial: denial) {
                    auth.dismissAccessDenied()
                }
                .transition(.opacity)

            case .passwordChangeRequired(let user):
                // Instead of the app, not over it: `HomeView` and everything it
                // starts must not exist while the server refuses all of it.
                ForcedPasswordChangeView(email: user.email)
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
