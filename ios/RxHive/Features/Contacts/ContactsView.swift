import SwiftUI
import UIKit

// MARK: - Directory loading

/// The org directory, with the web modals' 300ms search debounce.
///
/// Shared by every screen that lists people (the Contacts tab, New chat, group
/// member picking, forwarding) because the search is *server-side*
/// (`GET /api/users/contacts?search=`) — filtering a locally cached list would
/// diverge from the web, which re-queries on every keystroke. Each screen owns its
/// own instance: two pickers open at once must not fight over one query string.
@MainActor
final class ContactDirectory: ObservableObject {

    /// Bound straight to a `SearchField`. Writing it schedules a debounced reload,
    /// so no call site has to remember to trigger one.
    @Published var query = "" {
        didSet {
            guard query != oldValue else { return }
            scheduleReload()
        }
    }

    @Published private(set) var contacts: [Contact] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    /// The same 300ms the web's `setTimeout(fetchContacts, 300)` uses.
    private let debounce: Duration = .milliseconds(300)
    private var reloadTask: Task<Void, Never>?
    private var hasLoaded = false

    /// First load. Idempotent so returning to the tab doesn't refetch, but a
    /// previous failure leaves `hasLoaded` false and does retry.
    func start() async {
        guard !hasLoaded, reloadTask == nil else { return }
        await load()
    }

    func refresh() async {
        reloadTask?.cancel()
        reloadTask = nil
        await load()
    }

    private func scheduleReload() {
        reloadTask?.cancel()
        reloadTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: self.debounce)
            guard !Task.isCancelled else { return }
            await self.load()
        }
    }

    private func load() async {
        let term = query.trimmed
        isLoading = true
        errorMessage = nil
        do {
            let fetched = try await RxHiveAPI.contacts(search: term)
            // Drop a slow response for a query the user has already moved on from —
            // otherwise a laggy first request overwrites the newest results.
            guard term == query.trimmed else { return }
            contacts = fetched
            hasLoaded = true
        } catch {
            guard !Task.isCancelled, term == query.trimmed else { return }
            errorMessage = (error as? APIError)?.userMessage ?? "Couldn't load contacts"
        }
        isLoading = false
    }

    /// A–Z sections over the current results, with everything that doesn't start
    /// with a letter collected under "#" at the end.
    var sections: [ContactSection] {
        let grouped = Dictionary(grouping: contacts) { Self.indexLetter(for: $0.displayName) }
        let letters = grouped.keys.sorted { a, b in
            if a == "#" { return false }
            if b == "#" { return true }
            return a < b
        }
        return letters.map { letter in
            let people = (grouped[letter] ?? []).sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
            return ContactSection(letter: letter, contacts: people)
        }
    }

    /// Folding strips diacritics so "Ångström" files under A rather than in its own
    /// one-person section.
    private static func indexLetter(for name: String) -> String {
        guard let first = name.trimmed.first else { return "#" }
        let folded = String(first)
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
            .uppercased()
        guard let letter = folded.first, letter.isLetter else { return "#" }
        return String(letter)
    }
}

/// One A–Z bucket of the directory.
struct ContactSection: Identifiable, Hashable {
    let letter: String
    let contacts: [Contact]

    var id: String { letter }
}

// MARK: - Shared rows

/// The directory row used by every people list in the app.
///
/// The tap target is a `Button` *beside* the trailing slot rather than around it:
/// nesting a button inside a button makes both fire (or neither), so the quick
/// action has to live outside the row's own button.
struct ContactRow<Trailing: View>: View {
    let contact: Contact
    var status: PresenceStatus = .offline
    /// nil hides the checkbox (single-select lists); a value draws one.
    var isSelected: Bool?
    let onTap: () -> Void
    @ViewBuilder var trailing: () -> Trailing

