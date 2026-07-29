import SwiftUI

/// The app's transient feedback, matching the web app's `sonner` configuration in
/// `App.jsx`: 2-second duration, at most two visible at once, 8pt gap, dismissible,
/// on `--rx-surface` with a `--rx-border` hairline.
///
/// Two visible at once is not arbitrary — the web app caps it because rapid
/// mute/unmute toggles used to stack toasts over the content underneath.
@MainActor
final class ToastCenter: ObservableObject {

    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let message: String
        let kind: Kind

        enum Kind { case info, success, error, warning }
    }

    /// Newest last. Capped at `maxVisible`.
    @Published private(set) var toasts: [Toast] = []

    private let maxVisible = 2
    private let duration: Duration = .seconds(2)

    func show(_ message: String, kind: Toast.Kind = .info) {
        // Collapse an identical consecutive toast rather than stacking two of them.
        if toasts.last?.message == message { return }
        let toast = Toast(message: message, kind: kind)
        toasts.append(toast)
        if toasts.count > maxVisible { toasts.removeFirst(toasts.count - maxVisible) }
        Task { [weak self] in
            try? await Task.sleep(for: self?.duration ?? .seconds(2))
            self?.dismiss(toast.id)
        }
    }

    func success(_ message: String) { show(message, kind: .success) }
    func error(_ message: String) { show(message, kind: .error) }
    func warning(_ message: String) { show(message, kind: .warning) }

    /// Convenience for the very common `catch` block.
    func failure(_ error: Error, fallback: String = "Something went wrong") {
        if let apiError = error as? APIError {
            show(apiError.userMessage, kind: .error)
        } else {
            show(fallback, kind: .error)
        }
    }

    func dismiss(_ id: UUID) {
        toasts.removeAll { $0.id == id }
    }
}

/// Renders the toast stack. Mounted once, at the root, above every screen.
struct ToastHost: View {
    @EnvironmentObject private var center: ToastCenter

    var body: some View {
        VStack(spacing: Theme.Layout.spacing2) {
            ForEach(center.toasts) { toast in
                ToastRow(toast: toast) { center.dismiss(toast.id) }
                    .transition(
                        .asymmetric(
                            insertion: .move(edge: .top).combined(with: .opacity),
                            removal: .opacity
                        )
                    )
            }
            Spacer()
        }
        .padding(.horizontal, Theme.Layout.gutter)
        // Below the status bar / notch rather than over it.
        .padding(.top, Theme.Layout.spacing2)
        .animation(Theme.Motion.ease, value: center.toasts)
        .allowsHitTesting(!center.toasts.isEmpty)
    }
}

private struct ToastRow: View {
    let toast: ToastCenter.Toast
    let onDismiss: () -> Void

    private var accent: Color {
        switch toast.kind {
        case .info: return Theme.Color.textMuted
        case .success: return Theme.Color.primary
        case .error: return Theme.Color.danger
        case .warning: return Theme.Color.warning
        }
    }

    private var icon: String {
        switch toast.kind {
        case .info: return "info.circle"
        case .success: return "checkmark.circle"
        case .error: return "exclamationmark.triangle"
        case .warning: return "exclamationmark.circle"
        }
    }

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(accent)

            Text(toast.message)
                .font(Theme.Typography.subheadline)
                .foregroundStyle(Theme.Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Always-visible dismiss, matching the web app's deliberate override of
            // sonner's hover-only close button: an affordance you have to discover
            // by hovering isn't one, and on touch there is no hover at all.
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(width: 28, height: 28)
                    .background(
                        Circle()
                            .fill(Theme.Color.border)
                            .overlay(Circle().stroke(Theme.Color.border2, lineWidth: 1))
                    )
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.vertical, Theme.Layout.spacing3)
        .padding(.horizontal, Theme.Layout.spacing4)
        .background(
            RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                .fill(Theme.Color.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                        .stroke(Theme.Color.border, lineWidth: 1)
                )
        )
        .shadow(color: Theme.Shadow.card.color, radius: Theme.Shadow.card.radius, y: Theme.Shadow.card.y)
    }
}
