import SwiftUI

/// The editor's controls.
///
/// All hand-built, because the app has no `Slider` and no `ColorPicker` anywhere —
/// and deliberately so: `MediaAttachmentViews.ScrubbableWaveform` is the house
/// pattern for "drag along a track", a `GeometryReader` plus a
/// `DragGesture(minimumDistance: 0)` that maps the touch's x or y into 0…1. These
/// follow it, so a pen-width strip and a colour strip behave like the audio scrubber
/// the user has already used.
///
/// Every colour comes from `Theme` or from `EditorInk`; there are no raw hex literals
/// outside `Theme.swift` anywhere in this app and these do not add any.

// MARK: - Buttons

/// A 40pt circular tool button, matching `ImageViewer`'s chrome buttons.
struct EditorCircleButton: View {
    let symbol: String
    let label: String
    var isActive = false
    var isEnabled = true
    var isDestructive = false
    var size: CGFloat = 15
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(foreground)
                .frame(width: 40, height: 40)
                .background(Circle().fill(background))
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
    }

    private var foreground: Color {
        if isActive { return Theme.Color.onPrimary }
        return isDestructive ? Theme.Color.danger : .white
    }

    private var background: Color {
        isActive ? Theme.Color.primary : .white.opacity(0.16)
    }
}

/// A small text pill — aspect presets, the colour target, Reset.
struct EditorChip: View {
    let label: String
    var isActive = false
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(Theme.Typography.micro)
                .foregroundStyle(isActive ? Theme.Color.primary : Theme.Color.textMuted)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(isActive ? Theme.Color.primary.opacity(0.20) : Color.white.opacity(0.12))
                        .overlay(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .stroke(isActive ? Theme.Color.primary.opacity(0.4) : .clear, lineWidth: 1)
                        )
                )
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Pen widths

/// Four discrete widths, shown as four dots.
///
/// The house idiom for a small set of values is one cycling control (the audio
/// player's playback speed). Four pens are shown side by side instead, because a pen
/// width is something the user compares — "is that thick enough?" is answered by
/// seeing the alternatives, not by tapping through them — and because it is what the
/// reference app does.
struct EditorPenSizeRow: View {
    @Binding var selection: PenSize
    let inkHex: String

    var body: some View {
        HStack(spacing: 6) {
            ForEach(PenSize.allCases) { pen in
                Button {
                    selection = pen
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } label: {
                    Circle()
                        .fill(EditorInk.color(inkHex))
                        .frame(width: pen.dot, height: pen.dot)
                        // A white pen on a translucent white chip needs an edge to be
                        // visible at all.
                        .overlay(Circle().stroke(.black.opacity(0.45), lineWidth: 1))
                        .frame(width: 40, height: 40)
                        .background(
                            Circle()
                                .fill(selection == pen ? Color.white.opacity(0.26) : Color.white.opacity(0.12))
                                .overlay(
                                    Circle().stroke(selection == pen ? .white.opacity(0.7) : .clear, lineWidth: 1)
                                )
                        )
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("\(pen.title) pen")
                .accessibilityAddTraits(selection == pen ? [.isButton, .isSelected] : .isButton)
            }
        }
    }
}

// MARK: - Colour

/// The ten quick colours, for when the strip is more precision than anyone wants.
struct EditorSwatchRow: View {
    let selected: String
    let onPick: (String) -> Void

    var body: some View {
        HStack(spacing: 8) {
            ForEach(EditorInk.swatches, id: \.self) { hex in
                let isActive = hex.caseInsensitiveCompare(selected) == .orderedSame
                Button {
                    onPick(hex)
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } label: {
                    Circle()
                        .fill(EditorInk.color(hex))
                        .frame(width: 26, height: 26)
                        .overlay(
                            Circle().stroke(isActive ? .white : .white.opacity(0.3), lineWidth: isActive ? 2.5 : 1)
                        )
                        .scaleEffect(isActive ? 1.12 : 1)
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Colour \(hex)")
                .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
            }
        }
        .animation(Theme.Motion.ease, value: selected)
    }
}

/// The vertical colour strip.
///
/// White at the top through black, then a hue ramp — the arrangement the reference
/// uses. The grey band has to exist: white and black are the two most-used
/// annotation colours and a pure-hue strip can reach neither. The gradient and the
/// position→colour function both come from `EditorInk`, so the strip cannot drift
/// from the colour it hands back.
struct EditorColorStrip: View {
    let selected: String
    let onPick: (String) -> Void

