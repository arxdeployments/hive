import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The message composer: text, attachments and voice notes.
///
/// Ported from `frontend/src/components/chat/MessageComposer.jsx`, with one
/// deliberate divergence. The web app stages every pick in a confirmation tray with
/// a caption field, because a desktop file dialog is easy to mis-click. On a phone the
/// system pickers are already a confirmation step (you tap a photo, then tap Add), so
/// a second tray would be a third tap for nothing. Instead a pick uploads straight
/// away and the *composer's own text* becomes the caption, which is where the user's
/// fingers already are.
struct MessageComposer: View {

    let conversationID: String
    let replyTo: Message?
    let onSent: () -> Void
    /// Added to the assigned signature, because the reply strip lives in here but the
    /// `replyTo` state lives in the parent — a child cannot clear a value it does not
    /// own. Defaulted so the fixed three-argument call site still compiles; when it is
    /// not supplied the X still hides the strip locally (see `replyDismissed`), so the
    /// control is never inert.
    let onCancelReply: () -> Void

    init(
        conversationID: String,
        replyTo: Message?,
        onSent: @escaping () -> Void,
        onCancelReply: @escaping () -> Void = {}
    ) {
        self.conversationID = conversationID
        self.replyTo = replyTo
        self.onSent = onSent
        self.onCancelReply = onCancelReply
    }

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter

    @State private var text = ""
    @FocusState private var isFocused: Bool

    @State private var showPhotoPicker = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var showFileImporter = false

    @State private var uploads: [UploadJob] = []
    @State private var replyDismissed = false
    @State private var replyConsumed = false

    @StateObject private var recorder = AudioRecorder()
    /// The finger is on the mic. Separate from `recorder.isRecording` because the
    /// permission prompt sits between the two, and a finger lifted during the prompt
    /// must not start a recording nobody is holding.
    @State private var micHeld = false
    @State private var cancelArmed = false
    @State private var slideOffset: CGFloat = 0

    private var trimmedText: String { text.trimmed }
    private var hasText: Bool { !trimmedText.isEmpty }

    /// `admin_only_messages` on a group: only the creator and admins may post.
    private var canPost: Bool {
        guard let conversation = chat.conversation(id: conversationID) else { return true }
        return conversation.canIPost(userID: chat.currentUserID)
    }

    private var showsReplyStrip: Bool { replyTo != nil && !replyDismissed }

    /// The reply target, once.
    ///
    /// A batch of files attaches the quote to the first message only — the same thing
    /// the web composer does, because five bubbles each quoting the same message reads
    /// as a bug rather than as one reply with five attachments.
    private func consumeReplyID() -> String? {
        guard !replyConsumed, let id = replyTo?.id else { return nil }
        replyConsumed = true
        return id
    }

