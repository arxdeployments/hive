import SwiftUI

/// The launch animation.
///
/// Built from the login page's own visual language rather than invented: the same
/// emerald radial glows (`Login.jsx`'s three `radial-gradient` layers), the same
/// wordmark with its emerald text-shadow, and the same
/// `cubic-bezier(0.2, 0.8, 0.2, 1)` curve. The result reads as the web app's login
/// screen assembling itself, which is what makes the hand-off to the sign-in form
/// feel like one continuous surface instead of two screens.
///
/// It is also load-bearing: `AuthStore.restoreSession` runs underneath it, so the
/// animation is the budget for deciding whether this user is already signed in.
struct SplashView: View {

    /// Drives the whole sequence; set once, on appear.
    @State private var appeared = false
    /// The emerald ring's sweep.
    @State private var sweep = false
    /// The glow behind the wordmark, breathing.
    @State private var glowUp = false

    var body: some View {
        ZStack {
            Theme.Color.bg.ignoresSafeArea()

            // The login page's ambient gradients.
            AmbientGlow()
                .opacity(appeared ? 0.6 : 0)
                .animation(.easeOut(duration: 1.1), value: appeared)
                .ignoresSafeArea()

            VStack(spacing: Theme.Layout.spacing5) {
                ZStack {
                    // Sweeping progress ring. A ring rather than a spinner because
                    // it is the same emerald hairline the web app uses for focus
                    // states, and it reads as brand rather than as "loading".
                    Circle()
                        .stroke(Theme.Color.border2, lineWidth: 2)
                        .frame(width: 84, height: 84)
                        .opacity(appeared ? 1 : 0)

                    Circle()
                        .trim(from: 0, to: 0.22)
                        .stroke(
                            Theme.Color.primary,
                            style: StrokeStyle(lineWidth: 2, lineCap: .round)
                        )
                        .frame(width: 84, height: 84)
                        .rotationEffect(.degrees(sweep ? 360 : 0))
                        .opacity(appeared ? 1 : 0)

                    Text("Rx")
                        .font(Theme.Typography.font(size: 28, weight: .bold))
                        .foregroundStyle(Theme.Color.text)
                        .scaleEffect(appeared ? 1 : 0.85)
                        .opacity(appeared ? 1 : 0)
                }
                .shadow(color: Theme.Color.primary.opacity(glowUp ? 0.35 : 0.12), radius: glowUp ? 28 : 12)

                VStack(spacing: 6) {
                    Text("RxHive")
                        .font(Theme.Typography.display)
                        .foregroundStyle(Theme.Color.text)
                        // `Login.jsx`: textShadow 0 0 40px rgba(16,185,129,0.3)
                        .shadow(color: Theme.Color.primary.opacity(0.3), radius: 20)

                    Text("Enterprise Messaging")
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                }
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared ? 0 : 12)
            }
        }
        .onAppear {
            withAnimation(Theme.Motion.entrance) { appeared = true }
            withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) { sweep = true }
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { glowUp = true }
        }
    }
}

/// The three radial gradients from `Login.jsx`, at their exact positions, sizes
/// and alphas, plus the slow drift its `gradientMove` keyframes describe.
struct AmbientGlow: View {
    @State private var drift = false

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            ZStack {
                // radial-gradient(600px circle at 20% 20%, rgba(16,185,129,0.15), transparent 55%)
                glow(color: Theme.Color.primary.opacity(0.15), diameter: 600)
                    .position(x: w * 0.20, y: h * 0.20)
                // radial-gradient(700px circle at 80% 30%, rgba(16,185,129,0.08), transparent 60%)
                glow(color: Theme.Color.primary.opacity(0.08), diameter: 700)
                    .position(x: w * 0.80, y: h * 0.30)
                // radial-gradient(800px circle at 50% 90%, rgba(255,255,255,0.03), transparent 60%)
                glow(color: Color.white.opacity(0.03), diameter: 800)
                    .position(x: w * 0.50, y: h * 0.90)
            }
            .offset(x: drift ? 14 : -14, y: drift ? -10 : 10)
            .animation(.easeInOut(duration: 18).repeatForever(autoreverses: true), value: drift)
        }
        .onAppear { drift = true }
        .allowsHitTesting(false)
    }

    private func glow(color: Color, diameter: CGFloat) -> some View {
        RadialGradient(
            gradient: Gradient(stops: [
                .init(color: color, location: 0),
                .init(color: .clear, location: 0.58)
            ]),
            center: .center,
            startRadius: 0,
            endRadius: diameter / 2
        )
        .frame(width: diameter, height: diameter)
        .blur(radius: 20)
    }
}

#Preview {
    SplashView()
}
