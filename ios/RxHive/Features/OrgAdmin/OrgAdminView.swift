import SwiftUI
import UIKit

/// The org-admin surface, condensed for a phone.
///
/// The web portal (`pages/OrgAdmin/*.jsx`) is four routes of wide tables built for a
/// mouse: create users, create/rename/delete departments, edit org settings. This is
/// deliberately the read-mostly subset plus the three things an admin actually needs
/// to do from a corridor — turn an account off, change someone's role, and hand out a
/// temporary password.
///
/// Provisioning stays on the web. Creating a user means choosing a department, typing
/// an email you must not mistype, and reading a generated password back to someone;
/// that is desk work, and doing it badly on a phone produces an account nobody can
/// sign into. Deleting a department is destructive and unrecoverable from here.
///
/// There are no super-admin screens, by design: a superadmin cannot sign in to this
/// app at all (`api/auth.py:_assert_mobile_allowed`), so the whole portal would be
/// dead code.
struct OrgAdminView: View {

    @EnvironmentObject private var auth: AuthStore
    @StateObject private var store = OrgAdminStore()

    @State private var tab: OrgAdminTab = .overview
    @State private var selectedUser: AdminUser?

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $tab) {
                ForEach(OrgAdminTab.allCases) { option in
                    Text(option.title).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing3)

            Hairline()

            switch tab {
            case .overview:
                overview
            case .people:
                people
            case .departments:
                departments
            }
        }
        .background(Theme.Color.bg)
        .navigationTitle("Organisation")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
        .sheet(item: $selectedUser) { user in
            OrgUserSheet(
                initial: user,
                store: store,
                // Editing your own row here is how an admin locks themselves out:
                // both "member" and "inactive" are one tap away and neither is
                // reversible without another admin or the web portal.
                isSelf: user.id == auth.currentUser?.id
            )
        }
        // Departments are loaded up front even on Overview: the People tab's filter
        // menu and the detail sheet's department picker both need them, and both are
        // one tap away.
        .task {
            await store.loadStats()
            await store.loadDepartments()
        }
    }

    // MARK: - Overview

    @ViewBuilder
    private var overview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Layout.spacing4) {
                if store.isLoadingStats && store.stats == nil {
                    ForEach(0..<3, id: \.self) { _ in
                        SurfaceCard { SkeletonRow(height: 18, widthFraction: 0.5) }
                    }
                } else if let tiles = store.statTiles, !tiles.isEmpty {
                    LazyVGrid(
                        columns: [GridItem(.flexible()), GridItem(.flexible())],
                        spacing: Theme.Layout.spacing3
                    ) {
                        ForEach(tiles) { tile in
                            StatTile(tile: tile)
                        }
                    }
                } else {
                    EmptyStateView(
                        systemImage: "chart.bar",
                        title: "No statistics",
                        message: store.statsError ?? "Your organisation's counters aren't available right now.",
                        actionTitle: "Try Again",
                        action: { Task { await store.loadStats() } }
                    )
                    .frame(minHeight: 240)
                }

                Text(OrgAdminStore.mobileAccessFootnote)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Theme.Layout.spacing2)
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing4)
        }
        .refreshable { await store.loadStats() }
    }

    // MARK: - People

    @ViewBuilder
    private var people: some View {
        VStack(spacing: 0) {
            VStack(spacing: Theme.Layout.spacing2) {
                SearchField(placeholder: "Search name or email", text: $store.search)

                HStack(spacing: Theme.Layout.spacing2) {
                    Menu {
                        Button {
                            store.deptFilter = nil
                        } label: {
                            MenuChoiceLabel(title: "All departments", isSelected: store.deptFilter == nil)
                        }
                        ForEach(store.departments) { dept in
                            Button {
                                store.deptFilter = dept.id
                            } label: {
                                MenuChoiceLabel(title: dept.name, isSelected: store.deptFilter == dept.id)
                            }
                        }
                    } label: {
                        HStack(spacing: Theme.Layout.spacing1) {
                            Image(systemName: "line.3.horizontal.decrease.circle")
                                .font(.system(size: 13))
                            Text(store.deptFilterName)
                                .font(Theme.Typography.pill)
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(store.deptFilter == nil ? Theme.Color.textMuted : Theme.Color.primary)
                        .padding(.horizontal, Theme.Layout.spacing3)
                        .frame(height: 34)
                        .background(
                            Capsule()
                                .fill(store.deptFilter == nil ? Theme.Color.surface2 : Theme.Color.primaryTint)
                                .overlay(
                                    Capsule().stroke(
                                        store.deptFilter == nil
                                            ? Theme.Color.border2
                                            : Theme.Color.primaryTintBorder,
                                        lineWidth: 1
                                    )
                                )
                        )
                    }

                    Spacer(minLength: 0)

                    if store.total > 0 {
                        Text("\(store.users.count) of \(store.total)")
                            .font(Theme.Typography.micro)
                            .monospacedDigit()
                            .foregroundStyle(Theme.Color.textMuted)
                    }
                }
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing3)

            Hairline()

            usersList
        }
        // One task keyed on both filters, not one per filter: two `.task(id:)`
        // modifiers each fire on first appearance, so the list would load twice on
        // every visit to this tab. The debounce is because `search` is written on
        // every keystroke — without it a five-letter name is five requests, and the
        // first to return last wins.
        .task(id: store.usersQueryKey) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await store.loadUsers(reset: true)
        }
    }

    @ViewBuilder
    private var usersList: some View {
        if store.isLoadingUsers && store.users.isEmpty {
            ScrollView {
                VStack(spacing: Theme.Layout.spacing4) {
                    ForEach(0..<6, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                            SkeletonRow(height: 15, widthFraction: 0.45)
                            SkeletonRow(height: 12, widthFraction: 0.65)
                        }
                    }
                }
                .padding(Theme.Layout.gutter)
            }
        } else if store.users.isEmpty {
            EmptyStateView(
                systemImage: "person.2.slash",
                title: "No people found",
                message: store.usersError ?? "Try a different name, email or department."
            )
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(store.users) { user in
                        Button {
                            selectedUser = user
                        } label: {
                            OrgUserRow(user: user)
                        }
                        .buttonStyle(PressScaleStyle())

                        Hairline()
                    }

                    if store.hasMoreUsers {
                        Button {
                            Task { await store.loadMoreUsers() }
                        } label: {
                            HStack(spacing: Theme.Layout.spacing2) {
                                if store.isLoadingUsers {
                                    ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
                                }
                                Text(store.isLoadingUsers ? "Loading…" : "Load More")
                                    .font(Theme.Typography.font(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.Color.primary)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: Theme.Layout.minTouchTarget)
                        }
                        .disabled(store.isLoadingUsers)
                        .padding(.vertical, Theme.Layout.spacing3)
                    }

                    Text(OrgAdminStore.mobileAccessFootnote)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(Theme.Layout.gutter)
                }
            }
            .refreshable { await store.loadUsers(reset: true) }
        }
    }

    // MARK: - Departments

    @ViewBuilder
    private var departments: some View {
        if store.isLoadingDepartments && store.departments.isEmpty {
            ScrollView {
                VStack(spacing: Theme.Layout.spacing4) {
                    ForEach(0..<5, id: \.self) { _ in SkeletonRow(height: 15, widthFraction: 0.5) }
                }
                .padding(Theme.Layout.gutter)
            }
        } else if store.departments.isEmpty {
            EmptyStateView(
                systemImage: "folder",
                title: "No departments",
                message: store.departmentsError
                    ?? "Departments are created in the RX HIVE web portal.",
                actionTitle: "Try Again",
                action: { Task { await store.loadDepartments() } }
            )
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(store.departments) { dept in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(dept.name)
                                .font(Theme.Typography.subheadline)
                                .foregroundStyle(Theme.Color.text)
                            Text(dept.description?.isEmpty == false ? dept.description! : "No description")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Color.textMuted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Theme.Layout.gutter)
                        .padding(.vertical, Theme.Layout.spacing3)
                        .frame(minHeight: Theme.Layout.minTouchTarget)

                        Hairline()
                    }

                    Text("Departments are read-only here. Create, rename and delete them in the "
                         + "RX HIVE web portal.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(Theme.Layout.gutter)
                }
            }
            .refreshable { await store.loadDepartments() }
        }
    }
}