    var body: some View {
        VStack(spacing: 0) {
            Hairline()

            if showsReplyStrip, let replyTo {
                ReplyStrip(message: replyTo) {
                    replyDismissed = true
                    onCancelReply()
                }
            }

            if !uploads.isEmpty {
                VStack(spacing: 0) {
                    ForEach(uploads) { job in
                        UploadRow(job: job) { cancel(job: job) }
                    }
                }
                .transition(.opacity)
            }

            if !canPost {
                blockedNotice
            } else if recorder.isRecording {
                recordingBar
            } else {
                composerRow
            }
        }
        .background(Theme.Color.sidebar)
        .animation(Theme.Motion.ease, value: showsReplyStrip)
        .animation(Theme.Motion.ease, value: uploads.count)
        .animation(Theme.Motion.ease, value: recorder.isRecording)
        .onChange(of: replyTo?.id) { _, _ in
            replyDismissed = false
            replyConsumed = false
            // Replying is an invitation to type; the web app focuses the box too.
            if replyTo != nil { isFocused = true }
        }
        .onChange(of: text) { _, newValue in
            guard !newValue.isEmpty else { return }
            chat.noteTyping(in: conversationID)
        }
        .onChange(of: isFocused) { _, focused in
            // Blur means the user has stopped composing, whatever the throttle thinks.
            if !focused { chat.stopTyping(in: conversationID) }
        }
        .onDisappear {
            chat.stopTyping(in: conversationID)
            // A live microphone keeps the recording indicator lit system-wide, so it
            // must not survive the screen it belongs to.
            recorder.cancel()
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $photoSelection,
            maxSelectionCount: 10,
            matching: .any(of: [.images, .videos])
        )
        .onChange(of: photoSelection) { _, items in
            guard !items.isEmpty else { return }
            let picked = items
            photoSelection = []
            Task { @MainActor in await stage(pickerItems: picked) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraCapture { data, filename in
                showCamera = false
                guard let data, let filename else { return }
                stage(data: data, filename: filename)
            }
            .ignoresSafeArea()
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: Self.documentContentTypes,
            allowsMultipleSelection: true
        ) { result in
            handleFileImport(result)
        }
    }

    // MARK: - Composer row

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: Theme.Layout.spacing2) {
            attachmentMenu

            TextField("Message", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.Color.text)
                .tint(Theme.Color.primary)
                .focused($isFocused)
                .padding(.horizontal, Theme.Layout.spacing4)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Theme.Color.surface2)
                        .overlay(
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .stroke(isFocused ? Theme.Color.primary : Theme.Color.border2, lineWidth: 1)
                        )
                )
                .animation(Theme.Motion.ease, value: isFocused)

            sendOrMicButton
        }
        .padding(.horizontal, Theme.Layout.spacing3)
        .padding(.vertical, Theme.Layout.spacing2)
    }

    private var attachmentMenu: some View {
        Menu {
            Button {
                showPhotoPicker = true
            } label: {
                Label("Photo Library", systemImage: "photo.on.rectangle")
            }
            Button {
                showCamera = true
            } label: {
                Label("Camera", systemImage: "camera")
            }
            Button {
                showFileImporter = true
            } label: {
                Label("Document", systemImage: "doc")
            }
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 19))
                .foregroundStyle(Theme.Color.textMuted)
                .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
        }
        .accessibilityLabel("Add attachment")
    }

    private var sendOrMicButton: some View {
        ZStack {
            Circle().fill(Theme.Color.primary)
            Image(systemName: hasText ? "paperplane.fill" : "mic.fill")
                .font(.system(size: hasText ? 16 : 18, weight: .medium))
                .foregroundStyle(Theme.Color.onPrimary)
                // The plane's artwork leans up-left; nudging it centres the mass.
                .offset(x: hasText ? -1 : 0, y: hasText ? 1 : 0)
        }
        .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
        .scaleEffect(micHeld ? 1.25 : 1)
        .animation(Theme.Motion.interactive, value: micHeld)
        .contentShape(Circle())
        // Two different controls in one place: a tap target when there is text, a
        // press-and-hold recorder when there is not.
        .onTapGesture {
            if hasText { sendText() }
        }
        // `.subviews` disables this gesture while keeping the tap above it live, which
        // is how one control can be a button with text and a recorder without.
        .gesture(micGesture, including: hasText ? GestureMask.subviews : GestureMask.all)
        .accessibilityLabel(hasText ? "Send message" : "Hold to record a voice message")
    }

    private var blockedNotice: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            Image(systemName: "lock")
                .font(.system(size: 13))
            Text("Only admins can send messages in this group")
                .font(Theme.Typography.caption)
        }
        .foregroundStyle(Theme.Color.textMuted)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Layout.spacing4)
    }

    // MARK: - Text send

    private func sendText() {
        let body = trimmedText
        guard !body.isEmpty, canPost else { return }
        let replyID = consumeReplyID()
        text = ""
        chat.stopTyping(in: conversationID)
        Task { @MainActor in
            await chat.send(conversationID: conversationID, content: body, replyTo: replyID)
            // After the await, so the optimistic bubble already exists and the parent's
            // scroll-to-bottom has something to scroll to.
            onSent()
        }
    }

    // MARK: - Voice notes

    private var micGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if !micHeld { beginRecording() }
                // Only leftward travel counts, so a wobble downwards while holding does
                // not arm the cancel.
                slideOffset = min(0, value.translation.width)
                cancelArmed = value.translation.width < -80
            }
            .onEnded { _ in endRecording() }
    }

    private func beginRecording() {
        micHeld = true
        cancelArmed = false
        slideOffset = 0
        isFocused = false
        Task { @MainActor in
            guard await recorder.requestPermission() else {
                micHeld = false
                toasts.error(
                    recorder.isPermissionDenied
                        ? "Microphone access is off. Turn it on in Settings › RX HIVE."
                        : "Microphone access is needed to record a voice message."
                )
                return
            }
            // The finger may already be back up — either because the prompt stole the
            // press, or because it was a stray tap.
            guard micHeld else { return }
            if !recorder.start() {
                micHeld = false
                toasts.error("Couldn't start recording. Try again.")
            }
        }
    }

    private func endRecording() {
        let armed = cancelArmed
        micHeld = false
        cancelArmed = false
        slideOffset = 0
        guard recorder.isRecording else { return }

        if armed {
            recorder.cancel()
            return
        }
        guard let result = recorder.stop() else {
            toasts.show("Hold to record, release to send")
            return
        }
        Task { @MainActor in await sendVoiceNote(url: result.url, duration: result.duration) }
    }

    @MainActor
    private func sendVoiceNote(url: URL, duration: TimeInterval) async {
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url) else {
            toasts.error("The recording could not be read.")
            return
        }
        // `.m4a` is load-bearing: the server classifies by extension, and this is the
        // extension that lands in its audio set. See AudioRecorder for the full note.
        let filename = "voice-\(Int(Date().timeIntervalSince1970)).m4a"
        enqueue(
            data: data,
            filename: filename,
            kind: .audio,
            caption: "",
            duration: (duration * 10).rounded() / 10,
            replyID: consumeReplyID()
        )
    }

    private var recordingBar: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Image(systemName: cancelArmed ? "trash.fill" : "mic.fill")
                .font(.system(size: 16))
                .foregroundStyle(Theme.Color.danger)
                .frame(width: 28)

            Text(MediaFormatting.clockLabel(recorder.elapsed))
                .font(Theme.Typography.font(size: 15, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(Theme.Color.text)

            RecordingWaveform(levels: recorder.levels)
                .frame(maxWidth: .infinity, alignment: .leading)
                .clipped()

            HStack(spacing: 2) {
                if !cancelArmed {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 10, weight: .semibold))
                }
                Text(cancelArmed ? "Release to cancel" : "Slide to cancel")
                    .font(Theme.Typography.caption)
            }
            .foregroundStyle(cancelArmed ? Theme.Color.danger : Theme.Color.textMuted)

            // A spacer the width of the mic button: the finger is still on that button,
            // which lives in the row this bar replaces.
            Color.clear.frame(width: Theme.Layout.minTouchTarget, height: 1)
        }
        .padding(.horizontal, Theme.Layout.spacing3)
        .padding(.vertical, Theme.Layout.spacing2)
        .frame(minHeight: Theme.Layout.minTouchTarget + Theme.Layout.spacing4)
        .offset(x: slideOffset / 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Recording, \(MediaFormatting.clockLabel(recorder.elapsed)). Slide left to cancel.")
    }

    // MARK: - Staging attachments

    /// Photos and videos from the system picker.
    @MainActor
    private func stage(pickerItems: [PhotosPickerItem]) async {
        for item in pickerItems {
            // Loaded as `Data` because `APIClient.upload` builds an in-memory multipart
            // body — there is no streaming upload path to hand a file URL to, so
            // materialising the bytes is not an extra cost, it is the same cost.
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                toasts.error("That item couldn't be read from your library.")
                continue
            }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let isVideo = type?.conforms(to: .movie) == true
            let stamp = Int(Date().timeIntervalSince1970)
            let name = "\(isVideo ? "VID" : "IMG")-\(stamp)-\(UUID().uuidString.prefix(4)).\(ext)"
            stage(data: data, filename: name)
        }
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            toasts.error(error.localizedDescription)
        case .success(let urls):
            for url in urls {
                // Picked files live outside the app container; without the scoped
                // access the read fails with a permission error.
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else {
                    toasts.error("\(url.lastPathComponent) couldn't be read.")
                    continue
                }
                stage(data: data, filename: url.lastPathComponent)
            }
        }
    }

    /// Validate, then queue an upload. The caption is whatever is in the box, which is
    /// then cleared — a picked photo with text already typed reads as one message.
    private func stage(data: Data, filename: String) {
        guard let candidate = validate(data: data, filename: filename) else { return }
        let caption = trimmedText
        if !caption.isEmpty {
            text = ""
            chat.stopTyping(in: conversationID)
        }
        enqueue(
            data: candidate.data,
            filename: candidate.filename,
            kind: candidate.kind,
            caption: caption,
            duration: nil,
            replyID: consumeReplyID()
        )
    }

    /// Enforce the server's own limits before spending the user's data allowance.
    ///
    /// Returns possibly-rewritten bytes: an iPhone photo is usually HEIC, which is not
    /// in the server's allowed image set, so it is transcoded to JPEG here rather than
    /// uploaded and rejected. The filename is rewritten to match, because the server
    /// derives the MIME type from the extension and ignores what we claim.
    private func validate(data: Data, filename: String) -> (data: Data, filename: String, kind: AttachmentKind)? {
        let ext = MediaFormatting.fileExtension(of: filename)

        guard let kind = AttachmentKind(fileExtension: ext) else {
            if let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) {
                let base = (filename as NSString).deletingPathExtension
                return validate(data: jpeg, filename: "\((base.isEmpty ? "IMG" : base)).jpg")
            }
            toasts.error("\(filename) isn't a file type this chat accepts.")
            return nil
        }

        if data.count > kind.maxBytes {
            // Name the actual limit: "too large" without a number leaves the user
            // guessing what would work.
            toasts.error("\(filename) is too large (max \(kind.limitLabel))")
            return nil
        }
        return (data, filename, kind)
    }

    // MARK: - Uploading

    /// One file on its way out.
    ///
    /// There is no byte-level progress: `APIClient.upload` awaits a single
    /// `URLSession.data(for:)` and exposes no progress callback, and inventing a second
    /// URLSession here would bypass its cookie, CSRF and refresh-and-replay handling.
    /// The row is therefore indeterminate, with a working cancel — which is the part
    /// that matters on a slow connection.
    fileprivate struct UploadJob: Identifiable {
        let id = UUID()
        let filename: String
        let kind: AttachmentKind
        var task: Task<Void, Never>?
    }

    private func enqueue(
        data: Data,
        filename: String,
        kind: AttachmentKind,
        caption: String,
        duration: Double?,
        replyID: String?
    ) {
        let job = UploadJob(filename: filename, kind: kind)
        uploads.append(job)

        let task = Task { @MainActor in
            await perform(
                data: data, filename: filename, kind: kind,
                caption: caption, duration: duration, replyID: replyID
            )
            uploads.removeAll { $0.id == job.id }
        }
        if let index = uploads.firstIndex(where: { $0.id == job.id }) {
            uploads[index].task = task
        }
    }

    @MainActor
    private func perform(
        data: Data,
        filename: String,
        kind: AttachmentKind,
        caption: String,
        duration: Double?,
        replyID: String?
    ) async {
        do {
            let result = try await RxHiveAPI.upload(
                data: data, filename: filename, mimeType: kind.mimeType(forFilename: filename)
            )
            guard !Task.isCancelled else { return }

            // A document with no caption carries its filename as content — that is what
            // the web client sends, and what the conversation-list preview reads.
            let content: String = {
                if !caption.isEmpty { return caption }
                return kind == .document ? result.filename : ""
            }()

            await chat.send(
                conversationID: conversationID,
                content: content,
                type: kind.messageType,
                replyTo: replyID,
                mediaURL: result.fileURL,
                duration: duration,
                thumbnailURL: result.thumbnailURL,
                fileSize: result.fileSize,
                filename: result.filename
            )
            onSent()
        } catch is CancellationError {
            // The user pulled it; the row is already gone.
        } catch {
            guard !Task.isCancelled else { return }
            toasts.failure(error, fallback: "\(filename) couldn't be sent")
        }
    }

    private func cancel(job: UploadJob) {
        job.task?.cancel()
        uploads.removeAll { $0.id == job.id }
    }

    // MARK: - Static configuration

    /// What the document picker will offer. Derived from the server's allow-list so
    /// the picker cannot surface a type the upload would reject.
    private static let documentContentTypes: [UTType] = {
        let types = AttachmentKind.documentExtensions
            .sorted()
            .compactMap { UTType(filenameExtension: $0) }
        return types.isEmpty ? [.data] : types
    }()
}