    private var subtitle: String {
        contact.departmentName.isEmpty ? contact.email : contact.departmentName
    }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onTap) {
                HStack(spacing: Theme.Layout.spacing3) {
                    if let isSelected {
                        ContactCheckbox(isOn: isSelected)
                    }

                    Avatar(
                        name: contact.displayName,
                        urlPath: contact.avatarURL,
                        size: Theme.Layout.avatarMedium,
                        presence: status
                    )

                    VStack(alignment: .leading, spacing: 2) {
                        Text(contact.displayName)
                            .font(Theme.Typography.font(size: 16, weight: .medium))
                            .foregroundStyle(Theme.Color.text)
                            .lineLimit(1)
                        Text(subtitle)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted)
                            .lineLimit(1)
                    }

                    Spacer(minLength: Theme.Layout.spacing2)
                }
                .padding(.leading, Theme.Layout.gutter)
                .padding(.vertical, Theme.Layout.spacing2)
                .frame(minHeight: 60)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleStyle())

            trailing()
                .padding(.trailing, Theme.Layout.spacing2)
        }
        // The web tints selected rows `bg-[#10B981]/10`.
        .background(isSelected == true ? Theme.Color.primaryTint : Color.clear)
        .animation(Theme.Motion.ease, value: isSelected)
    }
}

extension ContactRow where Trailing == EmptyView {
    init(
        contact: Contact,
        status: PresenceStatus = .offline,
        isSelected: Bool? = nil,
        onTap: @escaping () -> Void
    ) {
        self.init(
            contact: contact,
            status: status,
            isSelected: isSelected,
            onTap: onTap,
            trailing: { EmptyView() }
        )
    }
}

/// The square multi-select checkbox from the web pickers.
struct ContactCheckbox: View {
    let isOn: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 5)
            .fill(isOn ? Theme.Color.primary : Color.clear)
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .stroke(isOn ? Theme.Color.primary : Theme.Color.border2, lineWidth: 2)
            )
            .frame(width: 22, height: 22)
            .overlay {
                if isOn {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Theme.Color.onPrimary)
                }
            }
            .animation(Theme.Motion.ease, value: isOn)
    }
}

/// The A–Z scrubber down the trailing edge.
///
/// Its letters are far shorter than `minTouchTarget`, which is deliberate and is
/// the one place in this app that ignores it: this is a continuous scrubber driven
/// by a drag (exactly like UIKit's own `sectionIndexTitles` bar), not 26 discrete
/// buttons — you land on a letter by sliding, and the whole strip is one gesture
/// target. Only letters that actually have contacts are drawn, so there are no
/// dead stops.
struct ContactIndexBar: View {
    /// Published so the list underneath can inset itself by exactly this much.
    static let width: CGFloat = 24

    let letters: [String]
    let onSelect: (String) -> Void

    @State private var activeLetter: String?

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                ForEach(letters, id: \.self) { letter in
                    Text(letter)
                        .font(Theme.Typography.micro)
                        .foregroundStyle(
                            activeLetter == letter ? Theme.Color.primary : Theme.Color.textMuted
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        select(atY: value.location.y, height: geo.size.height)
                    }
                    .onEnded { _ in activeLetter = nil }
            )
        }
        .frame(width: Self.width)
        .padding(.vertical, Theme.Layout.spacing3)
        .accessibilityHidden(true)
    }

    private func select(atY y: CGFloat, height: CGFloat) {
        guard !letters.isEmpty, height > 0 else { return }
        let step = height / CGFloat(letters.count)
        let index = min(letters.count - 1, max(0, Int(y / step)))
        let letter = letters[index]
        guard letter != activeLetter else { return }
        activeLetter = letter
        // Feedback only on change, so a slow drag inside one letter stays silent.
        UISelectionFeedbackGenerator().selectionChanged()
        onSelect(letter)
    }
}

// MARK: - Screen

/// The Contacts tab: the org directory, sectioned A–Z.
///
/// Tapping anyone opens (or finds) the 1:1 conversation and pushes the thread —
/// `POST /api/conversations/direct` is idempotent server-side, so this is safe to
/// tap repeatedly and never creates a duplicate chat.
struct ContactsView: View {
    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter

    @StateObject private var directory = ContactDirectory()
    @State private var path: [String] = []
    /// Contact whose conversation is being opened. Doubles as the row's spinner and
    /// as the guard against a double tap opening two threads.
    @State private var opening: String?

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                Theme.Color.bg.ignoresSafeArea()