// MARK: - Tabs

private enum OrgAdminTab: String, CaseIterable, Identifiable {
    case overview, people, departments

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "Overview"
        case .people: return "People"
        case .departments: return "Departments"
        }
    }
}

// MARK: - Store

/// Org-admin state: stats, the paged user list, and the department list.
///
/// Its own store rather than view state because the user list, its filters and its
/// paging cursor all have to survive the detail sheet being opened, a role being
/// changed, and the row being written back in place — a `@State` array would be
/// rebuilt by the sheet's dismissal and lose the pages already loaded.
@MainActor
final class OrgAdminStore: ObservableObject {

    @Published private(set) var stats: OrgStats?
    @Published private(set) var isLoadingStats = false
    @Published private(set) var statsError: String?

    @Published private(set) var users: [AdminUser] = []
    @Published private(set) var total = 0
    @Published private(set) var isLoadingUsers = false
    @Published private(set) var usersError: String?

    @Published private(set) var departments: [AdminDepartment] = []
    @Published private(set) var isLoadingDepartments = false
    @Published private(set) var departmentsError: String?

    /// Filters. Public setters — the search field and department menu bind straight
    /// to these, and the view re-runs the fetch when either changes.
    @Published var search = ""
    @Published var deptFilter: String?

    private var page = 1
    private let pageSize = 20