// MARK: - Attachment classification

/// The server's upload rules, transcribed.
///
/// Limits and extension sets come from `app/services/storage.py` (via the product
/// contract), and they are enforced client-side purely so a 200 MB video fails in
/// under a second instead of after a long upload.
private enum AttachmentKind {
    case image, video, audio, document

    static let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "gif", "webp"]
    static let videoExtensions: Set<String> = ["mp4", "mov", "webm", "m4v"]
    static let audioExtensions: Set<String> = ["mp3", "m4a", "wav", "ogg", "aac", "opus", "weba"]
    static let documentExtensions: Set<String> = [
        "pdf", "txt", "csv", "zip", "md", "json",
        "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf",
    ]

    init?(fileExtension ext: String) {
        let lowered = ext.lowercased()
        if Self.imageExtensions.contains(lowered) { self = .image }
        else if Self.videoExtensions.contains(lowered) { self = .video }
        else if Self.audioExtensions.contains(lowered) { self = .audio }
        else if Self.documentExtensions.contains(lowered) { self = .document }
        else { return nil }
    }

    var maxBytes: Int {
        switch self {
        case .image: return 16 * 1024 * 1024
        case .video, .audio: return 200 * 1024 * 1024
        case .document: return 100 * 1024 * 1024
        }
    }

    var limitLabel: String {
        switch self {
        case .image: return "16 MB"
        case .video, .audio: return "200 MB"
        case .document: return "100 MB"
        }
    }

    /// The message `type` the API and the bubbles expect. Note "document" maps to
    /// "file" — the upload service and the message contract disagree on the word.
    var messageType: String {
        switch self {
        case .image: return "image"
        case .video: return "video"
        case .audio: return "audio"
        case .document: return "file"
        }
    }

    /// Best-effort Content-Type for the multipart part. The server derives the real
    /// one from the extension and ignores this, but sending `application/octet-stream`
    /// for everything would make the request harder to read in a proxy log.
    func mimeType(forFilename filename: String) -> String {
        let ext = MediaFormatting.fileExtension(of: filename)
        if let type = UTType(filenameExtension: ext)?.preferredMIMEType { return type }
        switch self {
        case .image: return "image/jpeg"
        case .video: return "video/mp4"
        case .audio: return "audio/mp4"
        case .document: return "application/octet-stream"
        }
    }

    var glyph: String {
        switch self {
        case .image: return "photo"
        case .video: return "film"
        case .audio: return "waveform"
        case .document: return "doc"
        }
    }
}

