import PhotosUI
import SwiftUI
import UIKit

/// The group conversation's info panel, ported from `GroupInfoPanel.jsx`.
///
/// ## What gates what
///
/// The three permission booleans are the *stored* group policy, but only one of
/// them is enforced on a write path: `send_messages` is `admin_only_messages`
/// inverted and the message routes honour it. `edit_info` and `add_members` are
/// stored and broadcast, while `PUT /{id}/group` and `POST /{id}/members` both go
/// through `_require_group_admin` (`api/groups.py`) — a plain member with
/// `edit_info` on still gets a 403. So the edit and add affordances here are gated
/// on *role*, not on the permission, exactly as the web panel gates them. Showing a
/// control that always fails is worse than not showing it.
///
/// ## cross_org
///
/// Every group route resolves the conversation through `_load_group`, which
/// requires `type == group`. A cross_org conversation 404s on update, permissions,
/// membership, role change and leave. They are created and administered by super
/// admins in the web portal, so this screen shows a cross_org group read-only and
/// never offers to create one.
struct GroupInfoView: View {

    let conversation: Conversation

    /// Optional integration hooks — see `ContactInfoView` for why these are closures.
    var onJumpToMessage: ((String) -> Void)?
    var onOpenConversation: ((String) -> Void)?
    var onStartCall: ((CallType) -> Void)?

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    @State private var permissions: GroupPermissions?
    @State private var permissionsState: InfoLoadState = .idle
    @State private var savingPermission: String?

    @State private var memberSearch = ""
    @State private var showEditSheet = false
    @State private var showAddMembers = false

    @State private var mutePending = false
    @State private var confirmLeave = false
    @State private var isWorking = false

    /// The number of members above which the roster gets its own search field.
    /// Below it, scrolling is faster than typing.
    private static let searchThreshold = 8

    // MARK: Derived state

    private var live: Conversation {
        chat.conversation(id: conversation.id) ?? conversation
    }

    private var title: String { live.name ?? "Group" }
    private var participants: [UserBrief] { live.participants }
    private var memberCount: Int { participants.count }
    private var isCrossOrg: Bool { live.type == .crossOrg || live.crossOrg }

    private var myRole: ParticipantRole? {
        live.myParticipant(userID: chat.currentUserID)?.role
    }
    private var isCreator: Bool { myRole == .creator }
    private var isAdmin: Bool { myRole?.canAdminister == true }
    /// Cross-org groups are superadmin-managed: nothing here is editable in-app.
    private var canAdminister: Bool { isAdmin && !isCrossOrg }

    private var creatorName: String {
        if let created = live.createdBy,
           let match = participants.first(where: { $0.userId == created }) {
            return match.displayName
        }
        return participants.first { $0.role == .creator }?.displayName ?? "Unknown"
    }

    /// Creator first, then admins, then members, each block name-ascending — the
    /// web panel's ROLE_ORDER.
    private var sortedMembers: [UserBrief] {
        let query = memberSearch.trimmed.lowercased()
        return participants
            .filter { query.isEmpty || $0.displayName.lowercased().contains(query) }
            .sorted { a, b in
                let ra = Self.rank(a.role), rb = Self.rank(b.role)
                if ra != rb { return ra < rb }
                return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
            }
    }

    private static func rank(_ role: ParticipantRole?) -> Int {
        switch role {
        case .creator: return 0
        case .admin: return 1
        default: return 2
        }
    }