    var hasMoreUsers: Bool { users.count < total }

    var deptFilterName: String {
        guard let deptFilter else { return "All departments" }
        return departments.first { $0.id == deptFilter }?.name ?? "Department"
    }

    /// Identity of the current query, so the view can drive one fetch off both filters.
    var usersQueryKey: String { "\(search.trimmed)|\(deptFilter ?? "")" }

    /// Shown on both the overview and the people list.
    ///
    /// An org admin's most common mobile-support call is "the app won't let me in",
    /// and the answer is never something they can do from here: `OrgUpdateUser` has
    /// no `mobile_access` field, on purpose, and the only portal that does is the
    /// superadmin's — which is web-only. Saying so where they are looking beats them
    /// hunting for a switch that was never built.
    static let mobileAccessFootnote =
        "Mobile access is granted per account by an RX HIVE super admin, in the web "
        + "portal only. It's shown here for reference and can't be changed from the app "
        + "or from an org admin account."

    // MARK: Stats

    func loadStats() async {
        isLoadingStats = true
        statsError = nil
        defer { isLoadingStats = false }
        do {
            stats = try await RxHiveAPI.orgStats()
        } catch {
            statsError = (error as? APIError)?.userMessage ?? "Couldn't load statistics."
        }
    }

    /// One tile per counter the server actually sent.
    ///
    /// Every `OrgStats` field is optional and the keys have moved between builds —
    /// today's `/api/org-admin/stats` answers `total_users`, `active_today`,
    /// `total_departments` and `total_conversations`, so `active_users` and
    /// `online_users` arrive nil and their tiles simply do not appear. That is the
    /// intended behaviour: a counter the server does not report is a missing tile,
    /// never a zero (which reads as "nobody is online") and never a failed screen.
    var statTiles: [StatTileModel]? {
        guard let stats else { return nil }
        // A nil counter hides its tile rather than rendering a misleading 0.
        //
        // "Online Now" prefers `active_today`, which is what the current backend sends
        // and what it actually measures — `org_stats` counts the active users presence
        // reports as *online right now*, not a daily total, despite the key's name.
        // `online_users` / `active_users` / `total_messages` are older keys this build
        // still accepts but no deployed backend emits, so those tiles simply don't appear.
        let candidates: [(String, Int?, String)] = [
            ("Total Users", stats.totalUsers, "person.2"),
            ("Online Now", stats.onlineUsers ?? stats.activeToday, "dot.radiowaves.left.and.right"),
            ("Active Users", stats.activeUsers, "person.badge.clock"),
            ("Departments", stats.totalDepartments, "folder"),
            ("Conversations", stats.totalConversations, "bubble.left.and.bubble.right"),
            ("Messages", stats.totalMessages, "text.bubble"),
        ]
        return candidates.compactMap { label, value, icon in
            value.map { StatTileModel(label: label, value: $0, icon: icon) }
        }
    }

