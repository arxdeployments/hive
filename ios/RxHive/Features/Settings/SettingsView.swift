import SwiftUI
import UIKit

/// The Settings tab.
///
/// A port of `pages/Settings.jsx`, minus the settings that only make sense in a
/// browser. Three of the web app's four sections are dropped deliberately rather
/// than by omission:
///
///  * **Desktop notifications** — the web toggle drives `pushManager.subscribe()`
///    and writes a Web Push subscription row. There is no APNs column on that
///    table, so the same switch on iOS could only ever lie. See
///    `pushUnavailableFootnote`.
///  * **Enter key sends message** — there is no Enter key on a phone keyboard;
///    the composer's send button is unambiguous.
///  * **Message font size** — iOS has Dynamic Type, which is the system-wide
///    version of this setting and already applies. A second, app-local scale would
///    fight it.
///
/// What is added is what a native client has and a browser tab does not: the build
/// it is running, the host it is talking to, whether the socket is up, and the
/// mobile-access grant that let this device in at all.
struct SettingsView: View {

    @EnvironmentObject private var auth: AuthStore

    @AppStorage(SettingsKeys.inAppAlerts) private var inAppAlerts = true
    @AppStorage(SettingsKeys.alertSound) private var alertSound = true

    /// The freshest `/me` we have.
    ///
    /// `AuthStore.phase` is `private(set)` and exposes no public "re-read my
    /// profile" call, so a profile edit cannot push the new values back into it —
    /// the canonical `auth.currentUser` catches up on the next foreground
    /// revalidation. Holding the fresh copy here means the header updates the
    /// instant the edit saves instead of looking like the save failed.
    @State private var profile: CurrentUser?
    @State private var showingPasswordSheet = false
    @State private var confirmingSignOut = false