    // MARK: Body

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Layout.spacing6) {
                hero
                quickActions
                descriptionSection
                contentSection
                settingsSection
                if !isCrossOrg { permissionsSection }
                membersSection
                protectionSection
                dangerSection
                footer
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing5)
        }
        .background(Theme.Color.bg.ignoresSafeArea())
        .navigationTitle("Group info")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: live.id) {
            guard !isCrossOrg else { return }
            await loadPermissions()
        }
        .sheet(isPresented: $showEditSheet) {
            GroupEditSheet(conversation: live) { updated in
                chat.upsert(updated)
            }
        }
        .sheet(isPresented: $showAddMembers) {
            GroupMemberPickerView(
                excludedUserIDs: Set(participants.map(\.userId))
            ) { ids in
                await addMembers(ids)
            }
        }
        .confirmationDialog(leaveTitle, isPresented: $confirmLeave, titleVisibility: .visible) {
            Button(leaveLabel, role: .destructive) { Task { await leaveGroup() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You will stop receiving messages from this group. Only group admins can add you back.")
        }
    }

    // MARK: Hero

    private var hero: some View {
        VStack(spacing: Theme.Layout.spacing3) {
            Button {
                showEditSheet = true
            } label: {
                ZStack(alignment: .bottomTrailing) {
                    Avatar(name: title, urlPath: live.avatarURL, size: Theme.Layout.avatarHero)
                    if canAdminister {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.Color.onPrimary)
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(Theme.Color.primary))
                            .overlay(Circle().stroke(Theme.Color.bg, lineWidth: 2))
                    }
                }
            }
            .buttonStyle(PressScaleStyle())
            .disabled(!canAdminister)
            .accessibilityLabel(canAdminister ? "Change group icon" : "Group icon")

            VStack(spacing: Theme.Layout.spacing1) {
                HStack(spacing: Theme.Layout.spacing2) {
                    Text(title)
                        .font(Theme.Typography.title)
                        .foregroundStyle(Theme.Color.text)
                        .multilineTextAlignment(.center)
                    if canAdminister {
                        Button {
                            showEditSheet = true
                        } label: {
                            Image(systemName: "pencil")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Theme.Color.primary)
                                .frame(width: 32, height: 32)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("Edit group name")
                    }
                }

                Text("Group · \(memberCount) \(memberCount == 1 ? "member" : "members")")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.textMuted)

                if isCrossOrg {
                    HStack(spacing: Theme.Layout.spacing2) {
                        Pill(text: "Cross-Organization")
                        if let tag = live.purposeTag, !tag.isEmpty {
                            Pill(text: tag, color: Theme.Color.warning)
                        }
                    }
                    .padding(.top, Theme.Layout.spacing1)
                }

                if live.adminOnlyMessages == true {
                    Text(live.canIPost(userID: chat.currentUserID)
                         ? "Only admins can send messages"
                         : "Only admins can send messages — you can read this group")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.warning)
                        .multilineTextAlignment(.center)
                        .padding(.top, Theme.Layout.spacing1)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var quickActions: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            InfoQuickAction(systemImage: "phone", title: "Audio") { startCall(.voice) }
            InfoQuickAction(systemImage: "video", title: "Video") { startCall(.video) }
            InfoQuickAction(systemImage: "person.badge.plus", title: "Add", isEnabled: canAdminister) {
                showAddMembers = true
            }
            InfoQuickActionLink(systemImage: "magnifyingglass", title: "Search") {
                InConversationSearchView(conversationID: live.id, onJump: jump)
            }
        }
    }

    // MARK: Sections

    private var descriptionSection: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            HStack {
                SectionHeader(title: "Description")
                if canAdminister {
                    Button("Edit") { showEditSheet = true }
                        .font(Theme.Typography.pill)
                        .foregroundStyle(Theme.Color.primary)
                }
            }
            SurfaceCard {
                VStack(alignment: .leading, spacing: Theme.Layout.spacing3) {
                    if let description = live.description, !description.trimmed.isEmpty {
                        Text(description)
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(Theme.Color.text)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("No description yet")
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(Theme.Color.textMuted)
                    }

                    if isCrossOrg {
                        Text("This group spans more than one organization. It is created and managed by a super admin in the web portal.")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private var contentSection: some View {
        InfoCard {
            InfoNavigationRow(systemImage: "photo.on.rectangle", title: "Media, links and docs") {
                MediaGalleryView(conversationID: live.id)
            }
            InfoRowDivider()
            InfoNavigationRow(systemImage: "star", title: "Starred messages") {
                StarredMessagesView(conversationID: live.id, onJump: jump)
            }
            InfoRowDivider()
            InfoNavigationRow(systemImage: "pin", title: "Pinned messages") {
                PinnedMessagesView(conversationID: live.id, onJump: jump)
            }
        }
    }

    private var settingsSection: some View {
        InfoCard {
            InfoToggleRow(
                title: "Mute notifications",
                subtitle: live.isMuted
                    ? "You will not be notified about new messages"
                    : "Notifications are on",
                isOn: live.isMuted,
                isBusy: mutePending
            ) { _ in
                Task { await toggleMute() }
            }
        }
    }

    @ViewBuilder
    private var permissionsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            SectionHeader(title: "Members can")

            switch permissionsState {
            case .idle, .loading:
                InfoCard { InfoLoadingRow(label: "Loading permissions…") }

            case .failed:
                InfoCard {
                    InfoRetryView(message: "Couldn't load group permissions.") {
                        Task { await loadPermissions(force: true) }
                    }
                }

            case .loaded:
                if let permissions {
                    if !isAdmin {
                        HStack(alignment: .top, spacing: Theme.Layout.spacing3) {
                            Image(systemName: "shield")
                                .font(.system(size: 15))
                                .foregroundStyle(Theme.Color.textMuted)
                            Text("Only the group creator and admins can change these settings. You can see what is currently allowed.")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Color.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(Theme.Layout.spacing4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                                .fill(Theme.Color.surface2)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                                        .stroke(Theme.Color.border2, lineWidth: 1)
                                )
                        )
                    }

                    InfoCard {
                        InfoToggleRow(
                            title: "Edit group settings",
                            subtitle: "Change the group name, icon and description",
                            isOn: permissions.editInfo,
                            isEnabled: isAdmin,
                            isBusy: savingPermission == "edit_info"
                        ) { next in
                            Task { await setPermission(key: "edit_info", value: next) }
                        }
                        InfoRowDivider(inset: Theme.Layout.spacing4)
                        InfoToggleRow(
                            title: "Send new messages",
                            subtitle: "When off, only the creator and admins can post here",
                            isOn: permissions.sendMessages,
                            isEnabled: isAdmin,
                            isBusy: savingPermission == "send_messages"
                        ) { next in
                            Task { await setPermission(key: "send_messages", value: next) }
                        }
                        InfoRowDivider(inset: Theme.Layout.spacing4)
                        InfoToggleRow(
                            title: "Add other members",
                            subtitle: "Bring other people in this organization into the group",
                            isOn: permissions.addMembers,
                            isEnabled: isAdmin,
                            isBusy: savingPermission == "add_members"
                        ) { next in
                            Task { await setPermission(key: "add_members", value: next) }
                        }
                    }
                }
            }
        }
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            SectionHeader(title: "\(memberCount) \(memberCount == 1 ? "member" : "members")")

            if memberCount > Self.searchThreshold {
                SearchField(placeholder: "Search members", text: $memberSearch)
            }

            InfoCard {
                if canAdminister {
                    InfoActionRow(
                        systemImage: "person.badge.plus",
                        title: "Add members",
                        subtitle: "Anyone in your organization"
                    ) {
                        showAddMembers = true
                    }
                    InfoRowDivider()
                }

                if sortedMembers.isEmpty {
                    InfoRowLabel(
                        systemImage: "person.2",
                        title: "No members match that search"
                    )
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(sortedMembers.enumerated()), id: \.element.userId) { index, member in
                            if index > 0 {
                                InfoRowDivider(inset: Theme.Layout.spacing4 + 38 + Theme.Layout.spacing3)
                            }
                            memberRow(member)
                        }
                    }
                }
            }
        }
    }

    private func memberRow(_ member: UserBrief) -> some View {
        let isMe = member.userId == chat.currentUserID
        // Server rules, mirrored so the menu never offers a call that 403s:
        // roles are creator-only and never on yourself; the creator can't be
        // removed and an admin can't remove another admin (`api/groups.py`).
        let canChangeRole = canAdminister && isCreator && !isMe && member.role != .creator
        let canRemove = canAdminister && !isMe && member.role != .creator
            && !(myRole == .admin && member.role == .admin)
        let status = chat.status(of: member.userId, fallback: member.status)

        return HStack(spacing: Theme.Layout.spacing3) {
            Avatar(name: member.displayName, urlPath: member.avatarURL, size: 38, presence: status)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Layout.spacing1) {
                    Text(member.displayName)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.text)
                        .lineLimit(1)
                    if isMe {
                        Text("(You)")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted)
                    }
                }
                Text(status == .online ? "online" : "offline")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(status == .online ? Theme.Color.primary : Theme.Color.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if member.role == .creator {
                Pill(text: "Creator", color: Theme.Color.warning)
            } else if member.role == .admin {
                Pill(text: "Admin")
            }

            if !isMe {
                Menu {
                    Button {
                        Task { await messagePrivately(member) }
                    } label: {
                        Label("Message \(member.displayName)", systemImage: "bubble.left")
                    }

                    if canChangeRole {
                        Button {
                            Task {
                                await changeRole(
                                    member,
                                    to: member.role == .admin ? "member" : "admin"
                                )
                            }
                        } label: {
                            if member.role == .admin {
                                Label("Dismiss as admin", systemImage: "person.badge.minus")
                            } else {
                                Label("Make group admin", systemImage: "checkmark.shield")
                            }
                        }
                    }

                    if canRemove {
                        Button(role: .destructive) {
                            Task { await remove(member) }
                        } label: {
                            Label("Remove from group", systemImage: "person.fill.xmark")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Color.textMuted)
                        .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Actions for \(member.displayName)")
            }
        }
        .padding(.leading, Theme.Layout.spacing4)
        .padding(.trailing, isMe ? Theme.Layout.spacing4 : 0)
        .padding(.vertical, Theme.Layout.spacing2)
        .frame(minHeight: Theme.Layout.minTouchTarget + 8)
    }

    private var protectionSection: some View {
        InfoCard {
            InfoNavigationRow(
                systemImage: "lock",
                title: "Encryption",
                subtitle: "Encrypted in transit, readable on the server"
            ) {
                EncryptionNoticeView()
            }
        }
    }

    private var dangerSection: some View {
        InfoCard {
            if isCrossOrg {
                InfoRowLabel(
                    systemImage: "info.circle",
                    title: "Managed by an administrator",
                    subtitle: "This cross-organization group is managed centrally — you cannot leave it yourself."
                )
            } else {
                InfoActionRow(
                    systemImage: "rectangle.portrait.and.arrow.right",
                    title: leaveLabel,
                    isDestructive: true,
                    isEnabled: !isWorking
                ) {
                    confirmLeave = true
                }
            }
        }
    }

    private var footer: some View {
        Text(footerText)
            .font(Theme.Typography.caption)
            .foregroundStyle(Theme.Color.textMuted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
    }

    private var footerText: String {
        var text = "Created by \(creatorName)"
        if let created = live.createdAt {
            text += " · Created \(created.formatted(.dateTime.day().month(.wide).year()))"
        }
        return text
    }

    /// The creator of a group they are the last member of is deleting it, not
    /// leaving it — the server deactivates the conversation once nobody remains.
    private var leaveLabel: String {
        isCreator && memberCount == 1 ? "Delete group" : "Exit group"
    }

    private var leaveTitle: String {
        isCreator && memberCount == 1 ? "Delete \"\(title)\"?" : "Exit \"\(title)\"?"
    }

    // MARK: Actions

    private func jump(_ messageID: String) {
        onJumpToMessage?(messageID)
        dismiss()
    }

    private func startCall(_ type: CallType) {
        if let onStartCall {
            onStartCall(type)
            return
        }
        guard auth.realtime.state == .connected else {
            toasts.error("You're offline — reconnect to place a call.")
            return
        }
        auth.realtime.send(.callGroupInitiate(conversationID: live.id, callType: type.rawValue))
    }

    private func toggleMute() async {
        mutePending = true
        defer { mutePending = false }
        if let muted = await chat.toggleMute(conversationID: live.id) {
            toasts.success(muted ? "Notifications muted" : "Notifications unmuted")
        } else {
            toasts.error("Failed to change mute")
        }
    }

    private func leaveGroup() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await RxHiveAPI.leaveGroup(conversationID: live.id)
            toasts.success(leaveLabel == "Delete group" ? "Group deleted" : "Left group")
            // The `member_left` broadcast does not reach us — we are no longer a
            // participant — so the list is corrected here rather than by an event.
            // Re-read it rather than calling `deleteConversation`: leaving has already
            // removed my participant row, so the DELETE would 404 and the stale row
            // would survive.
            await chat.loadConversations()
            dismiss()
        } catch {
            toasts.failure(error, fallback: "Failed to leave group")
        }
    }

    private func addMembers(_ ids: [String]) async {
        guard !ids.isEmpty else { return }
        do {
            try await RxHiveAPI.addMembers(conversationID: live.id, userIDs: ids)
            toasts.success(ids.count == 1 ? "Member added" : "\(ids.count) members added")
            await chat.refreshConversation(id: live.id)
        } catch {
            toasts.failure(error, fallback: "Failed to add member")
        }
    }

    private func remove(_ member: UserBrief) async {
        do {
            try await RxHiveAPI.removeMember(conversationID: live.id, memberID: member.userId)
            toasts.success("\(member.displayName) removed")
            await chat.refreshConversation(id: live.id)
        } catch {
            toasts.failure(error, fallback: "Failed to remove member")
        }
    }

    private func changeRole(_ member: UserBrief, to role: String) async {
        do {
            try await RxHiveAPI.changeMemberRole(
                conversationID: live.id, memberID: member.userId, role: role
            )
            toasts.success(role == "admin" ? "Made admin" : "Removed as admin")
            await chat.refreshConversation(id: live.id)
        } catch {
            toasts.failure(error, fallback: "Failed to change role")
        }
    }

    private func messagePrivately(_ member: UserBrief) async {
        do {
            let direct = try await RxHiveAPI.directConversation(participantID: member.userId)
            chat.upsert(direct)
            if let onOpenConversation {
                onOpenConversation(direct.id)
            }
            dismiss()
        } catch {
            toasts.failure(error, fallback: "Failed to open chat")
        }
    }

    // MARK: Permissions

    private func loadPermissions(force: Bool = false) async {
        if permissionsState == .loaded && !force { return }
        permissionsState = .loading
        do {
            permissions = try await RxHiveAPI.groupPermissions(conversationID: live.id)
            permissionsState = .loaded
        } catch {
            permissions = nil
            permissionsState = .failed
        }
    }

    private func setPermission(key: String, value: Bool) async {
        guard let current = permissions else { return }
        savingPermission = key
        defer { savingPermission = nil }

        // Optimistic, then replaced by whatever the server answers — the response is
        // the whole permission set, so a rejected key corrects itself.
        permissions = GroupPermissions(
            editInfo: key == "edit_info" ? value : current.editInfo,
            addMembers: key == "add_members" ? value : current.addMembers,
            sendMessages: key == "send_messages" ? value : current.sendMessages
        )

        do {
            permissions = try await RxHiveAPI.updateGroupPermissions(
                conversationID: live.id,
                editInfo: key == "edit_info" ? value : nil,
                sendMessages: key == "send_messages" ? value : nil,
                addMembers: key == "add_members" ? value : nil
            )
            // `send_messages` is `admin_only_messages` inverted, and the composer
            // reads that off the conversation — so the conversation has to be
            // re-read or the composer stays enabled for members after it is turned off.
            if key == "send_messages" {
                await chat.refreshConversation(id: live.id)
            }
        } catch {
            permissions = current
            toasts.failure(error, fallback: "Failed to update permission")
        }
    }
}

