import SwiftUI

/// The only screen while an administrator-reset password has to be replaced
/// (`AuthStore.Phase.passwordChangeRequired`, batch 73).
///
/// The admin who reset the password was shown it, so until its owner picks a new
/// one the server refuses every route but changing it. This screen is the way
/// out, and the copy has to say where the temporary password came from: a user
/// who signed in with it successfully and is then asked for it again will
/// otherwise assume something is broken and try their old password.
///
/// No `Avatar`: `AuthenticatedImage` loads from `/api/media`, one of the routes the
/// server is now refusing, and nothing session-scoped may load while the account
/// is held. The account is identified by its email, as plain text.
struct ForcedPasswordChangeView: View {
    @EnvironmentObject private var auth: AuthStore

    /// The held account's email, shown as plain text in place of an avatar.
    let email: String

    @State private var current = ""
    @State private var new = ""
    @State private var confirmation = ""

    /// The form's first local problem, as `PasswordPolicy` ranks them.
    private var problem: PasswordPolicy.Problem? {
        PasswordPolicy.problem(current: current, new: new, confirmation: confirmation)
    }

    /// Not while signing out either (batch 73 review): Sign Out waits for a change
    /// already in flight, and the form stays up meanwhile, but nothing would wait
    /// for one started after it. `AuthStore` refuses it too; this only dims the button.
    private var canSubmit: Bool {
        problem == nil && !auth.isChangingPassword && !auth.isSigningOut
    }

    /// The server's answer wins over the local check: it is about what was actually
    /// submitted. An incomplete form is not nagged about — the dimmed button says it.
    private var message: String? {
        if let error = auth.passwordChangeError { return error }
        guard let problem, problem != .incomplete else { return nil }
        return problem.message
    }