    private var user: CurrentUser? { profile ?? auth.currentUser }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Layout.spacing6) {
                    profileHeader
                    accountSection
                    if user?.role == .admin { organisationSection }
                    notificationsSection
                    deviceSection
                    aboutSection
                    signOutButton
                }
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.top, Theme.Layout.spacing2)
                .padding(.bottom, Theme.Layout.spacing8)
            }
            .background(Theme.Color.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
        }
        .sheet(isPresented: $showingPasswordSheet) {
            ChangePasswordSheet()
        }
        .confirmationDialog(
            "Sign out of RX HIVE?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign Out", role: .destructive) {
                Task { await auth.signOut() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll need your email and password to sign back in.")
        }
        .task {
            // Login only returns the core payload; /me adds avatar, about and
            // presence. Cheap enough to re-read every time this tab is opened, and
            // it means an avatar changed on the web shows up here.
            if let fresh = try? await RxHiveAPI.me() { profile = fresh }
        }
    }

    // MARK: - Profile

    private var profileHeader: some View {
        NavigationLink {
            if let user {
                ProfileEditView(user: user) { updated in profile = updated }
            }
        } label: {
            SurfaceCard {
                HStack(spacing: Theme.Layout.spacing4) {
                    Avatar(
                        name: user?.name ?? "",
                        urlPath: user?.avatarURL,
                        size: Theme.Layout.avatarLarge
                    )

                    VStack(alignment: .leading, spacing: 2) {
                        Text(user?.name ?? "—")
                            .font(Theme.Typography.headline)
                            .foregroundStyle(Theme.Color.text)
                        Text(user?.email ?? "")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted)
                        // The web app's placeholder for an empty about, so the row
                        // never collapses to two lines and back.
                        Text(user?.about?.isEmpty == false ? user!.about! : "Hey there! I'm using RX HIVE")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted.opacity(0.8))
                            .lineLimit(1)
                            .padding(.top, 2)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }
        }
        .buttonStyle(PressScaleStyle())
        .disabled(user == nil)
    }

    // MARK: - Account

    private var accountSection: some View {
        SettingsSection(title: "Account") {
            SettingsRow(
                icon: "lock",
                title: "Change Password",
                subtitle: "Update the password you use to sign in",
                accessory: .chevron
            ) {
                showingPasswordSheet = true
            }
        }
    }

    // MARK: - Organisation admin

    private var organisationSection: some View {
        SettingsSection(
            title: "Organisation",
            footnote: "View your organisation's people and departments, change someone's "
                + "role or department, deactivate an account, or issue a temporary password."
        ) {
            NavigationLink {
                OrgAdminView()
            } label: {
                SettingsRowLabel(
                    icon: "building.2",
                    title: "Organisation Admin",
                    subtitle: "Users, roles and departments",
                    accessory: .chevron
                )
            }
            .buttonStyle(PressScaleStyle())
        }
    }

    // MARK: - Notifications

    private var notificationsSection: some View {
        SettingsSection(title: "Notifications", footnote: Self.pushUnavailableFootnote) {
            SettingsToggleRow(
                icon: "bell",
                title: "In-App Alerts",
                subtitle: "Banner for messages arriving while the app is open",
                isOn: $inAppAlerts
            )
            Hairline()
            SettingsToggleRow(
                icon: "speaker.wave.2",
                title: "Alert Sound",
                subtitle: "Play a sound with in-app alerts",
                isOn: $alertSound
            )
            .disabled(!inAppAlerts)
            .opacity(inAppAlerts ? 1 : 0.45)
        }
    }

    /// Stated plainly instead of shipping a switch that cannot work.
    ///
    /// The backend's push table stores Web Push subscriptions — an endpoint URL plus
    /// p256dh/auth keys, signed with VAPID. An APNs device token has none of those
    /// fields and no column to live in, and the server's fan-out only ever walks
    /// Web Push rows. So notifications while the app is closed are a backend change,
    /// not a setting.
    static let pushUnavailableFootnote =
        "These control alerts while RX HIVE is open. Notifications when the app is "
        + "closed aren't available yet — the server currently only stores web browser "
        + "push subscriptions, which can't reach an iPhone."

    // MARK: - This device

    private var deviceSection: some View {
        SettingsSection(
            title: "Mobile Access",
            footnote: "Mobile access is granted per account by your RX HIVE super admin, "
                + "in the web portal. If it is ever withdrawn you'll be signed out here and "
                + "the web app will keep working."
        ) {
            SettingsRowLabel(
                icon: "checkmark.seal",
                title: "This Device Is Approved",
                subtitle: "\(user?.email ?? "This account") is cleared to use the mobile app",
                accessory: .plain
            )
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        SettingsSection(title: "About") {
            InfoRow(label: "Version", value: Self.versionString)
            Hairline()
            InfoRow(label: "Server", value: AppConfig.apiBaseURL.host ?? "—")
            Hairline()
            RealtimeStatusRow(client: auth.realtime)
        }
    }

    /// "1.4.0 (212)". Read from the bundle so a tester reporting a bug quotes the
    /// build they actually have, not one hard-coded here and forgotten.
    private static var versionString: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String
        guard let build, !build.isEmpty, build != short else { return short }
        return "\(short) (\(build))"
    }

    // MARK: - Sign out

    private var signOutButton: some View {
        SecondaryButton(title: "Sign Out", systemImage: "rectangle.portrait.and.arrow.right", tint: Theme.Color.danger) {
            confirmingSignOut = true
        }
        .padding(.top, Theme.Layout.spacing2)
    }
}

// MARK: - AppStorage keys

/// The `@AppStorage` keys this app persists locally.
///
/// Named constants rather than string literals at each use site, because a typo in
/// one of two literals is a setting that silently forgets itself. Prefixed to match
/// the web app's `rxhive_*` localStorage convention.
enum SettingsKeys {
    /// In-app banner for messages arriving while the app is foregrounded.
    static let inAppAlerts = "rxhive_in_app_alerts"
    /// Whether the in-app banner is accompanied by a sound.
    static let alertSound = "rxhive_alert_sound"
}

