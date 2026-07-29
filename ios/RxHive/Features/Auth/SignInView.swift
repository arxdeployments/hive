import SwiftUI

/// The sign-in screen — where the app opens after the splash, per spec.
///
/// A port of `pages/Login.jsx`: same ambient emerald glows, same card on
/// `--rx-surface` with a `--rx-border` hairline, same wordmark with its emerald
/// shadow, same 46px-tall emerald button that dims when the form is incomplete.
/// The mobile changes are the ones a phone forces: the card is width-constrained
/// rather than centred in a viewport, the fields are 52pt with 44pt hit targets,
/// and the whole thing lifts clear of the keyboard.
struct SignInView: View {
    @EnvironmentObject private var auth: AuthStore

    @State private var email = ""
    @State private var password = ""
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    private var canSubmit: Bool {
        !email.trimmed.isEmpty && !password.isEmpty && !auth.isSigningIn
    }

    var body: some View {
        ZStack {
            Theme.Color.bg.ignoresSafeArea()
            AmbientGlow().opacity(0.6).ignoresSafeArea()
            // `Login.jsx` lays a 40%-opacity background over the gradients to keep
            // the card readable against them.
            Theme.Color.bg.opacity(0.4).ignoresSafeArea()

            ScrollView {
                VStack {
                    Spacer(minLength: Theme.Layout.spacing8)
                    card
                    Spacer(minLength: Theme.Layout.spacing8)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Theme.Layout.gutter)
                // Room for the keyboard without the card jumping under it.
                .padding(.bottom, Theme.Layout.spacing8)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
        }
        .preferredColorScheme(.dark)
    }

    private var card: some View {
        VStack(spacing: 0) {
            // Wordmark
            VStack(spacing: 6) {
                Text("RxHive")
                    .font(Theme.Typography.display)
                    .foregroundStyle(Theme.Color.text)
                    .shadow(color: Theme.Color.primary.opacity(0.3), radius: 20)
                Text("Enterprise Messaging")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.textMuted)
            }
            .padding(.bottom, Theme.Layout.spacing8)

            VStack(spacing: Theme.Layout.spacing5) {
                FloatingField(
                    label: "Email",
                    text: $email,
                    hasError: auth.signInError != nil,
                    isDisabled: auth.isSigningIn,
                    textContentType: .username,
                    keyboardType: .emailAddress,
                    submitLabel: .next,
                    onSubmit: { focusedField = .password }
                )

                FloatingField(
                    label: "Password",
                    text: $password,
                    isSecure: true,
                    hasError: auth.signInError != nil,
                    isDisabled: auth.isSigningIn,
                    textContentType: .password,
                    submitLabel: .go,
                    onSubmit: submit
                )

                if let error = auth.signInError {
                    Text(error)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                submitButton
            }
        }
        .padding(Theme.Layout.spacing6)
        .background(
            RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                .fill(Theme.Color.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                        .stroke(Theme.Color.border, lineWidth: 1)
                )
        )
        .shadow(
            color: Theme.Shadow.modal.color,
            radius: Theme.Shadow.modal.radius,
            y: Theme.Shadow.modal.y
        )
        .frame(maxWidth: 420)
        .animation(Theme.Motion.ease, value: auth.signInError)
    }

    private var submitButton: some View {
        Button(action: submit) {
            ZStack {
                if auth.isSigningIn {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(Theme.Color.onPrimary)
                } else {
                    Text("Sign In")
                        .font(Theme.Typography.font(size: 16, weight: .medium))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .foregroundStyle(
                canSubmit ? Theme.Color.onPrimary : Theme.Color.onPrimary.opacity(0.7)
            )
            .background(
                RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                    .fill(canSubmit ? Theme.Color.primary : Theme.Color.primary.opacity(0.5))
            )
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!canSubmit)
    }

    private func submit() {
        guard canSubmit else { return }
        focusedField = nil
        Task { await auth.signIn(email: email, password: password) }
    }
}

/// `hover:scale-[1.02] active:scale-[0.98]` from the web button, minus the hover
/// half that a touch screen has no equivalent for.
struct PressScaleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(Theme.Motion.ease, value: configuration.isPressed)
    }
}