    // MARK: Users

    func loadUsers(reset: Bool) async {
        if reset { page = 1 }
        isLoadingUsers = true
        usersError = nil
        defer { isLoadingUsers = false }
        do {
            let response = try await RxHiveAPI.orgUsers(
                search: search.trimmed,
                deptID: deptFilter,
                page: page,
                limit: pageSize
            )
            total = response.total
            if reset {
                users = response.data
            } else {
                // Appending by id rather than blindly concatenating: the list is
                // ordered by `created_at desc`, so a user created between two page
                // requests shifts everything and duplicates a row.
                let known = Set(users.map(\.id))
                users.append(contentsOf: response.data.filter { !known.contains($0.id) })
            }
        } catch {
            usersError = (error as? APIError)?.userMessage ?? "Couldn't load people."
            if reset { users = [] }
        }
    }

    func loadMoreUsers() async {
        guard hasMoreUsers, !isLoadingUsers else { return }
        page += 1
        await loadUsers(reset: false)
    }

    /// Apply one change to one user and write the fresh row back into the list.
    ///
    /// Not optimistic. The server silently ignores a `role` it doesn't recognise and
    /// rejects a `dept_id` outside the org, so the response is the only reliable
    /// account of what actually changed — flipping the row first would show a change
    /// that never happened.
    func update(
        userID: String,
        displayName: String? = nil,
        deptID: String? = nil,
        role: String? = nil,
        isActive: Bool? = nil
    ) async throws -> AdminUser {
        let updated = try await RxHiveAPI.orgUpdateUser(
            userID: userID,
            displayName: displayName,
            deptID: deptID,
            role: role,
            isActive: isActive
        )
        if let index = users.firstIndex(where: { $0.id == userID }) {
            users[index] = updated
        }
        return updated
    }

    func resetPassword(userID: String) async throws -> String {
        try await RxHiveAPI.orgResetPassword(userID: userID)
    }

    // MARK: Departments

    func loadDepartments() async {
        isLoadingDepartments = true
        departmentsError = nil
        defer { isLoadingDepartments = false }
        do {
            // `RxHiveAPI.orgDepartments()` now returns the bare array this endpoint
            // actually sends (`org_admin.py:list_departments`); it used to declare the
            // `{data,total,page,limit}` envelope and throw `.decoding` every time, which
            // is why a second `APIClient.shared` request used to sit under this one.
            departments = try await RxHiveAPI.orgDepartments()
        } catch {
            departmentsError = (error as? APIError)?.userMessage ?? "Couldn't load departments."
        }
    }
}

/// One overview counter.
struct StatTileModel: Identifiable {
    let label: String
    let value: Int
    let icon: String

    var id: String { label }
}

// MARK: - Rows

private struct StatTile: View {
    let tile: StatTileModel

    var body: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                HStack(spacing: Theme.Layout.spacing2) {
                    Image(systemName: tile.icon)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Color.primary)
                    Text(tile.label)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                        .lineLimit(1)
                }
                Text("\(tile.value)")
                    .font(Theme.Typography.font(size: 26, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.Color.text)
            }
        }
    }
}

