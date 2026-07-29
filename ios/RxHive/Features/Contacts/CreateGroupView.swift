import PhotosUI
import SwiftUI
import UIKit

/// Two-step group creation, ported from `CreateGroupModal.jsx`: pick members, then
/// name it. Pushed, not sheeted, so the step-2 back gesture is the platform's.
///
/// The member minimum is **two**, not one: `POST /api/conversations/group` rejects
/// anything smaller ("At least 2 members are required" — `api/groups.py`, which
/// also drops the creator's own id from the list before counting). A one-member
/// group would be a guaranteed 400, so the button stays disabled instead.
struct CreateGroupView: View {
    /// The id of the conversation the server created.
    let onCreated: (String) -> Void

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter

    private enum Step { case members, details }

    @StateObject private var directory = ContactDirectory()
    @State private var step: Step = .members
    /// Ordered, so the chip strip keeps the order they were picked in.
    @State private var selected: [Contact] = []

    @State private var name = ""
    @State private var groupDescription = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var pickedImage: UIImage?
    /// The uploaded avatar's server path, passed to `createGroup` as `avatar_url`.
    @State private var avatarURL: String?
    @State private var isUploadingAvatar = false
    @State private var isCreating = false

    /// `api/groups.py` sanitises but does not truncate; these match the web inputs'
    /// maxLength so the two clients accept the same thing.
    private let nameLimit = 100
    private let descriptionLimit = 500

    private var canAdvance: Bool { selected.count >= 2 }
    private var canCreate: Bool { canAdvance && !name.trimmed.isEmpty && !isUploadingAvatar }

