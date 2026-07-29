import SwiftUI
import UIKit

/// The signed-in shell.
///
/// The web app has no tab bar at all: it is a desktop three-pane layout
/// (`App.jsx` -> sidebar + thread + info panel) where "calls" is a segment inside
/// the sidebar and settings/admin are routes. None of that survives a 390pt
/// viewport, so **the tab bar is the mobile redesign** — the four things a phone
/// user switches between become peers, and each tab owns its own navigation stack
/// so switching away and back does not lose your place.
struct HomeView: View {
    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var calls: CallStore

    @State private var selection: HomeTab = .chats

    /// The badge on Chats is the same number the web sidebar spreads across rows —
    /// summed, because a tab bar has one place to put it.
    private var unreadTotal: Int {
        chat.conversations.reduce(0) { $0 + $1.unreadCount }
    }

    /// SwiftUI will not give a `TabView` an opaque custom fill on its own: without
    /// this the bar renders as a system material that samples the content behind it,
    /// which on #0A0A0A reads as a grey smear rather than the sidebar black.
    init() {
        let bar = UITabBarAppearance()
        bar.configureWithOpaqueBackground()
        bar.backgroundColor = UIColor(Theme.Color.sidebar)
        // The web sidebar's `border-r`; on a bottom bar the same hairline is a top
        // border. `shadowColor` is UIKit's name for it, not a drop shadow.
        bar.shadowColor = UIColor(Theme.Color.border)

        let item = UITabBarItemAppearance()
        item.normal.iconColor = UIColor(Theme.Color.textMuted)
        item.normal.titleTextAttributes = [.foregroundColor: UIColor(Theme.Color.textMuted)]
        item.selected.iconColor = UIColor(Theme.Color.primary)
        item.selected.titleTextAttributes = [.foregroundColor: UIColor(Theme.Color.primary)]
        // Badges are emerald with near-black text, not the system red-on-white:
        // an unread count is not an error.
        for state in [item.normal, item.selected] {
            state.badgeBackgroundColor = UIColor(Theme.Color.primary)
            state.badgeTextAttributes = [.foregroundColor: UIColor(Theme.Color.onPrimary)]
        }
        bar.stackedLayoutAppearance = item
        bar.inlineLayoutAppearance = item
        bar.compactInlineLayoutAppearance = item

        UITabBar.appearance().standardAppearance = bar
        UITabBar.appearance().scrollEdgeAppearance = bar
    }

    var body: some View {
        TabView(selection: $selection) {
            ConversationsListView()
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right.fill") }
                .badge(unreadTotal)
                .tag(HomeTab.chats)

            // The only tab wrapped here. `ConversationsListView`, `ContactsView` and
            // `SettingsView` each own a `NavigationStack` (the first two need a typed
            // path to push threads onto); `CallsListView` deliberately does not, and
            // sets a bare `.navigationTitle("Calls")` expecting the container to supply
            // one. Nothing did, so the Calls tab rendered with no navigation bar and no
            // title at all. Wrapping it here rather than inside it keeps the "one stack
            // per tab" rule and avoids nesting a second stack in the other three.
            NavigationStack {
                CallsListView()
                    .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
                    .toolbarBackground(.visible, for: .navigationBar)
            }
            .tabItem { Label("Calls", systemImage: "phone.fill") }
            // Read off `CallStore`, not a local copy. `CallsListView` calls
            // `calls.markCallsSeen()` when the tab opens, which zeroes this
            // immediately; a private `@State` mirror would keep showing the old
            // count until the next poll came round.
            .badge(calls.missedCallCount)
            .tag(HomeTab.calls)

            ContactsView()
                .tabItem { Label("Contacts", systemImage: "person.2.fill") }
                .tag(HomeTab.contacts)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(HomeTab.settings)
        }
        .tint(Theme.Color.primary)
        .background(Theme.Color.bg.ignoresSafeArea())
        .task {
            // Polled, not pushed. `GET /api/calls/missed-count` is the only source
            // for this number: remote push is not wired (Web Push/VAPID cannot carry
            // an APNs token), and the `call:missed` socket frame only arrives if the
            // app happened to be connected when the call came in. A minute is slow
            // enough to be free and fast enough that the badge is never stale for
            // long once the user is looking at the app.
            while !Task.isCancelled {
                await calls.loadMissedCount()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .onChange(of: selection) { _, _ in
            // Refreshed on *every* switch, not just onto Calls: leaving the tab is
            // when the count changes, because CallsListView marks the history seen
            // while it is open. Re-reading only on entry would leave a badge up for
            // calls the user has already looked at.
            //
            // `loadMissedCount` keeps the previous value if the request fails —
            // zeroing a badge because one request timed out would tell the user they
            // have no missed calls when they do.
            Task { await calls.loadMissedCount() }
        }
    }
}

private enum HomeTab: Hashable {
    case chats, calls, contacts, settings
}