private struct OrgUserRow: View {
    let user: AdminUser

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Avatar(name: user.displayName, urlPath: user.avatarURL, size: Theme.Layout.avatarMedium)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Theme.Layout.spacing2) {
                    Text(user.displayName)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.text)
                        .lineLimit(1)
                    if user.role == .admin {
                        Pill(text: "Admin")
                    }
                }

                Text(user.email)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .lineLimit(1)

                HStack(spacing: Theme.Layout.spacing2) {
                    Text(user.deptName?.isEmpty == false ? user.deptName! : "No department")
                        .font(Theme.Typography.micro)
                        .foregroundStyle(Theme.Color.textMuted)
                    Text("·")
                        .font(Theme.Typography.micro)
                        .foregroundStyle(Theme.Color.textMuted)
                    Text(user.isActive ? "Active" : "Inactive")
                        .font(Theme.Typography.micro)
                        .foregroundStyle(user.isActive ? Theme.Color.primary : Theme.Color.danger)
                    MobileAccessPill(mobileAccess: user.mobileAccess)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Color.textMuted)
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
        .contentShape(Rectangle())
    }
}

/// Read-only, always. Neutral rather than red when web-only: "Web only" is a normal
/// state for most of an organisation, not a fault.
private struct MobileAccessPill: View {
    let mobileAccess: Bool?

    var body: some View {
        if let mobileAccess {
            Pill(
                text: mobileAccess ? "Mobile: Approved" : "Mobile: Web only",
                color: mobileAccess ? Theme.Color.primary : Theme.Color.textMuted
            )
        }
    }
}

// MARK: - User detail

/// The one place this app writes to another account.
private struct OrgUserSheet: View {

    @ObservedObject var store: OrgAdminStore
    let isSelf: Bool

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var toasts: ToastCenter

    /// The row being edited. Seeded from the list and replaced by whatever each write
    /// returns, so the sheet shows the server's account of the change rather than the
    /// stale row it opened with.
    @State private var user: AdminUser
    @State private var busy: Field?
    @State private var temporaryPassword: String?
    @State private var confirmingReset = false

    /// Which control is mid-request, so only that row shows a spinner.
    private enum Field { case active, role, department, password }