// MARK: - Change password

/// Three fields and the server's password policy, applied twice.
///
/// The client checks the policy so a typo costs no round trip, and the server's
/// message is shown verbatim on a 400 because the minimum length is configuration
/// (`settings.password_min_length`) — this build's guess of 8 can be wrong, and
/// "Password must be at least 12 characters" is only useful if it survives.
private struct ChangePasswordSheet: View {

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var toasts: ToastCenter

    @State private var current = ""
    @State private var new = ""
    @State private var confirmation = ""
    @State private var isSaving = false
    @State private var error: String?

    /// `core/security.py:enforce_password_policy`. The length is the *default*
    /// `RXHIVE_PASSWORD_MIN_LENGTH`; the server is authoritative.
    private static let assumedMinimumLength = 8

    private var localValidationError: String? {
        if current.isEmpty || new.isEmpty { return nil }
        if new.count < Self.assumedMinimumLength {
            return "New password must be at least \(Self.assumedMinimumLength) characters."
        }
        if new.rangeOfCharacter(from: .letters) == nil || new.rangeOfCharacter(from: .decimalDigits) == nil {
            return "New password must contain both letters and numbers."
        }
        if new == current {
            return "New password must be different from your current one."
        }
        if !confirmation.isEmpty && new != confirmation {
            return "New passwords don't match."
        }
        return nil
    }

    private var canSubmit: Bool {
        !current.isEmpty && !new.isEmpty && new == confirmation && localValidationError == nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Layout.spacing4) {
                    FloatingField(
                        label: "Current password",
                        text: $current,
                        isSecure: true,
                        hasError: error != nil,
                        isDisabled: isSaving,
                        textContentType: .password
                    )

                    FloatingField(
                        label: "New password",
                        text: $new,
                        isSecure: true,
                        hasError: localValidationError != nil,
                        isDisabled: isSaving,
                        textContentType: .newPassword
                    )

                    FloatingField(
                        label: "Confirm new password",
                        text: $confirmation,
                        isSecure: true,
                        hasError: !confirmation.isEmpty && confirmation != new,
                        isDisabled: isSaving,
                        textContentType: .newPassword,
                        submitLabel: .done,
                        onSubmit: { if canSubmit { save() } }
                    )

                    if let message = error ?? localValidationError {
                        HStack(alignment: .top, spacing: Theme.Layout.spacing2) {
                            Image(systemName: "exclamationmark.circle")
                                .font(.system(size: 13))
                            Text(message)
                                .font(Theme.Typography.caption)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .foregroundStyle(Theme.Color.danger)
                    }

                    Text(
                        "At least \(Self.assumedMinimumLength) characters, with letters and numbers. "
                        + "Changing your password signs out every session, including this one, so "
                        + "you'll be asked to sign in again."
                    )
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                    PrimaryButton(
                        title: "Update Password",
                        isLoading: isSaving,
                        isEnabled: canSubmit
                    ) {
                        save()
                    }
                    .padding(.top, Theme.Layout.spacing2)
                }
                .padding(Theme.Layout.gutter)
            }
            .background(Theme.Color.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Change Password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Color.textMuted)
                        .disabled(isSaving)
                }
            }
        }
        .presentationDetents([.large])
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        error = nil
        Task {
            defer { isSaving = false }
            do {
                try await RxHiveAPI.changePassword(current: current, new: new)
                toasts.success("Password changed")
                dismiss()
            } catch APIError.unauthorized {
                // `/api/auth/change-password` answers 401 for "current password is
                // wrong", and `APIClient.isAuthPath` correctly declines to treat
                // that as an expired session — but `.unauthorized.userMessage` still
                // reads "Your session expired", which would be a lie here.
                error = "Your current password is incorrect."
            } catch let apiError as APIError {
                // A 400 is the policy rejection; its detail is the server's own
                // sentence and is the only place the real minimum length appears.
                error = apiError.userMessage
            } catch {
                error = "Couldn't change your password. Please try again."
            }
        }
    }
}

