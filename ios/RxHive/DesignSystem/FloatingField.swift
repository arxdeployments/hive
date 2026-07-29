import SwiftUI

/// The floating-label text field, ported from `components/common/FloatingInput.jsx`.
///
/// Same behaviour: the label sits centred as a placeholder until the field is
/// focused or non-empty, then shrinks to the top-left and turns emerald (or red on
/// error). Same 52pt height, same 6pt radius, same 3pt emerald focus ring.
struct FloatingField: View {
    let label: String
    @Binding var text: String
    var isSecure = false
    var hasError = false
    var isDisabled = false
    var textContentType: UITextContentType?
    var keyboardType: UIKeyboardType = .default
    var submitLabel: SubmitLabel = .next
    var onSubmit: () -> Void = {}

    @FocusState private var focused: Bool
    @State private var revealed = false

    private var isRaised: Bool { focused || !text.isEmpty }

    private var borderColor: Color {
        if hasError { return Theme.Color.danger }
        return focused ? Theme.Color.primary : Theme.Color.border2
    }

    var body: some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                .fill(Theme.Color.surface2)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                        .stroke(borderColor, lineWidth: 1)
                )
                // `shadow-[0_0_0_3px_rgba(16,185,129,0.25)]` — a ring, not a blur,
                // so it is drawn as a second stroke rather than a shadow.
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                        .stroke(Theme.Color.focusRing, lineWidth: 3)
                        .opacity(focused && !hasError ? 1 : 0)
                )

            HStack(spacing: 0) {
                ZStack(alignment: .leading) {
                    Text(label)
                        .font(isRaised ? Theme.Typography.micro : Theme.Typography.subheadline)
                        .foregroundStyle(
                            isRaised
                                ? (hasError ? Theme.Color.danger : Theme.Color.primary)
                                : Theme.Color.textMuted
                        )
                        .offset(y: isRaised ? -14 : 0)
                        .allowsHitTesting(false)

                    field
                        .offset(y: 8)
                }

                if isSecure {
                    Button {
                        revealed.toggle()
                    } label: {
                        Image(systemName: revealed ? "eye.slash" : "eye")
                            .font(.system(size: 17))
                            .foregroundStyle(Theme.Color.textMuted)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    // Keeps the reveal button out of the keyboard's Next/Done path.
                    .accessibilityLabel(revealed ? "Hide password" : "Show password")
                }
            }
            .padding(.leading, Theme.Layout.spacing4)
            .padding(.trailing, isSecure ? 0 : Theme.Layout.spacing4)
        }
        .frame(height: 52)
        .opacity(isDisabled ? 0.5 : 1)
        .animation(Theme.Motion.ease, value: isRaised)
        .animation(Theme.Motion.ease, value: hasError)
        .onTapGesture { if !isDisabled { focused = true } }
    }

    @ViewBuilder
    private var field: some View {
        Group {
            if isSecure && !revealed {
                SecureField("", text: $text)
            } else {
                TextField("", text: $text)
            }
        }
        .font(Theme.Typography.subheadline)
        .foregroundStyle(Theme.Color.text)
        .tint(Theme.Color.primary)
        .focused($focused)
        .disabled(isDisabled)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .textContentType(textContentType)
        .keyboardType(keyboardType)
        .submitLabel(submitLabel)
        .onSubmit(onSubmit)
    }
}
