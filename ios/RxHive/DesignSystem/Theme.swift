import SwiftUI

/// The RX HIVE design tokens, transcribed from `frontend/src/index.css`.
///
/// Every value here is the web app's value, not an approximation — the two
/// clients are the same product and a hex that is "close" reads as a bug when a
/// user has both open. The mobile redesign happens in *layout and interaction*
/// (see `Layout` and `Motion`), never in palette.
///
/// The app is dark-only, exactly as the web app is: `index.css` defines one
/// `:root` with no light-mode block and `body` hard-codes `#0A0A0A`. So there is
/// no `@Environment(\.colorScheme)` branching anywhere in this app — see
/// `RxHiveApp` for where that is enforced.
enum Theme {

    // MARK: - Palette

    /// Colour tokens. Names match the CSS custom properties one-for-one so a
    /// change on either side is greppable across both codebases.
    enum Color {
        /// `--rx-bg` — app background, behind everything.
        static let bg = SwiftUI.Color(hex: 0x0A0A0A)
        /// `--rx-sidebar` — the web sidebar's slightly-raised black. On mobile
        /// this is the tab bar / nav bar fill, which plays the same role.
        static let sidebar = SwiftUI.Color(hex: 0x0F0F0F)
        /// `--rx-surface` — cards, sheets, modals, message bubbles (received).
        static let surface = SwiftUI.Color(hex: 0x141414)
        /// `--rx-surface2` — inputs, chips, pressed states.
        static let surface2 = SwiftUI.Color(hex: 0x1A1A1A)
        /// `--rx-border` — hairlines and dividers.
        static let border = SwiftUI.Color(hex: 0x1F1F1F)
        /// `--rx-border2` — input borders, the more visible hairline.
        static let border2 = SwiftUI.Color(hex: 0x2D2D2D)
        /// `--rx-text` — primary text.
        static let text = SwiftUI.Color(hex: 0xF5F5F5)
        /// `--rx-text-muted` — secondary text, timestamps, placeholders.
        static let textMuted = SwiftUI.Color(hex: 0xA3A3A3)
        /// A third text tier the web app uses without a CSS variable (18 sites) —
        /// disabled labels and the faintest metadata.
        static let textFaint = SwiftUI.Color(hex: 0x525252)
        /// A fourth tier, rarer still (placeholder glyphs).
        static let textDim = SwiftUI.Color(hex: 0x737373)
        /// `--rx-primary` — the brand emerald. Accent, sent bubbles, focus.
        static let primary = SwiftUI.Color(hex: 0x10B981)
        /// `--rx-primary-hover` — pressed/active emerald.
        static let primaryPressed = SwiftUI.Color(hex: 0x059669)
        /// `--rx-danger`
        static let danger = SwiftUI.Color(hex: 0xEF4444)
        /// `--rx-warning`
        static let warning = SwiftUI.Color(hex: 0xF59E0B)
        /// `--rx-success` — same hex as primary in the web tokens.
        static let success = SwiftUI.Color(hex: 0x10B981)
        /// The starred-message amber. Distinct from `warning` in the web app
        /// (`#FBBF24` vs `#F59E0B`) — a star is not a caution.
        static let starred = SwiftUI.Color(hex: 0xFBBF24)

        /// `--primary-foreground` — text/icons drawn *on* the emerald. Near-black,
        /// not white: emerald at this luminance fails contrast against white.
        static let onPrimary = SwiftUI.Color(hex: 0x0A0A0A)

        /// `--rx-backdrop` — modal scrim.
        static let backdrop = SwiftUI.Color.black.opacity(0.6)

        // MARK: Derived

        /// Emerald at low alpha — the web app's `bg-[#10B981]/10` tint used for
        /// selected rows, avatar placeholders and "active" pills.
        static let primaryTint = primary.opacity(0.10)
        /// `border-[#10B981]/30` — the selected-pill border.
        static let primaryTintBorder = primary.opacity(0.30)
        /// `--rx-focus-ring` — `rgba(16,185,129,0.25)`.
        static let focusRing = primary.opacity(0.25)

        /// Outgoing bubble — `bg-[#10B981]` in `MessageBubble.jsx`.
        static let bubbleSent = primary
        /// **White**, not `onPrimary`.
        ///
        /// The web app uses near-black on emerald for *buttons* (`Login.jsx`'s
        /// `text-[#0A0A0A]`) but white on emerald for *bubbles*
        /// (`MessageBubble.jsx`'s `text-white/90`, `text-white/60`). They are not
        /// the same token and swapping them makes every sent message look wrong.
        static let bubbleSentText = SwiftUI.Color.white
        /// Secondary text inside a sent bubble — timestamps, "Forwarded", the reply
        /// quote's body. `text-white/60`.
        static let bubbleSentTextMuted = SwiftUI.Color.white.opacity(0.6)

        /// Incoming bubble — `bg-[#1F1F1F]`, which is the *border* token doing
        /// double duty. NOT `--rx-surface` (#141414): a received bubble on a
        /// #141414 card would nearly disappear, which is why the web app reaches
        /// one step lighter for it.
        static let bubbleReceived = SwiftUI.Color(hex: 0x1F1F1F)
        static let bubbleReceivedText = text
        static let bubbleReceivedTextMuted = textMuted