// MARK: - Section scaffolding

/// A titled card of rows, with an optional explanatory footnote underneath.
///
/// Not `Form`/`List`: the inset-grouped style brings its own greys and separators
/// that cannot be pushed all the way to the RX HIVE palette, and a settings screen
/// that is nearly the brand colour reads worse than one that plainly isn't.
private struct SettingsSection<Content: View>: View {
    let title: String
    var footnote: String?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            SectionHeader(title: title)

            VStack(spacing: 0) {
                content()
            }
            .background(
                RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                    .fill(Theme.Color.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                            .stroke(Theme.Color.border, lineWidth: 1)
                    )
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.radiusCard))

            if let footnote {
                Text(footnote)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Theme.Layout.spacing1)
            }
        }
    }
}

private enum RowAccessory {
    /// A disclosure chevron — the row leads somewhere.
    case chevron
    /// Nothing. Named `plain` rather than `none` so `accessory: .plain` can never be
    /// read as `Optional.none` at a call site.
    case plain
}

/// The visual half of a settings row, so a tappable row and a `NavigationLink`
/// label can be identical without one of them being a button inside a button.
private struct SettingsRowLabel: View {
    let icon: String
    let title: String
    var subtitle: String?
    var accessory: RowAccessory = .chevron
    var tint: Color = Theme.Color.text

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(Theme.Color.textMuted)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(tint)
                if let subtitle {
                    Text(subtitle)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .multilineTextAlignment(.leading)

            if accessory == .chevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
            }
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
        .contentShape(Rectangle())
    }
}

private struct SettingsRow: View {
    let icon: String
    let title: String
    var subtitle: String?
    var accessory: RowAccessory = .chevron
    var tint: Color = Theme.Color.text
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            SettingsRowLabel(icon: icon, title: title, subtitle: subtitle, accessory: accessory, tint: tint)
        }
        .buttonStyle(PressScaleStyle())
    }
}

private struct SettingsToggleRow: View {
    let icon: String
    let title: String
    var subtitle: String?
    @Binding var isOn: Bool

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(Theme.Color.textMuted)
                .frame(width: 24)

            Toggle(isOn: $isOn) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.text)
                    if let subtitle {
                        Text(subtitle)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .tint(Theme.Color.primary)
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
    }
}

/// A read-only label/value row.
private struct InfoRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Text(label)
                .font(Theme.Typography.subheadline)
                .foregroundStyle(Theme.Color.text)
            Spacer(minLength: Theme.Layout.spacing4)
            Text(value)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Color.textMuted)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
    }
}

/// Live socket state.
///
/// Takes the client as an `@ObservedObject` rather than reading `auth.realtime.state`
/// from the enclosing view: `AuthStore` does not republish its nested client's
/// changes, so the row would render once and then sit on a stale value through every
/// reconnect — which is exactly the moment someone opens this screen to look at it.
private struct RealtimeStatusRow: View {
    @ObservedObject var client: RealtimeClient

    private var description: (text: String, color: Color) {
        switch client.state {
        case .idle:
            return ("Not connected", Theme.Color.textMuted)
        case .connecting:
            return ("Connecting…", Theme.Color.warning)
        case .connected:
            return ("Connected", Theme.Color.primary)
        case .reconnecting(let attempt):
            return ("Reconnecting (attempt \(attempt))", Theme.Color.warning)
        case .offline:
            return ("Offline", Theme.Color.danger)
        }
    }

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Text("Live Connection")
                .font(Theme.Typography.subheadline)
                .foregroundStyle(Theme.Color.text)
            Spacer(minLength: Theme.Layout.spacing4)
            HStack(spacing: Theme.Layout.spacing2) {
                Circle()
                    .fill(description.color)
                    .frame(width: 8, height: 8)
                Text(description.text)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
            }
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
        .animation(Theme.Motion.ease, value: description.text)
    }
}