// MARK: - Editing group info

/// Name, description and icon in one sheet.
///
/// One sheet rather than the web panel's three inline editors: an inline editor on
/// a phone puts the field under the keyboard, and three of them means three
/// separate saves for what a user thinks of as one edit.
private struct GroupEditSheet: View {
    let conversation: Conversation
    let onSaved: (Conversation) -> Void

    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var descriptionText: String
    @State private var pickedItem: PhotosPickerItem?
    @State private var pickedImage: UIImage?
    @State private var isSaving = false

    /// Group names are capped at 100 and descriptions at 500 in the web panel; the
    /// server sanitises but does not truncate, so the limit is enforced here too.
    private static let nameLimit = 100
    private static let descriptionLimit = 500

    init(conversation: Conversation, onSaved: @escaping (Conversation) -> Void) {
        self.conversation = conversation
        self.onSaved = onSaved
        _name = State(initialValue: conversation.name ?? "")
        _descriptionText = State(initialValue: conversation.description ?? "")
    }

    private var canSave: Bool {
        !name.trimmed.isEmpty && !isSaving
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Layout.spacing5) {
                    PhotosPicker(selection: $pickedItem, matching: .images) {
                        ZStack(alignment: .bottomTrailing) {
                            if let pickedImage {
                                Image(uiImage: pickedImage)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: Theme.Layout.avatarHero, height: Theme.Layout.avatarHero)
                                    .clipShape(Circle())
                            } else {
                                Avatar(
                                    name: conversation.name ?? "Group",
                                    urlPath: conversation.avatarURL,
                                    size: Theme.Layout.avatarHero
                                )
                            }
                            Image(systemName: "camera.fill")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.Color.onPrimary)
                                .frame(width: 30, height: 30)
                                .background(Circle().fill(Theme.Color.primary))
                                .overlay(Circle().stroke(Theme.Color.bg, lineWidth: 2))
                        }
                    }
                    .accessibilityLabel("Change group icon")

                    FloatingField(label: "Group name", text: $name, submitLabel: .done)
                        .onChange(of: name) { _, newValue in
                            if newValue.count > Self.nameLimit {
                                name = String(newValue.prefix(Self.nameLimit))
                            }
                        }

                    VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                        SectionHeader(title: "Description")
                        TextEditor(text: $descriptionText)
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(Theme.Color.text)
                            .tint(Theme.Color.primary)
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 110)
                            .padding(Theme.Layout.spacing3)
                            .background(
                                RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                    .fill(Theme.Color.surface2)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                            .stroke(Theme.Color.border2, lineWidth: 1)
                                    )
                            )
                            .onChange(of: descriptionText) { _, newValue in
                                if newValue.count > Self.descriptionLimit {
                                    descriptionText = String(newValue.prefix(Self.descriptionLimit))
                                }
                            }
                        Text("\(descriptionText.count)/\(Self.descriptionLimit)")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(Theme.Color.textMuted)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }

                    PrimaryButton(title: "Save changes", isLoading: isSaving, isEnabled: canSave) {
                        Task { await save() }
                    }
                }
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.vertical, Theme.Layout.spacing5)
            }
            .background(Theme.Color.bg.ignoresSafeArea())
            .navigationTitle("Edit group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }
            .task(id: pickedItem) { await loadPickedImage() }
        }
    }

    private func loadPickedImage() async {
        guard let pickedItem else { return }
        guard let data = try? await pickedItem.loadTransferable(type: Data.self),
              let image = UIImage(data: data) else {
            toasts.error("Couldn't read that image")
            return
        }
        pickedImage = image
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }

        var avatarPath: String?
        if let pickedImage {
            // Re-encoded as JPEG at a bounded size: the server derives the MIME type
            // from the *filename extension* and ignores the client's Content-Type, so
            // the bytes and the name have to agree. 512pt at 0.85 is a few hundred KB,
            // far under the 16 MB image cap, and an avatar is never shown larger.
            guard let data = Self.jpegData(from: pickedImage, maxDimension: 512) else {
                toasts.error("Couldn't prepare that image")
                return
            }
            do {
                let upload = try await RxHiveAPI.upload(
                    data: data, filename: "group-icon.jpg", mimeType: "image/jpeg"
                )
                avatarPath = upload.fileURL
            } catch {
                toasts.failure(error, fallback: "Couldn't upload the group icon")
                return
            }
        }

        let trimmedName = name.trimmed
        let trimmedDescription = descriptionText.trimmed
        // Only send what changed: `PUT /{id}/group` treats a present key as an
        // instruction, and re-sending an unchanged name posts a "changed the group
        // name" system message to everybody.
        let nextName = trimmedName == (conversation.name ?? "") ? nil : trimmedName
        let nextDescription = trimmedDescription == (conversation.description ?? "") ? nil : trimmedDescription

        guard nextName != nil || nextDescription != nil || avatarPath != nil else {
            dismiss()
            return
        }

        do {
            let updated = try await RxHiveAPI.updateGroup(
                conversationID: conversation.id,
                name: nextName,
                description: nextDescription,
                avatarURL: avatarPath
            )
            onSaved(updated)
            toasts.success("Group updated")
            dismiss()
        } catch {
            toasts.failure(error, fallback: "Failed to update the group")
        }
    }

    /// Aspect-preserving downscale to `maxDimension`, then JPEG.
    private static func jpegData(from image: UIImage, maxDimension: CGFloat) -> Data? {
        let longest = max(image.size.width, image.size.height)
        let scale = longest > maxDimension ? maxDimension / longest : 1
        let target = CGSize(width: (image.size.width * scale).rounded(),
                            height: (image.size.height * scale).rounded())
        let renderer = UIGraphicsImageRenderer(size: target)
        let resized = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: 0.85)
    }
}