// MARK: - Sub-views

/// The quoted message above the field, with the emerald leading rule the web app
/// uses on reply previews.
private struct ReplyStrip: View {
    let message: Message
    let onCancel: () -> Void

    private var snippet: String {
        if message.isDeleted { return "This message was deleted" }
        switch message.type {
        case .image: return message.content.isEmpty ? "Photo" : message.content
        case .video: return message.content.isEmpty ? "Video" : message.content
        case .audio: return "Voice message"
        case .file: return message.filename ?? (message.content.isEmpty ? "File" : message.content)
        default: return message.content
        }
    }

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Theme.Color.primary)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 1) {
                Text(message.senderName)
                    .font(Theme.Typography.font(size: 13, weight: .medium))
                    .foregroundStyle(Theme.Color.primary)
                Text(snippet)
                    // Tombstones render in muted italic everywhere in this app.
                    .font(message.isDeleted ? Theme.Typography.caption.italic() : Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
            }
            .accessibilityLabel("Cancel reply")
        }
        .padding(.leading, Theme.Layout.spacing4)
        .padding(.trailing, Theme.Layout.spacing1)
        .padding(.vertical, Theme.Layout.spacing2)
        .frame(height: 56)
        .background(Theme.Color.surface)
    }
}

/// One in-flight upload, with a cancel.
private struct UploadRow: View {
    let job: MessageComposer.UploadJob
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Image(systemName: job.kind.glyph)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Color.primary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 4) {
                Text(job.filename)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                IndeterminateBar()
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(width: 32, height: 32)
            }
            .accessibilityLabel("Cancel upload of \(job.filename)")
        }
        .padding(.leading, Theme.Layout.spacing4)
        .padding(.trailing, Theme.Layout.spacing2)
        .padding(.vertical, Theme.Layout.spacing2)
        .background(Theme.Color.surface)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Sending \(job.filename)")
    }
}