    var body: some View {
        ZStack {
            Theme.Color.bg.ignoresSafeArea()

            switch step {
            case .members:
                memberPicker
                    .transition(.move(edge: .leading).combined(with: .opacity))
            case .details:
                details
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(Theme.Motion.easeSlow, value: step)
        .navigationTitle("New group")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(step == .details)
        .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            if step == .details {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        withAnimation(Theme.Motion.easeSlow) { step = .members }
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.Color.text)
                    }
                    .accessibilityLabel("Back to members")
                }
            }
        }
        .task { await directory.start() }
    }

    // MARK: - Step 1: members

    private var memberPicker: some View {
        VStack(spacing: 0) {
            Text("Step 1 of 2 · Select members")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Color.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.bottom, Theme.Layout.spacing2)

            if !selected.isEmpty {
                chipStrip
            }

            SearchField(placeholder: "Search contacts", text: $directory.query)
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.bottom, Theme.Layout.spacing3)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    contactList
                }
                .padding(.bottom, Theme.Layout.spacing4)
            }
            .scrollDismissesKeyboard(.immediately)

            footer {
                VStack(spacing: Theme.Layout.spacing2) {
                    Text(
                        canAdvance
                            ? "\(selected.count) selected"
                            : "Select at least 2 people"
                    )
                    .font(Theme.Typography.caption)
                    .foregroundStyle(canAdvance ? Theme.Color.textMuted : Theme.Color.warning)

                    PrimaryButton(title: "Next", isEnabled: canAdvance) {
                        withAnimation(Theme.Motion.easeSlow) { step = .details }
                    }
                }
            }
        }
    }

    private var chipStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Layout.spacing2) {
                ForEach(selected) { contact in
                    GroupMemberChip(contact: contact) { remove(contact) }
                }
            }
            .padding(.horizontal, Theme.Layout.gutter)
        }
        .frame(height: Theme.Layout.minTouchTarget)
        .padding(.bottom, Theme.Layout.spacing2)
    }

    @ViewBuilder
    private var contactList: some View {
        if directory.contacts.isEmpty, directory.isLoading {
            ProgressView()
                .tint(Theme.Color.primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Layout.spacing8)
        } else if directory.contacts.isEmpty, let message = directory.errorMessage {
            EmptyStateView(
                systemImage: "wifi.slash",
                title: "Couldn't load contacts",
                message: message,
                actionTitle: "Try again"
            ) {
                Task { await directory.refresh() }
            }
            .frame(minHeight: 200)
        } else if directory.contacts.isEmpty {
            EmptyStateView(systemImage: "person.2", title: "No contacts found")
                .frame(minHeight: 200)
        } else {
            ForEach(directory.contacts) { contact in
                // No separators: the selection tint is the row boundary here, and a
                // hairline under a tinted row reads as a table rule cutting it in two.
                ContactRow(
                    contact: contact,
                    status: chat.status(of: contact.id, fallback: contact.status),
                    isSelected: isSelected(contact),
                    onTap: { toggle(contact) }
                )
            }
        }
    }

    // MARK: - Step 2: details

    private var details: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Layout.spacing5) {
                    Text("Step 2 of 2 · Group details")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)

                    avatarPicker
                        .frame(maxWidth: .infinity)

                    FloatingField(label: "Group name", text: $name, submitLabel: .done)
                        .onChange(of: name) { _, new in
                            if new.count > nameLimit { name = String(new.prefix(nameLimit)) }
                        }

                    VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                        SectionHeader(title: "Description (optional)")
                        descriptionField
                    }

                    memberSummary
                }
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.bottom, Theme.Layout.spacing6)
            }
            .scrollDismissesKeyboard(.interactively)

            footer {
                PrimaryButton(
                    title: "Create group",
                    isLoading: isCreating,
                    isEnabled: canCreate
                ) {
                    Task { await create() }
                }
            }
        }
    }

    private var avatarPicker: some View {
        PhotosPicker(selection: $photoItem, matching: .images, photoLibrary: .shared()) {
            ZStack {
                if let pickedImage {
                    Image(uiImage: pickedImage)
                        .resizable()
                        .scaledToFill()
                } else {
                    Circle().fill(Theme.Color.primaryTint)
                    if name.trimmed.isEmpty {
                        Image(systemName: "camera")
                            .font(.system(size: 22))
                            .foregroundStyle(Theme.Color.primary)
                    } else {
                        Text(name.trimmed.prefix(2).uppercased())
                            .font(Theme.Typography.font(size: 30, weight: .bold))
                            .foregroundStyle(Theme.Color.primary)
                    }
                }
            }
            .frame(width: Theme.Layout.avatarHero, height: Theme.Layout.avatarHero)
            .clipShape(Circle())
            .overlay(
                Circle().strokeBorder(
                    Theme.Color.border2,
                    style: StrokeStyle(lineWidth: 2, dash: pickedImage == nil ? [4, 4] : [])
                )
            )
            .overlay(alignment: .bottomTrailing) {
                if isUploadingAvatar {
                    ProgressView()
                        .tint(Theme.Color.onPrimary)
                        .scaleEffect(0.7)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(Theme.Color.primary))
                } else {
                    Image(systemName: "pencil")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Color.onPrimary)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(Theme.Color.primary))
                        .overlay(Circle().stroke(Theme.Color.bg, lineWidth: 2))
                }
            }
        }
        .buttonStyle(PressScaleStyle())
        .disabled(isUploadingAvatar)
        .accessibilityLabel("Choose a group photo")
        .onChange(of: photoItem) { _, item in
            Task { await uploadAvatar(item) }
        }
    }

    private var descriptionField: some View {
        TextField("What is this group about?", text: $groupDescription, axis: .vertical)
            .font(Theme.Typography.subheadline)
            .foregroundStyle(Theme.Color.text)
            .tint(Theme.Color.primary)
            .lineLimit(2...5)
            .padding(.horizontal, Theme.Layout.spacing3)
            .padding(.vertical, Theme.Layout.spacing3)
            .background(
                RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                    .fill(Theme.Color.surface2)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                            .stroke(Theme.Color.border2, lineWidth: 1)
                    )
            )
            .onChange(of: groupDescription) { _, new in
                if new.count > descriptionLimit {
                    groupDescription = String(new.prefix(descriptionLimit))
                }
            }
    }

    private var memberSummary: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing3) {
            HStack(spacing: Theme.Layout.spacing2) {
                Image(systemName: "person.2")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Color.textMuted)
                Text("\(selected.count + 1) members (including you)")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.textMuted)
            }

            AvatarCluster(
                people: selected.map { (name: $0.displayName, urlPath: $0.avatarURL) },
                size: Theme.Layout.avatarSmall,
                maxShown: 5
            )
        }
    }

    // MARK: - Chrome

    private func footer<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            Hairline()
            content()
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.top, Theme.Layout.spacing3)
                .padding(.bottom, Theme.Layout.spacing2)
        }
        .background(Theme.Color.sidebar)
    }

    // MARK: - Selection

    private func isSelected(_ contact: Contact) -> Bool {
        selected.contains { $0.id == contact.id }
    }

    private func toggle(_ contact: Contact) {
        withAnimation(Theme.Motion.interactive) {
            if isSelected(contact) {
                remove(contact)
            } else {
                selected.append(contact)
            }
        }
    }

    private func remove(_ contact: Contact) {
        withAnimation(Theme.Motion.interactive) {
            selected.removeAll { $0.id == contact.id }
        }
    }

    // MARK: - Avatar upload

    private func uploadAvatar(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        isUploadingAvatar = true
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else {
                toasts.error("That image couldn't be read")
                isUploadingAvatar = false
                return
            }
            // Re-encoded as JPEG rather than forwarded as-is: the server derives the
            // MIME type from the *extension* and only accepts jpg/jpeg/png/gif/webp,
            // and iPhones write HEIC by default. Downscaling also keeps the upload
            // comfortably under the 16 MB image ceiling.
            guard let jpeg = Self.avatarJPEG(from: image) else {
                toasts.error("That image couldn't be used")
                isUploadingAvatar = false
                return
            }
            let upload = try await RxHiveAPI.upload(
                data: jpeg, filename: "group-avatar.jpg", mimeType: "image/jpeg"
            )
            pickedImage = image
            avatarURL = upload.fileURL
        } catch {
            toasts.failure(error, fallback: "Couldn't upload that photo")
        }
        isUploadingAvatar = false
    }

    private static func avatarJPEG(from image: UIImage, maxDimension: CGFloat = 1024) -> Data? {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxDimension, longest > 0 else {
            return image.jpegData(compressionQuality: 0.85)
        }
        let scale = maxDimension / longest
        let target = CGSize(
            width: (image.size.width * scale).rounded(),
            height: (image.size.height * scale).rounded()
        )
        let format = UIGraphicsImageRendererFormat.default()
        // Scale 1: the target size is already in pixels, and a 3x renderer would
        // triple the bytes for no visible gain on an avatar.
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: 0.85)
    }

    // MARK: - Create

    private func create() async {
        let trimmed = name.trimmed
        guard canCreate, !isCreating else { return }
        isCreating = true
        do {
            let group = try await RxHiveAPI.createGroup(
                name: trimmed,
                description: groupDescription.trimmed.isEmpty ? nil : groupDescription.trimmed,
                avatarURL: avatarURL,
                memberIDs: selected.map(\.id)
            )
            // Seed the list before handing back, so the pushed thread has a row to
            // read its title and participants from.
            chat.upsert(group)
            toasts.success("Group “\(trimmed)” created")
            onCreated(group.id)
        } catch {
            toasts.failure(error, fallback: "Couldn't create the group")
        }
        isCreating = false
    }
}

/// A selected-member chip.
///
/// The whole chip removes the member — the web's 12px X is a mouse target, and a
/// 44pt hit area around one on a phone would be larger than the chip it sits in.
/// The visible capsule stays 36pt tall inside a 44pt target.
struct GroupMemberChip: View {
    let contact: Contact
    let onRemove: () -> Void

    var body: some View {
        Button(action: onRemove) {
            HStack(spacing: Theme.Layout.spacing2) {
                Avatar(name: contact.displayName, urlPath: contact.avatarURL, size: 22)
                Text(contact.displayName)
                    .font(Theme.Typography.pill)
                    .foregroundStyle(Theme.Color.text)
                    .lineLimit(1)
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Theme.Color.textMuted)
            }
            .padding(.horizontal, Theme.Layout.spacing2)
            .frame(height: 36)
            .background(
                Capsule()
                    .fill(Theme.Color.surface2)
                    .overlay(Capsule().stroke(Theme.Color.border2, lineWidth: 1))
            )
            .frame(height: Theme.Layout.minTouchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("Remove \(contact.displayName)")
    }
}