    init(initial: AdminUser, store: OrgAdminStore, isSelf: Bool) {
        self.store = store
        self.isSelf = isSelf
        _user = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Layout.spacing5) {
                    header

                    if isSelf {
                        Callout(
                            icon: "exclamationmark.triangle",
                            tint: Theme.Color.warning,
                            text: "This is your own account. Role, status and department can't be "
                                + "changed here — demoting or deactivating yourself would lock you "
                                + "out of the admin tools with no way back in from this app."
                        )
                    }

                    statusBlock
                    roleBlock
                    departmentBlock
                    passwordBlock
                    mobileAccessBlock
                }
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.vertical, Theme.Layout.spacing4)
            }
            .background(Theme.Color.bg)
            .navigationTitle(user.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Color.primary)
                }
            }
        }
        .confirmationDialog(
            "Reset this password?",
            isPresented: $confirmingReset,
            titleVisibility: .visible
        ) {
            Button("Reset Password", role: .destructive) { resetPassword() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(user.displayName) will be signed out everywhere and must use the temporary "
                 + "password you're about to be shown.")
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: Theme.Layout.spacing3) {
            Avatar(name: user.displayName, urlPath: user.avatarURL, size: Theme.Layout.avatarLarge)
            VStack(spacing: 2) {
                Text(user.email)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.text)
                    .textSelection(.enabled)
                if let joined = user.createdAt {
                    Text("Joined \(joined.dateSeparatorLabel)")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Status

    private var statusBlock: some View {
        AdminBlock(title: "Status") {
            HStack(spacing: Theme.Layout.spacing3) {
                Toggle(isOn: activeBinding) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(user.isActive ? "Active" : "Inactive")
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(user.isActive ? Theme.Color.primary : Theme.Color.danger)
                        Text("Deactivating signs the account out everywhere and blocks sign-in.")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .tint(Theme.Color.primary)
                .disabled(isSelf || busy != nil)

                if busy == .active {
                    ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
                }
            }
            .padding(Theme.Layout.spacing4)
        }
    }

    private var activeBinding: Binding<Bool> {
        Binding(
            get: { user.isActive },
            set: { newValue in apply(.active) { try await store.update(userID: user.id, isActive: newValue) } }
        )
    }

    // MARK: Role

    private var roleBlock: some View {
        AdminBlock(title: "Role") {
            VStack(spacing: Theme.Layout.spacing3) {
                HStack(spacing: Theme.Layout.spacing2) {
                    // "member" and "admin" are the only assignable wire values; the
                    // server ignores anything else, and `superadmin` is not grantable
                    // from an org-admin account at all.
                    ForEach(["member", "admin"], id: \.self) { value in
                        // Promoting is refused by the server: an admin creates and
                        // promotes members only, because an admin with no
                        // admin_departments rows is organisation-wide, so minting one
                        // would hand out reach the actor may not have. Demoting an
                        // existing admin is still allowed, which is why this disables
                        // the button rather than dropping it — the current role still
                        // needs a selected state to demote FROM.
                        let blocked = value == "admin" && user.role != .admin
                        SegmentButton(
                            title: value.capitalized,
                            isSelected: user.role.rawValue == value,
                            isDisabled: isSelf || blocked || busy != nil
                        ) {
                            guard user.role.rawValue != value else { return }
                            apply(.role) { try await store.update(userID: user.id, role: value) }
                        }
                    }
                    if busy == .role {
                        ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
                    }
                }
                // Was "manage everyone in the organisation", which stopped being true
                // once a super admin could scope an admin to named departments.
                Text(user.role == .admin
                     ? "Admins can see this screen and manage the departments they are assigned to."
                     : "Only a super admin can grant admin access.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(Theme.Layout.spacing4)
        }
    }

    // MARK: Department

    private var departmentBlock: some View {
        AdminBlock(title: "Department") {
            HStack(spacing: Theme.Layout.spacing3) {
                Menu {
                    ForEach(store.departments) { dept in
                        Button {
                            guard user.deptID != dept.id else { return }
                            apply(.department) { try await store.update(userID: user.id, deptID: dept.id) }
                        } label: {
                            MenuChoiceLabel(title: dept.name, isSelected: user.deptID == dept.id)
                        }
                    }
                } label: {
                    HStack(spacing: Theme.Layout.spacing2) {
                        Text(user.deptName?.isEmpty == false ? user.deptName! : "Choose a department")
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(Theme.Color.text)
                        Spacer(minLength: Theme.Layout.spacing2)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.Color.textMuted)
                    }
                    .frame(minHeight: Theme.Layout.minTouchTarget)
                    .contentShape(Rectangle())
                }
                .disabled(isSelf || busy != nil || store.departments.isEmpty)

                if busy == .department {
                    ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
                }
            }
            .padding(.horizontal, Theme.Layout.spacing4)
            .padding(.vertical, Theme.Layout.spacing2)
        }
    }

    // MARK: Password

    private var passwordBlock: some View {
        AdminBlock(title: "Password") {
            VStack(spacing: Theme.Layout.spacing3) {
                Button {
                    confirmingReset = true
                } label: {
                    HStack(spacing: Theme.Layout.spacing2) {
                        if busy == .password {
                            ProgressView().tint(Theme.Color.warning).scaleEffect(0.7)
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                        Text("Reset Password")
                            .font(Theme.Typography.font(size: 15, weight: .medium))
                    }
                    .foregroundStyle(Theme.Color.warning)
                    .frame(maxWidth: .infinity)
                    .frame(height: Theme.Layout.minTouchTarget)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                            .fill(Theme.Color.warning.opacity(0.10))
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                    .stroke(Theme.Color.warning.opacity(0.30), lineWidth: 1)
                            )
                    )
                }
                .buttonStyle(PressScaleStyle())
                .disabled(busy != nil)

                if let temporaryPassword {
                    VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                        Text("Temporary password")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(Theme.Color.textMuted)

                        HStack(spacing: Theme.Layout.spacing2) {
                            Text(temporaryPassword)
                                .font(Theme.Typography.mono)
                                .foregroundStyle(Theme.Color.primary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)

                            Button {
                                UIPasteboard.general.string = temporaryPassword
                                toasts.success("Copied")
                            } label: {
                                Image(systemName: "doc.on.doc")
                                    .font(.system(size: 15))
                                    .foregroundStyle(Theme.Color.textMuted)
                                    .frame(width: Theme.Layout.minTouchTarget,
                                           height: Theme.Layout.minTouchTarget)
                                    .contentShape(Rectangle())
                            }
                            .accessibilityLabel("Copy temporary password")
                        }

                        // The server hashes and discards it; there is no endpoint that
                        // can read it back. Closing this sheet loses it for good.
                        Text("Shown once. Copy it now and give it to \(user.displayName) — it can't "
                             + "be retrieved again, and they'll be asked to change it when they sign in.")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(Theme.Layout.spacing3)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                            .fill(Theme.Color.primaryTint)
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                    .stroke(Theme.Color.primaryTintBorder, lineWidth: 1)
                            )
                    )
                }
            }
            .padding(Theme.Layout.spacing4)
        }
    }

    // MARK: Mobile access

    private var mobileAccessBlock: some View {
        AdminBlock(title: "Mobile Access") {
            VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                MobileAccessPill(mobileAccess: user.mobileAccess)
                Text(OrgAdminStore.mobileAccessFootnote)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Layout.spacing4)
        }
    }

    // MARK: Mutations

    /// Runs one write, keeps the local copy in step, and reports failures as toasts.
    private func apply(_ field: Field, _ work: @escaping () async throws -> AdminUser) {
        guard busy == nil else { return }
        busy = field
        Task {
            defer { busy = nil }
            do {
                user = try await work()
                toasts.success("Updated")
            } catch {
                toasts.failure(error, fallback: "Couldn't update this account.")
            }
        }
    }

    private func resetPassword() {
        guard busy == nil else { return }
        busy = .password
        temporaryPassword = nil
        Task {
            defer { busy = nil }
            do {
                temporaryPassword = try await store.resetPassword(userID: user.id)
            } catch {
                toasts.failure(error, fallback: "Couldn't reset that password.")
            }
        }
    }
}

