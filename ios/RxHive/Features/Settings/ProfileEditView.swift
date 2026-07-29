import PhotosUI
import SwiftUI
import UIKit

/// Edit your own display name, about line and avatar.
///
/// A port of the profile half of `components/chat/ProfileDrawer.jsx`, which edits
/// each field in place with its own save. Here they are one form with one Save,
/// because three separate saves on a phone means three network round trips and three
/// chances to leave the screen half-applied.
///
/// The avatar is still its own immediate action: `PUT /api/users/profile` only
/// accepts an `avatar_url` that already exists under `/api/media/`, so the picture
/// must be uploaded and claimed before Save could possibly reference it. Deferring
/// it would mean holding megabytes of image in memory for no benefit.
struct ProfileEditView: View {

    /// The profile as it stands on the server when this screen opens.
    let user: CurrentUser
    /// Handed the fresh `/me` after every successful write, so Settings' header
    /// updates without waiting for `AuthStore` to revalidate.
    let onSaved: (CurrentUser) -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var toasts: ToastCenter

    @State private var displayName: String
    @State private var about: String
    @State private var avatarPath: String?

    @State private var pickedItem: PhotosPickerItem?
    @State private var isUploadingAvatar = false
    @State private var isSaving = false
    @State private var nameError: String?

    /// `search.py:update_profile` — "Display name must be 1-50 characters".
    private static let nameLimits = 1...50
    /// `search.py:update_profile` — "About must be 140 characters or less".
    /// The brief asked for 200; the server rejects anything over 140, and a counter
    /// that permits 200 characters only teaches the user to trust it and then fail.
    private static let aboutLimit = 140
    /// `api/media.py` image ceiling. Enforced here as well so a 20 MB burst photo
    /// fails in a tenth of a second rather than after a long upload.
    private static let imageByteLimit = 16 * 1024 * 1024

    init(user: CurrentUser, onSaved: @escaping (CurrentUser) -> Void) {
        self.user = user
        self.onSaved = onSaved
        _displayName = State(initialValue: user.name)
        _about = State(initialValue: user.about ?? "")
        _avatarPath = State(initialValue: user.avatarURL)
    }

    // MARK: - Derived state

    private var trimmedName: String { displayName.trimmed }
    private var trimmedAbout: String { about.trimmed }

    private var nameValidationError: String? {
        if trimmedName.isEmpty { return "Your display name can't be empty." }
        if trimmedName.count > Self.nameLimits.upperBound {
            return "Your display name must be \(Self.nameLimits.upperBound) characters or fewer."
        }
        return nil
    }

    private var hasChanges: Bool {
        trimmedName != user.name || trimmedAbout != (user.about ?? "")
    }