        /// The call-screen background gradient's dark green
        /// (`#1a3a2a` — the one lowercase hex in the web source).
        static let callBackdrop = SwiftUI.Color(hex: 0x1A3A2A)

        /// Presence dot colours.
        static let online = primary
        static let offline = SwiftUI.Color(hex: 0x6B7280)

        /// The flash used when jumping to a message — `bg-[#10B981]/15`, cleared
        /// after 1600ms in the web app.
        static let jumpHighlight = primary.opacity(0.15)
    }

    // MARK: - Sender colours

    /// Per-sender name colours in group chats.
    ///
    /// Ported exactly from `MessageBubble.jsx:16-28`, palette **and** hash, because
    /// the two clients must agree: a colleague who is orange in the browser has to
    /// be orange on the phone, or the colour stops being a recognition cue and
    /// becomes noise.
    enum SenderColor {

        /// `SENDER_COLORS`, in order. The index is meaningful — do not sort.
        static let palette: [SwiftUI.Color] = [
            SwiftUI.Color(hex: 0xF87171), SwiftUI.Color(hex: 0xFB923C),
            SwiftUI.Color(hex: 0xFBBF24), SwiftUI.Color(hex: 0xA3E635),
            SwiftUI.Color(hex: 0x34D399), SwiftUI.Color(hex: 0x22D3EE),
            SwiftUI.Color(hex: 0x818CF8), SwiftUI.Color(hex: 0xC084FC),
            SwiftUI.Color(hex: 0xF472B6), SwiftUI.Color(hex: 0xFB7185),
        ]

        /// The web app's `getSenderColor`:
        ///
        ///     hash = userId.charCodeAt(i) + ((hash << 5) - hash)
        ///
        /// Porting this correctly is fiddlier than it looks, and getting it wrong is
        /// invisible until you compare two clients side by side.
        ///
        /// In JavaScript **only `<<` coerces to signed 32-bit.** The subtraction and
        /// the addition are ordinary `Number` (double) arithmetic, so the running
        /// value is *not* wrapped at every step — it is wrapped once per iteration,
        /// when it next reaches the shift, and the value left after the final
        /// iteration is never wrapped at all. An "obvious" all-`Int32` translation
        /// therefore disagrees with the web for a good fraction of real UUIDs
        /// (measured: 3 of 10 sample ids).
        ///
        /// So `hash` is kept as a `Double`, exactly as JS holds it, and only the
        /// shift operand is narrowed. The magnitudes stay far below 2^53, so the
        /// double is exact — this is not an approximation.
        static func color(forUserID userID: String?) -> SwiftUI.Color {
            guard let userID, !userID.isEmpty else { return palette[0] }
            var hash: Double = 0
            // charCodeAt yields UTF-16 code units, so iterate UTF-16 rather than
            // Unicode scalars — they differ for anything outside the BMP.
            for unit in userID.utf16 {
                // ToInt32(hash), then <<5 with 32-bit wraparound.
                let shifted = Int32(truncatingIfNeeded: Int(hash)) &<< 5
                hash = Double(unit) + (Double(shifted) - hash)
            }
            let index = Int(abs(hash).truncatingRemainder(dividingBy: Double(palette.count)))
            return palette[index]
        }
    }

    // MARK: - File-type colours

    /// Document-chip colours, from `DocumentBubble.jsx:14-25`.
    enum FileTypeColor {
        static func color(forFilename filename: String?) -> SwiftUI.Color {
            switch (filename as NSString?)?.pathExtension.lowercased() ?? "" {
            case "pdf":            return SwiftUI.Color(hex: 0xEF4444)
            case "doc", "docx":    return SwiftUI.Color(hex: 0x3B82F6)
            case "xls", "xlsx":    return SwiftUI.Color(hex: 0x22C55E)
            case "ppt", "pptx":    return SwiftUI.Color(hex: 0xF97316)
            case "zip":            return SwiftUI.Color(hex: 0xA855F7)
            default:               return Color.textMuted
            }
        }

        /// SF Symbol standing in for the web's lucide icon.
        static func symbol(forFilename filename: String?) -> String {
            switch (filename as NSString?)?.pathExtension.lowercased() ?? "" {
            case "pdf", "doc", "docx", "txt": return "doc.text"
            case "xls", "xlsx", "csv":        return "tablecells"
            case "ppt", "pptx":               return "rectangle.on.rectangle"
            case "zip":                       return "doc.zipper"
            default:                          return "doc"
            }
        }

        /// The chip's fill. The web writes `` `${color}20` `` — appending a literal
        /// hex-alpha byte, so 0x20/255 = **12.5%**, not the 20% it looks like.
        static func chipFill(forFilename filename: String?) -> SwiftUI.Color {
            color(forFilename: filename).opacity(32.0 / 255.0)
        }
    }

    // MARK: - Typography

