import SwiftUI

/// Shown when the credentials were right but this account may not use the app.
///
/// This screen exists because the alternative is worse. If a member without the
/// mobile grant just saw "sign-in failed", they would retype their password,
/// then reset it, then open a ticket — none of which is the problem. So the
/// server's own explanation is shown verbatim, alongside the one action that
/// actually resolves it: ask a super admin.
///
/// Two reasons land here, and the copy differs because the remedies differ:
///   * not approved yet   — a super admin can grant it
///   * super admin account — nothing to grant; the portal is web-only by design
struct AccessDeniedView: View {
    /// The server's own explanation, shown verbatim.
    let reason: String
    /// Which denial this is, decoded from the backend's stable code
    /// (`MobileDenialKind`) — never inferred from `reason`.
    ///
    /// It was inferred from `reason` before, by looking for "super admin" in it. But
    /// the not-approved sentence ends "Ask your super admin to approve mobile
    /// sign-in" — it names the person who can fix it — so that test matched *both*
    /// 403s, and every un-granted member got the superadmin screen: titled "Use the
    /// web app", with the panel naming their actual remedy suppressed, directly above
    /// the server's own sentence telling them to ask an admin.
    let denial: MobileDenialKind
    let onBack: () -> Void

    /// Superadmins cannot be granted access, so offering "ask an admin" would be
    /// misleading.
    private var isSuperadminCase: Bool {
        denial == .superadminWebOnly
    }

    var body: some View {
        ZStack {
            Theme.Color.bg.ignoresSafeArea()
            AmbientGlow().opacity(0.35).ignoresSafeArea()

            VStack(spacing: Theme.Layout.spacing6) {
                Image(systemName: isSuperadminCase ? "desktopcomputer" : "lock.badge.clock")
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(Theme.Color.warning)
                    .padding(.bottom, Theme.Layout.spacing1)

                VStack(spacing: Theme.Layout.spacing3) {
                    Text(isSuperadminCase ? "Use the web app" : "Mobile access not enabled")
                        .font(Theme.Typography.title)
                        .foregroundStyle(Theme.Color.text)
                        .multilineTextAlignment(.center)

                    // The backend's `detail`, unedited.
                    Text(reason)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !isSuperadminCase {
                    VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                        Label(
                            "Your RxHive account works normally on the web.",
                            systemImage: "checkmark.circle"
                        )
                        Label(
                            "A super admin can approve your account for mobile from the admin portal.",
                            systemImage: "person.badge.key"
                        )
                    }
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .labelStyle(TopAlignedLabelStyle())
                    .padding(Theme.Layout.spacing4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                            .fill(Theme.Color.surface2)
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                    .stroke(Theme.Color.border, lineWidth: 1)
                            )
                    )
                }

                Button(action: onBack) {
                    Text("Back to sign in")
                        .font(Theme.Typography.font(size: 16, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .foregroundStyle(Theme.Color.onPrimary)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                .fill(Theme.Color.primary)
                        )
                }
                .buttonStyle(PressScaleStyle())
                .padding(.top, Theme.Layout.spacing2)
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
            .padding(.horizontal, Theme.Layout.gutter)
        }
        .preferredColorScheme(.dark)
    }
}

/// Keeps a multi-line `Label`'s icon aligned to the first line rather than
/// vertically centred against the whole paragraph.
struct TopAlignedLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Layout.spacing2) {
            configuration.icon.foregroundStyle(Theme.Color.primary)
            configuration.title.fixedSize(horizontal: false, vertical: true)
        }
    }
}
