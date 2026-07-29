import SwiftUI

/// Every call surface, mounted once at the root above the whole app.
///
/// This sits in `RootView`'s `ZStack` rather than inside any navigation container,
/// for the same reason `App.jsx` mounts the web overlays outside its router: a call
/// has to survive navigating anywhere, and a screen that lives inside a
/// `NavigationStack` is destroyed the moment the user pops it. Nothing is rendered
/// at all when there is no call, so the overlay costs one `EmptyView` in the common
/// case.
struct CallOverlayHost: View {

    @EnvironmentObject private var calls: CallStore

    /// Where the minimised window sits. Persisted, so the corner the user dragged
    /// it to survives a relaunch and the next call — that is a preference, not call
    /// state, which is why `CallStore` does not reset it. Negative means "unset".
    @AppStorage("rxhive_mini_call_x") private var storedX: Double = -1
    @AppStorage("rxhive_mini_call_y") private var storedY: Double = -1

    @State private var dragTranslation: CGSize = .zero

    /// Margin the minimised window keeps from every edge.
    private let edgeInset: CGFloat = 12

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                content(in: geometry.size)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .animation(Theme.Motion.easeSlow, value: calls.phase)
        .animation(Theme.Motion.ease, value: calls.isMinimised)
    }

    // MARK: - Layers

    @ViewBuilder
    private func content(in size: CGSize) -> some View {
        switch calls.phase {
        case .idle:
            EmptyView()

        case .incoming:
            if calls.isConnecting {
                // Answered — the ring is over and this is a call being set up.
                liveLayer(in: size)
            } else {
                // Deliberately not minimisable: a ringing call the user cannot see
                // is a missed call.
                IncomingCallView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
            }

        case .outgoing, .active, .ended:
            liveLayer(in: size)
        }
    }

    @ViewBuilder
    private func liveLayer(in size: CGSize) -> some View {
        if calls.isMinimised && calls.hasLiveCall {
            minimised(in: size)
        } else if isRingingOut {
            OutgoingCallView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.opacity)
        } else {
            ActiveCallView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.opacity)
        }
    }

    private var isRingingOut: Bool {
        guard case .outgoing = calls.phase else { return false }
        return !calls.isConnecting
    }

    // MARK: - Minimised window

    private func minimised(in size: CGSize) -> some View {
        let pill = pillSize
        let anchor = anchorPoint(in: size, pill: pill)
        let position = clamp(
            CGPoint(x: anchor.x + dragTranslation.width, y: anchor.y + dragTranslation.height),
            in: size,
            pill: pill
        )

        return MinimisedCallPill()
            .frame(width: pill.width)
            .offset(x: position.x, y: position.y)
            .gesture(
                // A minimum distance so the tap that restores the call is not
                // swallowed by the drag recogniser.
                DragGesture(minimumDistance: 8)
                    .onChanged { dragTranslation = $0.translation }
                    .onEnded { value in
                        let settled = clamp(
                            CGPoint(x: anchor.x + value.translation.width, y: anchor.y + value.translation.height),
                            in: size,
                            pill: pill
                        )
                        storedX = settled.x
                        storedY = settled.y
                        dragTranslation = .zero
                    }
            )
            .transition(.scale(scale: 0.9).combined(with: .opacity))
    }

    /// The pill's two shapes, kept in sync with `MinimisedCallPill` — the clamp box
    /// needs real numbers, and there is nothing to measure before the first layout.
    private var pillSize: CGSize {
        calls.isVideoCall ? CGSize(width: 132, height: 190) : CGSize(width: 200, height: 82)
    }

    /// Stored corner, or the default: bottom-trailing, lifted clear of a tab bar.
    private func anchorPoint(in size: CGSize, pill: CGSize) -> CGPoint {
        guard storedX >= 0, storedY >= 0 else {
            return CGPoint(
                x: max(edgeInset, size.width - pill.width - edgeInset),
                y: max(edgeInset, size.height - pill.height - 96)
            )
        }
        // Clamped on read as well as on write: a rotation or a different device
        // could otherwise restore the window off-screen with no way to reach it.
        return clamp(CGPoint(x: storedX, y: storedY), in: size, pill: pill)
    }

    private func clamp(_ point: CGPoint, in size: CGSize, pill: CGSize) -> CGPoint {
        let maxX = max(edgeInset, size.width - pill.width - edgeInset)
        let maxY = max(edgeInset, size.height - pill.height - edgeInset)
        return CGPoint(
            x: min(max(edgeInset, point.x), maxX),
            y: min(max(edgeInset, point.y), maxY)
        )
    }
}