// MARK: - Small pieces

/// A titled card in the detail sheet.
private struct AdminBlock<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            SectionHeader(title: title)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                        .fill(Theme.Color.surface)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                                .stroke(Theme.Color.border, lineWidth: 1)
                        )
                )
        }
    }
}

/// The web app's two-up role selector.
private struct SegmentButton: View {
    let title: String
    let isSelected: Bool
    var isDisabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Theme.Typography.font(size: 15, weight: .medium))
                .foregroundStyle(isSelected ? Theme.Color.primary : Theme.Color.textMuted)
                .frame(maxWidth: .infinity)
                .frame(height: Theme.Layout.minTouchTarget)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                        .fill(isSelected ? Theme.Color.primaryTint : Theme.Color.surface2)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                .stroke(
                                    isSelected ? Theme.Color.primaryTintBorder : Theme.Color.border2,
                                    lineWidth: 1
                                )
                        )
                )
        }
        .buttonStyle(PressScaleStyle())
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.5 : 1)
    }
}

/// A menu row with a tick when it is the current choice.
///
/// `Label(title, systemImage: selected ? "checkmark" : "")` is the shorter idiom and
/// the wrong one — an empty symbol name is a missing image, which UIKit logs and
/// which leaves the unselected rows indented differently from the selected one.
private struct MenuChoiceLabel: View {
    let title: String
    let isSelected: Bool

    var body: some View {
        if isSelected {
            Label(title, systemImage: "checkmark")
        } else {
            Text(title)
        }
    }
}

/// A tinted explanatory box.
private struct Callout: View {
    let icon: String
    let tint: Color
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Layout.spacing3) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(tint)
            Text(text)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Color.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Theme.Layout.spacing3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                .fill(tint.opacity(0.10))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                        .stroke(tint.opacity(0.30), lineWidth: 1)
                )
        )
    }
}