                VStack(spacing: 0) {
                    SearchField(placeholder: "Search contacts", text: $directory.query)
                        .padding(.horizontal, Theme.Layout.gutter)
                        .padding(.top, Theme.Layout.spacing2)
                        .padding(.bottom, Theme.Layout.spacing3)

                    content
                }
            }
            .navigationTitle("Contacts")
            .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationDestination(for: String.self) { conversationID in
                ChatView(conversationID: conversationID)
            }
            .task { await directory.start() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if directory.contacts.isEmpty, directory.isLoading {
            ContactListSkeleton()
        } else if directory.contacts.isEmpty, let message = directory.errorMessage {
            EmptyStateView(
                systemImage: "wifi.slash",
                title: "Couldn't load contacts",
                message: message,
                actionTitle: "Try again"
            ) {
                Task { await directory.refresh() }
            }
        } else if directory.contacts.isEmpty {
            EmptyStateView(
                systemImage: "person.2",
                title: directory.query.trimmed.isEmpty ? "No contacts yet" : "No matches",
                message: directory.query.trimmed.isEmpty
                    ? "Everyone in your organization will appear here."
                    : "No one in your organization matches “\(directory.query.trimmed)”."
            )
        } else {
            directoryList
        }
    }

    private var directoryList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    ForEach(directory.sections) { section in
                        Section {
                            ForEach(section.contacts) { contact in
                                row(for: contact)
                                if contact.id != section.contacts.last?.id {
                                    Hairline()
                                        .padding(.leading, rowSeparatorInset)
                                }
                            }
                        } header: {
                            header(for: section.letter)
                        }
                    }
                }
                // Clears the index bar overlaying the trailing edge, so a row's
                // quick action is never underneath it.
                .padding(.trailing, indexBarWidth)
                .padding(.bottom, Theme.Layout.spacing8)
            }
            .refreshable { await directory.refresh() }
            .scrollDismissesKeyboard(.immediately)
            .overlay(alignment: .trailing) {
                ContactIndexBar(letters: directory.sections.map(\.letter)) { letter in
                    withAnimation(Theme.Motion.ease) { proxy.scrollTo(letter, anchor: .top) }
                }
            }
        }
    }

    private var rowSeparatorInset: CGFloat {
        Theme.Layout.gutter + Theme.Layout.avatarMedium + Theme.Layout.spacing3
    }

    private var indexBarWidth: CGFloat { ContactIndexBar.width }

    private func header(for letter: String) -> some View {
        SectionHeader(title: letter)
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing2)
            // Opaque, or pinned headers show the rows sliding underneath them.
            .background(Theme.Color.bg)
            .id(letter)
    }

    private func row(for contact: Contact) -> some View {
        ContactRow(
            contact: contact,
            status: chat.status(of: contact.id, fallback: contact.status),
            isSelected: nil,
            onTap: { Task { await open(contact) } }
        ) {
            quickMessageButton(for: contact)
        }
    }

    /// The row's quick action.
    ///
    /// Message only, with no call button: placing a call is `CallStore`'s job and
    /// the web app likewise offers no call entry point in a people list — its
    /// `CallButtonDropdown` lives in the chat header, which is where this lands.
    private func quickMessageButton(for contact: Contact) -> some View {
        Button {
            Task { await open(contact) }
        } label: {
            Group {
                if opening == contact.id {
                    ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.8)
                } else {
                    Image(systemName: "bubble.left.and.text.bubble.right")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.Color.primary)
                }
            }
            .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
            .background(Circle().fill(Theme.Color.surface2))
            .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .disabled(opening != nil)
        .accessibilityLabel("Message \(contact.displayName)")
    }

    private func open(_ contact: Contact) async {
        guard opening == nil else { return }
        opening = contact.id
        do {
            let conversation = try await RxHiveAPI.directConversation(participantID: contact.id)
            // Seed the list so the thread has its metadata before the socket's
            // conversation_created frame (or a list refresh) arrives.
            chat.upsert(conversation)
            path.append(conversation.id)
        } catch {
            toasts.failure(error, fallback: "Couldn't open that chat")
        }
        opening = nil
    }
}

/// Loading placeholders shaped like the rows they replace.
private struct ContactListSkeleton: View {
    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<8, id: \.self) { index in
                HStack(spacing: Theme.Layout.spacing3) {
                    Circle()
                        .fill(Theme.Color.surface2)
                        .frame(width: Theme.Layout.avatarMedium, height: Theme.Layout.avatarMedium)
                    VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                        SkeletonRow(height: 14, widthFraction: index.isMultiple(of: 2) ? 0.45 : 0.6)
                        SkeletonRow(height: 10, widthFraction: 0.3)
                    }
                }
                .padding(.horizontal, Theme.Layout.gutter)
                .frame(height: 60)
            }
            Spacer()
        }
    }
}