    private var canSave: Bool {
        hasChanges && nameValidationError == nil && about.count <= Self.aboutLimit && !isSaving
    }

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Layout.spacing6) {
                avatarBlock
                nameBlock
                aboutBlock
                emailBlock

                PrimaryButton(title: "Save Changes", isLoading: isSaving, isEnabled: canSave) {
                    save()
                }
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.top, Theme.Layout.spacing4)
            .padding(.bottom, Theme.Layout.spacing8)
        }
        .background(Theme.Color.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
        .onChange(of: pickedItem) { _, item in
            guard let item else { return }
            Task { await uploadAvatar(item) }
        }
    }

    // MARK: - Avatar

    private var avatarBlock: some View {
        VStack(spacing: Theme.Layout.spacing3) {
            ZStack(alignment: .bottomTrailing) {
                Avatar(name: trimmedName.isEmpty ? user.name : trimmedName,
                       urlPath: avatarPath,
                       size: Theme.Layout.avatarHero)
                    .overlay {
                        if isUploadingAvatar {
                            ZStack {
                                Circle().fill(Theme.Color.backdrop)
                                ProgressView().tint(Theme.Color.text)
                            }
                        }
                    }

                PhotosPicker(selection: $pickedItem, matching: .images, photoLibrary: .shared()) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Color.onPrimary)
                        .frame(width: 32, height: 32)
                        .background(
                            Circle()
                                .fill(Theme.Color.primary)
                                .overlay(Circle().stroke(Theme.Color.bg, lineWidth: 2))
                        )
                }
                .disabled(isUploadingAvatar)
                .accessibilityLabel("Change profile photo")
            }
            // The picker's own tap target is only 32pt; the extra padding brings the
            // whole avatar/badge cluster comfortably past the 44pt guideline.
            .padding(Theme.Layout.spacing2)

            if avatarPath != nil {
                Button {
                    Task { await setAvatar(nil) }
                } label: {
                    Text("Remove Photo")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.danger)
                        .frame(minHeight: Theme.Layout.minTouchTarget)
                        .padding(.horizontal, Theme.Layout.spacing3)
                        .contentShape(Rectangle())
                }
                .disabled(isUploadingAvatar)
            } else {
                Text("JPG, PNG, GIF or WebP, up to 16 MB")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Theme.Layout.spacing2)
    }

    // MARK: - Name

    private var nameBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            SectionHeader(title: "Display Name")
            FloatingField(
                label: "Display name",
                text: $displayName,
                hasError: nameError != nil || nameValidationError != nil,
                isDisabled: isSaving,
                textContentType: .name,
                submitLabel: .done
            )
            if let message = nameError ?? nameValidationError {
                InlineError(message: message)
            } else {
                Text("This is the name your colleagues see on messages and calls.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
            }
        }
    }

    // MARK: - About

    private var aboutBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            SectionHeader(title: "About")

            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                    .fill(Theme.Color.surface2)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                            .stroke(isAboutOverLimit ? Theme.Color.danger : Theme.Color.border2, lineWidth: 1)
                    )

                if about.isEmpty {
                    Text("Hey there! I'm using RX HIVE")
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                        .padding(.horizontal, Theme.Layout.spacing4)
                        .padding(.vertical, Theme.Layout.spacing3)
                        .allowsHitTesting(false)
                }

                TextEditor(text: $about)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.text)
                    .tint(Theme.Color.primary)
                    .scrollContentBackground(.hidden)
                    .background(.clear)
                    .padding(.horizontal, Theme.Layout.spacing3)
                    .padding(.vertical, Theme.Layout.spacing2)
                    .disabled(isSaving)
            }
            .frame(height: 96)

            HStack(alignment: .top, spacing: Theme.Layout.spacing3) {
                if isAboutOverLimit {
                    InlineError(message: "About must be \(Self.aboutLimit) characters or fewer.")
                } else {
                    Spacer(minLength: 0)
                }
                Text("\(about.count)/\(Self.aboutLimit)")
                    .font(Theme.Typography.micro)
                    .monospacedDigit()
                    .foregroundStyle(isAboutOverLimit ? Theme.Color.danger : Theme.Color.textMuted)
            }
        }
    }

    private var isAboutOverLimit: Bool { about.count > Self.aboutLimit }

    // MARK: - Email

    private var emailBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            SectionHeader(title: "Email")
            SurfaceCard(padding: Theme.Layout.spacing3) {
                HStack(spacing: Theme.Layout.spacing3) {
                    Image(systemName: "envelope")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.Color.textMuted)
                    Text(user.email)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                        .textSelection(.enabled)
                }
            }
            Text("Your email is set by your organisation's admin and can't be changed here.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Color.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Saving

    private func save() {
        guard canSave else { return }
        isSaving = true
        nameError = nil
        Task {
            defer { isSaving = false }
            // Only the changed fields are sent: `update_profile` treats a present
            // key as an edit, and re-sending an unchanged about would sanitise and
            // rewrite it for no reason.
            let name = trimmedName == user.name ? nil : trimmedName
            let aboutValue = trimmedAbout == (user.about ?? "") ? nil : trimmedAbout
            do {
                let fresh = try await writeProfile(displayName: name, about: aboutValue, avatar: .unchanged)
                onSaved(fresh)
                toasts.success("Profile updated")
                dismiss()
            } catch let apiError as APIError {
                // The server's 400s here are field-level and already phrased for a
                // human ("Display name must be 1-50 characters"), so they go inline
                // rather than into a toast that disappears in two seconds.
                if case .validation(let detail) = apiError, !detail.isEmpty {
                    nameError = detail
                } else {
                    toasts.failure(apiError)
                }
            } catch {
                toasts.error("Couldn't save your profile. Please try again.")
            }
        }
    }

    // MARK: - Avatar upload

    private func uploadAvatar(_ item: PhotosPickerItem) async {
        isUploadingAvatar = true
        defer {
            isUploadingAvatar = false
            // Cleared so re-picking the same photo fires `onChange` again.
            pickedItem = nil
        }

        let data: Data?
        do {
            data = try await item.loadTransferable(type: Data.self)
        } catch {
            toasts.error("Couldn't read that photo.")
            return
        }
        guard let data, !data.isEmpty else {
            toasts.error("Couldn't read that photo.")
            return
        }
        guard data.count <= Self.imageByteLimit else {
            toasts.error("That image is larger than 16 MB.")
            return
        }

        guard let prepared = Self.prepareForUpload(item: item, data: data) else {
            toasts.error("That image format isn't supported. Try a JPG or PNG.")
            return
        }
        do {
            let upload = try await RxHiveAPI.upload(
                data: prepared.data,
                filename: prepared.filename,
                mimeType: prepared.mimeType
            )
            let fresh = try await writeProfile(displayName: nil, about: nil, avatar: .set(upload.fileURL))
            avatarPath = fresh.avatarURL ?? upload.fileURL
            onSaved(fresh)
            toasts.success("Photo updated")
        } catch {
            toasts.failure(error, fallback: "Couldn't upload that photo.")
        }
    }

    private func setAvatar(_ path: String?) async {
        isUploadingAvatar = true
        defer { isUploadingAvatar = false }
        do {
            let fresh = try await writeProfile(displayName: nil, about: nil, avatar: .set(path ?? ""))
            avatarPath = fresh.avatarURL
            onSaved(fresh)
            toasts.success(path == nil ? "Photo removed" : "Photo updated")
        } catch {
            toasts.failure(error, fallback: "Couldn't update your photo.")
        }
    }

    /// Which avatar change, if any, a write carries.
    ///
    /// A three-state value rather than `String?`, because on this endpoint nil and
    /// empty-string mean different things: an absent `avatar_url` key leaves the
    /// picture alone, while `""` clears it (`"avatar_url" in body.model_fields_set`).
    private enum AvatarChange {
        case unchanged
        case set(String)
    }

    /// `PUT /api/users/profile`.
    ///
    /// The response is the updated user, and it is decodable now: the endpoint spells
    /// the name `display_name` where `/me` spells it `name`, and `CurrentUser`'s
    /// decoder accepts either. It previously required `name`, so this write landed on
    /// the server and *then* threw `APIError.decoding`, and the only way through was to
    /// treat that particular failure as success and re-read `/me`. That round trip is
    /// gone — one request, and its own answer is the new user.
    private func writeProfile(
        displayName: String?,
        about: String?,
        avatar: AvatarChange
    ) async throws -> CurrentUser {
        var avatarURL: String?
        if case .set(let value) = avatar { avatarURL = value }
        return try await RxHiveAPI.updateProfile(
            displayName: displayName,
            about: about,
            avatarURL: avatarURL
        )
    }

    // MARK: - Upload preparation

    /// Bytes the API will accept, under a filename whose extension matches them.
    ///
    /// The server derives Content-Type from the **extension** and ignores whatever the
    /// client claims (`api/media.py`), so the name is not cosmetic: an extension
    /// outside .jpg/.jpeg/.png/.gif/.webp is rejected as an unsupported type. The
    /// iPhone camera's default format is HEIC, which is *not* on that list, so those
    /// bytes are genuinely re-encoded to JPEG rather than renamed — mislabelling HEIC
    /// as `.jpg` would upload fine and then fail to decode on every client.
    ///
    /// Returns nil only when the bytes cannot be decoded as an image at all.
    private static func prepareForUpload(
        item: PhotosPickerItem,
        data: Data
    ) -> (data: Data, filename: String, mimeType: String)? {
        let accepted: [String: String] = [
            "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "gif": "image/gif", "webp": "image/webp",
        ]
        let stem = "avatar-\(Int(Date().timeIntervalSince1970))"

        // Trust the bytes over the metadata: `supportedContentTypes` lists what the
        // asset *can* be transcoded to, not what `loadTransferable` handed back.
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
            return (data, "\(stem).png", "image/png")
        }
        if data.starts(with: [0xFF, 0xD8, 0xFF]) {
            return (data, "\(stem).jpg", "image/jpeg")
        }
        if data.starts(with: Array("GIF8".utf8)) {
            return (data, "\(stem).gif", "image/gif")
        }
        // RIFF....WEBP
        if data.count > 12, data.starts(with: Array("RIFF".utf8)),
           data[8..<12].elementsEqual(Array("WEBP".utf8)) {
            return (data, "\(stem).webp", "image/webp")
        }
        // A format the API does not take — HEIC, TIFF, BMP. Re-encode.
        if let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) {
            return (jpeg, "\(stem).jpg", "image/jpeg")
        }
        // Last resort: the picker told us an extension we accept and UIImage could
        // not decode the bytes — send them as-is and let the server have the final say.
        for type in item.supportedContentTypes {
            if let ext = type.preferredFilenameExtension?.lowercased(), let mime = accepted[ext] {
                return (data, "\(stem).\(ext)", mime)
            }
        }
        return nil
    }
}

/// A short red validation line under a field.
private struct InlineError: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Layout.spacing1) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 12))
            Text(message)
                .font(Theme.Typography.caption)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Theme.Color.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
