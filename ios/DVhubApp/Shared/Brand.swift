// Brand.swift — DVhub-Aurora-Farben (dvhub/public/dvhub-app.css, BRAND_GUIDELINES.md),
// hell und dunkel. Gemeinsam für App und Widgets.

import SwiftUI
import UIKit

enum Brand {
    private static func adaptive(_ dark: UInt32, _ light: UInt32, darkAlpha: CGFloat = 1, lightAlpha: CGFloat = 1) -> Color {
        Color(uiColor: UIColor { t in
            t.userInterfaceStyle == .light ? UIColor(hex: light, alpha: lightAlpha) : UIColor(hex: dark, alpha: darkAlpha)
        })
    }

    // Flächen
    static let bg0 = adaptive(0x030610, 0xf5f7fb)
    static let bg1 = adaptive(0x0a1226, 0xeef2f8)
    static let bg2 = adaptive(0x101a36, 0xe2e8f3)
    static let glass = adaptive(0x78b4ff, 0x0f285a, darkAlpha: 0.07, lightAlpha: 0.05)
    static let glassStrong = adaptive(0x78b4ff, 0x0f285a, darkAlpha: 0.12, lightAlpha: 0.08)
    static let border = adaptive(0x78b4ff, 0x0f285a, darkAlpha: 0.18, lightAlpha: 0.12)
    static let hairline = adaptive(0x78b4ff, 0x0f285a, darkAlpha: 0.08, lightAlpha: 0.08)
    // Text
    static let text = adaptive(0xeaf2ff, 0x0d1933)
    static let text2 = adaptive(0xb4c4e0, 0x3a4866)
    static let dim = adaptive(0x6b7c9b, 0x6e7a93)
    // Akzente
    static let cyan = adaptive(0x34dbff, 0x0a8fb0)
    static let blue = adaptive(0x1f8dff, 0x1561c2)
    static let violet = adaptive(0xa78bff, 0x6d4ed9)
    static let yellow = adaptive(0xffd421, 0xa87a00)
    static let green = adaptive(0x3ee0a0, 0x1e8a5b)
    static let red = adaptive(0xff5d5d, 0xc43a3a)
    static let orange = adaptive(0xff9f43, 0xc46a00)
    static let pink = adaptive(0xff7ac6, 0xb83c84)

    // Energie-Bedeutungen (wie im Leitstand)
    static let pv = yellow
    static let battery = green
    static let grid = blue
    static let home = orange
    static let money = green
    static let priceUp = blue
    static let priceDown = red
    static let now = yellow

    /// Aurora-Verlauf (Cyan → Blau → Violett → Gelb).
    static let aurora = AngularGradient(
        colors: [Color(hex: 0x34dbff), Color(hex: 0x1f8dff), Color(hex: 0xa78bff), Color(hex: 0xffd421), Color(hex: 0x34dbff)],
        center: .center, angle: .degrees(220))
    static let auroraLinear = LinearGradient(
        colors: [Color(hex: 0x34dbff), Color(hex: 0x1f8dff), Color(hex: 0xa78bff), Color(hex: 0xffd421)],
        startPoint: .leading, endPoint: .trailing)
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
                  blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255, opacity: opacity)
    }
}

/// Dunkler Aurora-Hintergrund mit weichen Lichtflecken (hell: ruhiges Grau-Blau).
struct AuroraBackground: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            LinearGradient(colors: [Brand.bg1, Brand.bg0], startPoint: .top, endPoint: .bottom)
            GeometryReader { g in
                let s = max(g.size.width, g.size.height)
                Circle().fill(Color(hex: 0x34dbff, opacity: scheme == .dark ? 0.16 : 0.10))
                    .frame(width: s * 0.8).blur(radius: s * 0.18)
                    .position(x: g.size.width * 0.15, y: -s * 0.05)
                Circle().fill(Color(hex: 0xa78bff, opacity: scheme == .dark ? 0.14 : 0.08))
                    .frame(width: s * 0.7).blur(radius: s * 0.2)
                    .position(x: g.size.width * 0.95, y: g.size.height * 0.15)
                Circle().fill(Color(hex: 0x1f8dff, opacity: scheme == .dark ? 0.10 : 0.06))
                    .frame(width: s * 0.9).blur(radius: s * 0.25)
                    .position(x: g.size.width * 0.5, y: g.size.height * 1.05)
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}