/// A sliding emerald sliver. Honest about not knowing the percentage — see
/// `MessageComposer.UploadJob`.
private struct IndeterminateBar: View {
    /// Fraction of the track the sliver's leading edge sits at: starts fully off the
    /// left, ends fully off the right.
    @State private var phase: CGFloat = -0.35

    var body: some View {
        GeometryReader { geo in
            Capsule()
                .fill(Theme.Color.border2)
                .frame(height: 3)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Theme.Color.primary)
                        .frame(width: geo.size.width * 0.35, height: 3)
                        .offset(x: geo.size.width * phase)
                }
                .clipShape(Capsule())
        }
        .frame(height: 3)
        .onAppear {
            withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                phase = 1
            }
        }
    }
}

/// The live level meter shown while recording. Newest sample on the right, so the
/// bars read as travelling toward the mic the finger is on.
private struct RecordingWaveform: View {
    let levels: [Float]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(levels.indices, id: \.self) { index in
                Capsule()
                    .fill(Theme.Color.danger.opacity(0.85))
                    .frame(width: 2, height: max(3, CGFloat(levels[index]) * 22))
            }
        }
        .frame(height: 24, alignment: .center)
    }
}

// MARK: - Camera

/// `UIImagePickerController` for a one-shot capture.
///
/// Not `PhotosPicker`, which cannot open the camera, and not `AVCaptureSession`, which
/// would mean building a capture UI to replace one iOS already ships. Photos come back
/// as JPEG and movies as the recorder's `.mov`, both of which the server accepts.
private struct CameraCapture: UIViewControllerRepresentable {
    /// nil data means the user cancelled.
    let onCapture: (Data?, String?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        // Guard against the simulator and any device without a camera: without this
        // the controller presents an empty black sheet.
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoQuality = .typeHigh
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onCapture: (Data?, String?) -> Void

        init(onCapture: @escaping (Data?, String?) -> Void) {
            self.onCapture = onCapture
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            let stamp = Int(Date().timeIntervalSince1970)
            if let movieURL = info[.mediaURL] as? URL, let data = try? Data(contentsOf: movieURL) {
                onCapture(data, "VID-\(stamp).\(movieURL.pathExtension.isEmpty ? "mov" : movieURL.pathExtension)")
                return
            }
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
                onCapture(data, "IMG-\(stamp).jpg")
                return
            }
            onCapture(nil, nil)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCapture(nil, nil)
        }
    }
}