    private var position: CGFloat { EditorInk.position(forInk: selected) }

    var body: some View {
        GeometryReader { geo in
            let height = max(1, geo.size.height)
            Capsule()
                .fill(LinearGradient(stops: EditorInk.gradientStops(), startPoint: .top, endPoint: .bottom))
                .overlay(Capsule().stroke(.white.opacity(0.28), lineWidth: 1))
                .overlay(alignment: .top) {
                    // The thumb wears the colour it has selected, so the control
                    // answers "what am I drawing with?" without a second swatch
                    // somewhere else on screen.
                    Circle()
                        .fill(EditorInk.color(selected))
                        .frame(width: 26, height: 26)
                        .overlay(Circle().stroke(.white, lineWidth: 2))
                        .shadow(color: .black.opacity(0.6), radius: 4, y: 2)
                        .offset(y: position * height - 13)
                        .animation(Theme.Motion.ease, value: selected)
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            onPick(EditorInk.ink(atPosition: min(1, max(0, value.location.y / height))))
                        }
                )
        }
        .frame(width: 28)
        .accessibilityElement()
        .accessibilityLabel("Pen colour")
        .accessibilityValue(selected)
        .accessibilityAdjustableAction { direction in
            let step: CGFloat = direction == .increment ? 0.04 : -0.04
            onPick(EditorInk.ink(atPosition: min(1, max(0, position + step))))
        }
    }
}

// MARK: - Value slider

/// Horizontal sibling of the colour strip, for the two independent size controls a
/// text box has: how big the glyphs are, and how wide the box wraps.
struct EditorValueSlider: View {
    let label: String
    let value: CGFloat
    let range: ClosedRange<CGFloat>
    let format: (CGFloat) -> String
    let onChange: (CGFloat) -> Void

    private var fraction: CGFloat {
        let span = range.upperBound - range.lowerBound
        guard span > 0 else { return 0 }
        return min(1, max(0, (value - range.lowerBound) / span))
    }

    var body: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            Text(label)
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.textMuted)
                .frame(width: 64, alignment: .leading)

            GeometryReader { geo in
                let width = max(1, geo.size.width)
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.22)).frame(height: 4)
                    Capsule().fill(Theme.Color.primary).frame(width: fraction * width, height: 4)
                    Circle()
                        .fill(.white)
                        .frame(width: 18, height: 18)
                        .shadow(color: .black.opacity(0.6), radius: 3, y: 1)
                        .offset(x: fraction * width - 9)
                }
                .frame(height: geo.size.height)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { drag in
                            let t = min(1, max(0, drag.location.x / width))
                            onChange(range.lowerBound + t * (range.upperBound - range.lowerBound))
                        }
                )
            }
            .frame(height: 30)

            Text(format(value))
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.textMuted)
                .monospacedDigit()
                .frame(width: 34, alignment: .trailing)
        }
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityValue(format(value))
        .accessibilityAdjustableAction { direction in
            let span = range.upperBound - range.lowerBound
            let step = (direction == .increment ? 1 : -1) * span * 0.05
            onChange(min(range.upperBound, max(range.lowerBound, value + step)))
        }
    }
}

// MARK: - Safe area

/// The key window's insets, with a sane floor.
///
/// SwiftUI reports ZERO safe-area insets inside this app's full-screen covers:
/// `RootView` wraps everything in a `ZStack` whose background calls
/// `ignoresSafeArea()`, which expands the stack and zeroes the safe area for every
/// descendant — including a `fullScreenCover` presented from one. `safeAreaInset` and
/// `GeometryReader.safeAreaInsets` both inherit the same zero, so a plain `VStack`
/// puts the close button on top of the clock. The window's own insets are the one
/// source that hierarchy cannot flatten.
///
/// Read once and cached: they do not change for a portrait-locked screen, and reading
/// them per layout pass would be a UIKit hop on every frame. Lifted from
/// `MediaSendSheet`, which has the same problem and the same fix.
enum EditorInsets {
    static let window: UIEdgeInsets = {
        let found = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .safeAreaInsets
        guard let found else { return UIEdgeInsets(top: 48, left: 0, bottom: 24, right: 0) }
        return UIEdgeInsets(
            top: max(found.top, 20), left: found.left,
            bottom: max(found.bottom, 12), right: found.right
        )
    }()
}