    /// The card centred on the brand background, scrolling once the keyboard needs
    /// the room.
    var body: some View {
        ZStack {
            Theme.Color.bg.ignoresSafeArea()
            AmbientGlow().opacity(0.35).ignoresSafeArea()

            ScrollView {
                VStack {
                    Spacer(minLength: Theme.Layout.spacing8)
                    card
                    Spacer(minLength: Theme.Layout.spacing8)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.bottom, Theme.Layout.spacing8)
                // Centres the card while it fits and still scrolls once the keyboard
                // takes the room — the same arrangement as `SignInView`.
                .containerRelativeFrame(.vertical, alignment: .center)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
        }
        .preferredColorScheme(.dark)
        .animation(Theme.Motion.ease, value: message)
    }

    /// The explanation, the account's email, the three password fields with the
    /// current message, the policy caption, and the Change Password and Sign Out buttons.
    private var card: some View {
        VStack(spacing: Theme.Layout.spacing5) {
            VStack(spacing: Theme.Layout.spacing3) {
                Image(systemName: "key")
                    .font(.system(size: 40, weight: .light))
                    .foregroundStyle(Theme.Color.warning)
                    .padding(.bottom, Theme.Layout.spacing1)

                Text("Choose a new password")
                    .font(Theme.Typography.title)
                    .foregroundStyle(Theme.Color.text)
                    .multilineTextAlignment(.center)

                Text(
                    "Your administrator reset the password for this account. The temporary "
                    + "password they gave you can only be used to set a new one — choose a "
                    + "password only you know to continue."
                )
                .font(Theme.Typography.subheadline)
                .foregroundStyle(Theme.Color.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

                Text(email)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.text)
                    .textSelection(.enabled)
            }

            VStack(spacing: Theme.Layout.spacing4) {
                FloatingField(
                    label: "Temporary password",
                    text: $current,
                    isSecure: true,
                    hasError: auth.passwordChangeError == AuthCopy.temporaryPasswordWrong,
                    isDisabled: auth.isChangingPassword,
                    textContentType: .password
                )

                FloatingField(
                    label: "New password",
                    text: $new,
                    isSecure: true,
                    hasError: problem.map { $0 != .incomplete && $0 != .mismatch } ?? false,
                    isDisabled: auth.isChangingPassword,
                    textContentType: .newPassword
                )

                FloatingField(
                    label: "Confirm new password",
                    text: $confirmation,
                    isSecure: true,
                    hasError: problem == .mismatch,
                    isDisabled: auth.isChangingPassword,
                    textContentType: .newPassword,
                    submitLabel: .done,
                    onSubmit: submit
                )

                if let message {
                    HStack(alignment: .top, spacing: Theme.Layout.spacing2) {
                        Image(systemName: "exclamationmark.circle")
                            .font(.system(size: 13))
                        Text(message)
                            .font(Theme.Typography.caption)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(Theme.Color.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                Text(PasswordPolicy.requirements)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)

                PrimaryButton(
                    title: "Change Password",
                    isLoading: auth.isChangingPassword,
                    isEnabled: canSubmit,
                    action: submit
                )
                .padding(.top, Theme.Layout.spacing1)

                // Always available, even mid-request: a phone handed back to the
                // wrong person, or a temporary password nobody can find, must not
                // leave this screen as the only thing the app can show. Mid-request,
                // `signOut` waits for the change to be answered before it logs out
                // (batch 73 review), so whatever session the server issued with that
                // answer is the one revoked and cleared.
                SecondaryButton(title: "Sign Out", tint: Theme.Color.textMuted) {
                    Task { await auth.signOut() }
                }
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
    }

    /// Hand the temporary and new passwords to `AuthStore`, if the form allows a
    /// submit right now.
    private func submit() {
        guard canSubmit else { return }
        Task { await auth.completeRequiredPasswordChange(current: current, new: new) }
    }
}

/// The server's password rules (`core/security.py:enforce_password_policy`),
/// checked on the device so a typo costs no round trip.
///
/// The server stays authoritative and its 400 is shown verbatim: the minimum
/// length is configuration (`RXHIVE_PASSWORD_MIN_LENGTH`), so the number below is
/// only the default, and only the server's sentence is guaranteed to carry the
/// real one. Each rule is measured the way the server measures it — Python's
/// `len` counts code points, so the length here is `unicodeScalars.count` rather
/// than Swift's grapheme count, and "a letter" is `[A-Za-z]`, so an accented
/// letter alone does not pass here and then fail there.
enum PasswordPolicy {
    /// `settings.password_min_length`'s default.
    static let minimumLength = 10
    /// `BCRYPT_MAX_PASSWORD_BYTES`. Rejected by the server rather than truncated.
    static let maximumBytes = 72

    /// The one-line summary of the rules shown under the password fields.
    static let requirements =
        "At least \(minimumLength) characters, with letters and numbers."

    /// What stands between the form and a submit. Ordered so the user hears about
    /// the new password itself while typing it, before being told to fill the rest.
    enum Problem: Equatable {
        case tooShort, tooLong, needsLetterAndDigit, incomplete, mismatch, sameAsCurrent

        /// The sentence shown for this problem under the form.
        var message: String {
            switch self {
            case .tooShort: return "New password must be at least \(PasswordPolicy.minimumLength) characters."
            case .tooLong: return "New password is too long."
            case .needsLetterAndDigit: return "New password must contain both letters and numbers."
            case .incomplete: return "Fill in all three fields."
            case .mismatch: return "New passwords don't match."
            // The server refuses this too ("Choose a password different from your
            // current one."); said here in this screen's own words.
            case .sameAsCurrent: return "Choose a password different from your temporary one."
            }
        }
    }

    /// The first problem with the form, or nil when it can be submitted.
    static func problem(current: String, new: String, confirmation: String) -> Problem? {
        if !new.isEmpty {
            if new.unicodeScalars.count < minimumLength { return .tooShort }
            if new.utf8.count > maximumBytes { return .tooLong }
            let hasLetter = new.unicodeScalars.contains { ("a"..."z").contains($0) || ("A"..."Z").contains($0) }
            let hasDigit = new.rangeOfCharacter(from: .decimalDigits) != nil
            if !hasLetter || !hasDigit { return .needsLetterAndDigit }
        }
        if current.isEmpty || new.isEmpty || confirmation.isEmpty { return .incomplete }
        if new != confirmation { return .mismatch }
        if new == current { return .sameAsCurrent }
        return nil
    }
}