// MARK: - Member picker

/// Multi-select contact picker for "Add members".
///
/// Reads the org roster (`GET /api/users/contacts`), which is already scoped to my
/// organization and excludes me — the only extra filtering needed is the people
/// already in the group, because the server skips those silently and the user would
/// otherwise get a success toast for having added nobody.
struct GroupMemberPickerView: View {
    let excludedUserIDs: Set<String>
    let onAdd: ([String]) async -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var contacts: [Contact] = []
    @State private var selected: Set<String> = []
    @State private var state: InfoLoadState = .idle
    @State private var isAdding = false

    private var candidates: [Contact] {
        contacts.filter { !excludedUserIDs.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: Theme.Layout.spacing3) {
                SearchField(placeholder: "Search people", text: $query)
                    .padding(.horizontal, Theme.Layout.gutter)

                switch state {
                case .idle, .loading:
                    VStack(spacing: Theme.Layout.spacing4) {
                        ForEach(0..<6, id: \.self) { _ in
                            SkeletonRow(height: 16, widthFraction: 0.7)
                        }
                    }
                    .padding(.horizontal, Theme.Layout.gutter)
                    .padding(.top, Theme.Layout.spacing3)
                    Spacer()

                case .failed:
                    InfoRetryView(message: "Couldn't load your organization's directory.") {
                        Task { await load(force: true) }
                    }
                    Spacer()

                case .loaded where candidates.isEmpty:
                    EmptyStateView(
                        systemImage: "person.2",
                        title: query.trimmed.isEmpty ? "Everyone is already here" : "No matches",
                        message: query.trimmed.isEmpty
                            ? "Every active person in your organization is already a member of this group."
                            : "Nobody in your organization matches \"\(query.trimmed)\"."
                    )

                case .loaded:
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(candidates) { contact in
                                Button {
                                    if selected.contains(contact.id) {
                                        selected.remove(contact.id)
                                    } else {
                                        selected.insert(contact.id)
                                    }
                                } label: {
                                    contactRow(contact)
                                }
                                .buttonStyle(PressScaleStyle())
                                Hairline().padding(.leading, Theme.Layout.gutter + 38 + Theme.Layout.spacing3)
                            }
                        }
                    }
                }
            }
            .padding(.top, Theme.Layout.spacing3)
            .background(Theme.Color.bg.ignoresSafeArea())
            .navigationTitle("Add members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Color.textMuted)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task {
                            isAdding = true
                            await onAdd(Array(selected))
                            isAdding = false
                            dismiss()
                        }
                    } label: {
                        if isAdding {
                            ProgressView().tint(Theme.Color.primary)
                        } else {
                            Text(selected.isEmpty ? "Add" : "Add \(selected.count)")
                                .font(Theme.Typography.font(size: 16, weight: .medium))
                        }
                    }
                    .disabled(selected.isEmpty || isAdding)
                    .foregroundStyle(selected.isEmpty ? Theme.Color.textMuted : Theme.Color.primary)
                }
            }
            // Debounced: the roster endpoint takes the query server-side, so typing
            // "anna" would otherwise be four round trips.
            .task(id: query) {
                if state != .idle {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard !Task.isCancelled else { return }
                }
                await load(force: true)
            }
        }
    }

    private func contactRow(_ contact: Contact) -> some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Avatar(name: contact.displayName, urlPath: contact.avatarURL, size: 38, presence: contact.status)

            VStack(alignment: .leading, spacing: 2) {
                Text(contact.displayName)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.text)
                    .lineLimit(1)
                Text(contact.departmentName)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Image(systemName: selected.contains(contact.id) ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 20))
                .foregroundStyle(selected.contains(contact.id) ? Theme.Color.primary : Theme.Color.border2)
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
        .contentShape(Rectangle())
    }

    private func load(force: Bool) async {
        if state == .loaded && !force { return }
        if state == .idle { state = .loading }
        do {
            contacts = try await RxHiveAPI.contacts(search: query.trimmed)
            state = .loaded
        } catch {
            state = .failed
        }
    }
}