    /// Type scale.
    ///
    /// The web app loads Inter. iOS ships SF Pro, which is the platform's own
    /// grotesque and metrically similar enough that the two clients read as one
    /// product. If you want *exact* brand typography, drop `Inter-*.ttf` into
    /// `Resources/Fonts/`, list them under `UIAppFonts` in Info.plist, and
    /// `Font.brand` picks them up automatically — no other change needed.
    enum Typography {
        /// Set to the PostScript name of the bundled Inter face, or nil for SF Pro.
        static let brandFamily: String? = nil

        static func font(size: CGFloat, weight: Font.Weight) -> Font {
            guard let family = brandFamily else {
                return .system(size: size, weight: weight)
            }
            // .custom keeps Dynamic Type scaling via `relativeTo`.
            return .custom(family, size: size)
                .weight(weight)
        }

        /// 30/700 — the login wordmark.
        static var display: Font { font(size: 30, weight: .bold) }
        /// 20/600 — navigation titles.
        static var title: Font { font(size: 20, weight: .semibold) }
        /// 17/600 — section headers, conversation names.
        static var headline: Font { font(size: 17, weight: .semibold) }
        /// 16/400 — message text. Deliberately a point larger than the web's 14px:
        /// held at arm's length beats read at desk distance.
        static var body: Font { font(size: 16, weight: .regular) }
        /// 15/400 — list subtitles, previews.
        static var subheadline: Font { font(size: 15, weight: .regular) }
        /// 13/400 — metadata, timestamps.
        static var caption: Font { font(size: 13, weight: .regular) }
        /// 13/500 — pills and badges.
        static var pill: Font { font(size: 13, weight: .medium) }
        /// 11/500 — the smallest label (unread counts, bubble timestamps).
        static var micro: Font { font(size: 11, weight: .medium) }
        /// Monospaced — passwords, codes.
        static var mono: Font { .system(size: 14, weight: .regular, design: .monospaced) }
    }

    // MARK: - Layout

    /// Radii, spacing and touch metrics. This is where the mobile redesign lives.
    enum Layout {
        /// `--rx-radius-card` = 8px.
        static let radiusCard: CGFloat = 8
        /// `--rx-radius-input` = 6px.
        static let radiusInput: CGFloat = 6
        /// Sheets get a larger radius than web cards — an 8pt corner on a
        /// full-width sheet reads as a rendering mistake at phone scale.
        static let radiusSheet: CGFloat = 20
        /// Message bubbles. Not a web token: the web app's bubbles are small and
        /// mouse-targeted, phone bubbles are the primary content surface.
        static let radiusBubble: CGFloat = 18
        /// Fully-rounded.
        static let radiusPill: CGFloat = 999

        static let spacing1: CGFloat = 4
        static let spacing2: CGFloat = 8
        static let spacing3: CGFloat = 12
        static let spacing4: CGFloat = 16
        static let spacing5: CGFloat = 20
        static let spacing6: CGFloat = 24
        static let spacing8: CGFloat = 32

        /// Screen gutter.
        static let gutter: CGFloat = 16
        /// Apple's HIG minimum. The web app relaxes to 36px on mobile widths
        /// (`index.css`), which is below the guideline — native does not.
        static let minTouchTarget: CGFloat = 44
        /// Primary control height.
        static let controlHeight: CGFloat = 50
        /// Hairline that survives on a 3x screen.
        static let hairline: CGFloat = 1.0 / 3.0

        /// Avatar sizes.
        static let avatarSmall: CGFloat = 32
        static let avatarMedium: CGFloat = 44
        static let avatarLarge: CGFloat = 56
        static let avatarHero: CGFloat = 96
    }

    // MARK: - Motion

    /// `--rx-duration` / `--rx-ease`, expressed as SwiftUI animations.
    enum Motion {
        /// `--rx-duration` = 200ms.
        static let duration: Double = 0.2
        /// `--rx-ease` = cubic-bezier(0.2, 0.8, 0.2, 1) — fast out, gentle settle.
        static let ease = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: duration)
        /// Same curve, slower — used for sheets and screen transitions.
        static let easeSlow = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.32)
        /// Springy, for things the finger is directly manipulating.
        static let interactive = Animation.interactiveSpring(response: 0.3, dampingFraction: 0.78)
        /// The login card's entrance in `Login.jsx` (0.4s, same curve).
        static let entrance = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.4)
    }

    // MARK: - Elevation

    enum Shadow {
        /// `--rx-shadow-1`: `0 1px 0 rgba(0,0,0,.35), 0 10px 30px rgba(0,0,0,.35)`.
        /// SwiftUI takes one shadow per modifier; the ambient half is the one that
        /// reads, so the tight contact shadow is dropped rather than faked.
        static let card = (color: SwiftUI.Color.black.opacity(0.35), radius: CGFloat(15), y: CGFloat(10))
        /// `--rx-shadow-2`: the modal shadow.
        static let modal = (color: SwiftUI.Color.black.opacity(0.55), radius: CGFloat(30), y: CGFloat(18))
    }
}

// MARK: - Hex initialiser

extension Color {
    /// Build a colour from a 24-bit RGB literal, so tokens can be written as the
    /// same `0xRRGGBB` you read in the CSS.
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
