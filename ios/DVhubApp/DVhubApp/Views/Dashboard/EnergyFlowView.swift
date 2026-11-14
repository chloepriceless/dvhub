// EnergyFlowView.swift — Energiefluss mit Partikeln: PV oben, Netz links, Haus
// rechts, Akku unten, alles über die Mitte. Der Partikelstrom folgt dem
// Web-Leitstand (dvhub/public/dvhub-powerflow.js), fürs iPhone angepasst:
// viele kleine Leuchtpunkte mit Schweif und Lichtschein in der Farbe ihrer
// Quelle (PV gelb, Akku grün, Netz blau); Dichte und Tempo folgen der
// Leistung (FlowEdge im Paket DVhubLink).
//
// Gezeichnet wird in einem Canvas (ein Durchlauf je Bild, keine Views je
// Partikel). Mit „Bewegung reduzieren“ steht das Bild: Pfeile zeigen die Richtung.

import SwiftUI
import DVhubLink

/// Laufende Phase je Strecke. Die Phase wird je Bild fortgeschrieben — ändert
/// sich die Leistung, laufen die Partikel schneller weiter, statt zu springen.
private final class FlowPhases {
    var phase: [FlowEdge.Node: Double] = [:]
    var last: Date?

    func advance(to now: Date, edges: [FlowEdge]) {
        let dt = min(0.1, max(0, last.map { now.timeIntervalSince($0) } ?? 0))
        last = now
        for e in edges { phase[e.node, default: 0] += dt * e.speed }
    }
}

struct EnergyFlowView: View {
    let status: LiveStatus
    var onTap: (FlowEdge.Node) -> Void = { _ in }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var phases = FlowPhases()

    private var edges: [FlowEdge] { FlowEdge.edges(from: status) }

    var body: some View {
        GeometryReader { g in
            let m = Metrics(size: g.size)
            ZStack {
                Group {
                    if reduceMotion {
                        Canvas { ctx, _ in draw(&ctx, m: m, time: nil) }
                    } else {
                        TimelineView(.animation) { tl in
                            Canvas { ctx, _ in
                                phases.advance(to: tl.date, edges: edges)
                                draw(&ctx, m: m, time: tl.date)
                            }
                        }
                    }
                }
                // Die Leitungen sind gezeichnet — für VoiceOver steht hier in
                // Worten, wohin gerade Energie fließt.
                .accessibilityElement()
                .accessibilityLabel("Energiefluss")
                .accessibilityValue(Self.summary(status))
                .accessibilityAddTraits(.updatesFrequently)
                hub(m)
                node(.pv, m)
                node(.grid, m)
                node(.home, m)
                node(.battery, m)
            }
        }
        .accessibilityElement(children: .contain)
        // Die Grafik hat feste Maße: Ihre Beschriftung wächst nur bis xxLarge mit,
        // sonst liefe sie ineinander. Dieselben Werte stehen in den Karten
        // darunter in voller Größe; jeder Knoten öffnet die Detailansicht.
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }

    /// Der Fluss in einem Satz je Knoten.
    static func summary(_ s: LiveStatus) -> String {
        [
            String(localized: "Erzeugung \(Format.power(s.pvTotalW))"),
            String(localized: "Hausverbrauch \(Format.power(s.loadW))"),
            String(localized: "Akku \(Format.percent(s.soc)), \(StatusText.batteryCaption(s))"),
            String(localized: "Netz: \(StatusText.gridCaption(s)) \(Format.power(StatusText.gridValue(s)))"),
        ].joined(separator: ". ")
    }

    // MARK: Maße

    struct Metrics {
        let size: CGSize
        let r: CGFloat
        let hubR: CGFloat
        let hub: CGPoint

        init(size: CGSize) {
            self.size = size
            // Knoten eher klein: Die Strecken dazwischen gehören dem Partikelstrom.
            r = max(24, min(36, min(size.width, size.height) * 0.092))
            hubR = r * 0.64
            hub = CGPoint(x: size.width / 2, y: size.height / 2)
        }

        func center(_ n: FlowEdge.Node) -> CGPoint {
            switch n {
            case .pv: return CGPoint(x: size.width / 2, y: r + 6)
            case .battery: return CGPoint(x: size.width / 2, y: size.height - r - 6)
            case .grid: return CGPoint(x: r + 8, y: size.height / 2)
            case .home: return CGPoint(x: size.width - r - 8, y: size.height / 2)
            }
        }

        /// Strecke vom Rand des Knotens zum Rand der Mitte.
        func segment(_ n: FlowEdge.Node) -> (CGPoint, CGPoint) {
            let c = center(n)
            let dx = hub.x - c.x, dy = hub.y - c.y
            let len = max(1, sqrt(dx * dx + dy * dy))
            let ux = dx / len, uy = dy / len
            return (CGPoint(x: c.x + ux * (r + 5), y: c.y + uy * (r + 5)),
                    CGPoint(x: hub.x - ux * (hubR + 5), y: hub.y - uy * (hubR + 5)))
        }
    }

    static func color(_ n: FlowEdge.Node) -> Color {
        switch n {
        case .pv: return Brand.pv
        case .battery: return Brand.battery
        case .grid: return Brand.grid
        case .home: return Brand.home
        }
    }

    // MARK: Zeichnen

    /// Farbe einer Quelle (PV, Akku, Netz) — die Partikel tragen sie bis ans Ziel.
    private static let sourceOrder: [FlowEdge.Node] = [.pv, .battery, .grid]

    /// Feste Eigenschaften je Partikel (Versatz auf der Strecke, Rang für die
    /// Quelle, Größe, seitliches Pendeln) — einmal gewürfelt, immer gleich:
    /// So springt nichts, wenn sich die Leistung ändert.
    private struct Dust {
        let offset: Double, rank: Double, size: CGFloat, sway: CGFloat, wobble: Double
    }

    private struct SplitMix: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    private static let dust: [Dust] = {
        var g = SplitMix(state: 0xD0B5_F10A)
        return (0..<(FlowEdge.maxParticles * FlowEdge.Node.allCases.count)).map { _ in
            Dust(offset: .random(in: 0..<1, using: &g), rank: .random(in: 0..<1, using: &g),
                 size: .random(in: 0.9...2.1, using: &g), sway: .random(in: -0.05...0.05, using: &g),
                 wobble: .random(in: 0..<(2 * .pi), using: &g))
        }
    }()

    /// Deckkraft in fünf Stufen: Kreise gleicher Farbe und Stufe werden in
    /// einem Pfad gesammelt und zusammen gefüllt (wenige Füllungen je Bild).
    private static let alphaLevels: [Double] = [0.05, 0.15, 0.3, 0.5, 0.7, 0.9]
    /// Nächstliegende Stufe.
    private static func level(_ a: Double) -> Int {
        alphaLevels.indices.min { abs(alphaLevels[$0] - a) < abs(alphaLevels[$1] - a) } ?? 0
    }

    /// Partikelstrom wie im Web-Leitstand (dvhub-powerflow.js): viele kleine
    /// Leuchtpunkte in der Farbe ihrer Quelle, die leicht pendelnd in
    /// Flussrichtung treiben, mit Schweif und Lichtschein. Dichte und Tempo
    /// folgen der Leistung (FlowEdge). Dunkel addieren sich die Lichter
    /// (plusLighter), hell stehen sie in den kräftigeren Farben des hellen
    /// Designs mit dunklem Kern.
    private func draw(_ ctx: inout GraphicsContext, m: Metrics, time: Date?) {
        let dark = scheme == .dark
        for e in edges {
            let (a, b) = m.segment(e.node)
            let color = Self.color(e.node)
            var line = Path()
            line.move(to: a)
            line.addLine(to: b)
            guard e.active else {
                ctx.stroke(line, with: .color(Brand.dim.opacity(0.35)), style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [2, 5]))
                continue
            }
            // Leitung: weicher Schein und feine Linie als Bahn der Partikel.
            ctx.stroke(line, with: .color(color.opacity(dark ? 0.10 : 0.08)), style: StrokeStyle(lineWidth: 9, lineCap: .round))
            ctx.stroke(line, with: .color(color.opacity(0.32)), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
            let dx = b.x - a.x, dy = b.y - a.y
            let len = max(1, sqrt(dx * dx + dy * dy))
            if time == nil {
                // Ohne Bewegung: drei Pfeilspitzen in Flussrichtung.
                let dir: CGFloat = e.towardHub ? 1 : -1
                let ang = atan2(dy, dx) + (dir > 0 ? 0 : .pi)
                for f in [0.3, 0.5, 0.7] as [CGFloat] {
                    let p = CGPoint(x: a.x + dx * f, y: a.y + dy * f)
                    var arrow = Path()
                    arrow.move(to: CGPoint(x: -5, y: -5))
                    arrow.addLine(to: CGPoint(x: 3, y: 0))
                    arrow.addLine(to: CGPoint(x: -5, y: 5))
                    let t = CGAffineTransform(translationX: p.x, y: p.y).rotated(by: ang)
                    ctx.stroke(arrow.applying(t), with: .color(color), style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                }
                continue
            }
            // Quer zur Strecke (für das Pendeln).
            let nx = -dy / len, ny = dx / len
            let phase = phases.phase[e.node] ?? 0
            let base = (FlowEdge.Node.allCases.firstIndex(of: e.node) ?? 0) * FlowEdge.maxParticles
            // Schweif: Nachbilder hinter dem Partikel, länger bei höherem Tempo.
            let step = 0.008 + e.speed * 0.035
            var bodies = Array(repeating: Array(repeating: Path(), count: Self.alphaLevels.count), count: Self.sourceOrder.count)
            var cores = Array(repeating: Path(), count: Self.alphaLevels.count)

            func point(_ along: Double, _ d: Dust) -> CGPoint {
                let f = CGFloat(e.towardHub ? along : 1 - along)
                let sway = CGFloat(sin(along * .pi * 8 + d.wobble)) * d.sway * len
                return CGPoint(x: a.x + dx * f + nx * sway, y: a.y + dy * f + ny * sway)
            }
            func dot(_ path: inout Path, _ c: CGPoint, _ r: CGFloat) {
                path.addEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
            }

            // Dichte je Länge: Auf kurzen Strecken weniger Partikel, sonst verklumpt der Strom.
            let count = max(4, Int((Double(min(e.particleCount, FlowEdge.maxParticles)) * min(1, Double(len) / 120)).rounded()))
            for i in 0..<count {
                let d = Self.dust[base + i]
                var along = (phase + d.offset).truncatingRemainder(dividingBy: 1)
                if along < 0 { along += 1 }
                // An den Enden weich ein- und ausblenden.
                let env = sin(.pi * along)
                let alpha = env * 0.9
                let src = Self.sourceOrder.firstIndex(of: e.source(rank: d.rank)) ?? 0
                let r = d.size * CGFloat(0.6 + env * 0.6)
                let head = point(along, d)
                dot(&bodies[src][0], head, r * 2.6)                       // Lichtschein (schwächste Stufe)
                for k in 1...4 {                                           // Schweif
                    let back = along - Double(k) * step
                    guard back > 0 else { break }
                    let fade = pow(0.62, Double(k))
                    dot(&bodies[src][Self.level(alpha * fade)], point(back, d), r * CGFloat(1 - 0.12 * Double(k)))
                }
                dot(&bodies[src][Self.level(alpha)], head, r)              // Partikel
                dot(&cores[Self.level(alpha * (dark ? 0.6 : 0.35))], head, r * 0.4)
            }

            ctx.drawLayer { l in
                if dark { l.blendMode = .plusLighter }
                for (si, levels) in bodies.enumerated() {
                    let c = Self.color(Self.sourceOrder[si])
                    for (li, path) in levels.enumerated() where !path.isEmpty {
                        l.fill(path, with: .color(c.opacity(Self.alphaLevels[li])))
                    }
                }
                // Kern: weißes Glühen im Dunkeln, dunkler Kern im Hellen.
                let core = dark ? Color.white : Brand.text
                for (li, path) in cores.enumerated() where !path.isEmpty {
                    l.fill(path, with: .color(core.opacity(Self.alphaLevels[li])))
                }
            }
        }
    }

    // MARK: Knoten

    private func hub(_ m: Metrics) -> some View {
        ZStack {
            Circle().fill(Brand.bg0.opacity(0.85))
            Circle().strokeBorder(Brand.aurora, lineWidth: 2.5)
            Image(systemName: "bolt.fill")
                // Teil der Grafik: Größe folgt dem Kreis, nicht der Schriftgröße.
                .font(.system(size: m.hubR * 0.85, weight: .bold))
                .foregroundStyle(Brand.yellow)
        }
        .frame(width: m.hubR * 2, height: m.hubR * 2)
        .shadow(color: Brand.cyan.opacity(0.45), radius: 10)
        .position(m.hub)
        .accessibilityHidden(true)
    }

    private func edge(_ n: FlowEdge.Node) -> FlowEdge? { edges.first { $0.node == n } }

    @ViewBuilder
    private func node(_ n: FlowEdge.Node, _ m: Metrics) -> some View {
        let c = m.center(n)
        let color = Self.color(n)
        let info = Self.info(n, status)
        let active = edge(n)?.active ?? false
        Button { onTap(n) } label: {
            ZStack {
                Circle().fill(Brand.bg1.opacity(0.9))
                Circle().fill(color.opacity(active ? 0.20 : 0.08))
                Circle().strokeBorder(color.opacity(active ? 0.9 : 0.35), lineWidth: 1.5)
                if n == .battery, let soc = status.soc {
                    Circle().trim(from: 0, to: max(0.01, min(1, soc / 100)))
                        .stroke(color, style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .padding(-4)
                }
                Image(systemName: info.icon)
                    .font(.system(size: m.r * 0.72, weight: .semibold))
                    .foregroundStyle(color)
            }
            .frame(width: m.r * 2, height: m.r * 2)
            .shadow(color: color.opacity(active ? 0.5 : 0), radius: 10)
            .contentShape(Circle().inset(by: -8))
        }
        .buttonStyle(CardButtonStyle())
        .position(c)
        .accessibilityLabel("\(info.title), \(info.value), \(info.caption)")
        .accessibilityHint("Zeigt Detailwerte")
        .accessibilityIdentifier("flowNode.\(n.rawValue)")

        // Beschriftung: bei PV und Akku seitlich (die Leitung läuft senkrecht),
        // bei Netz und Haus zur Mitte hin versetzt über/unter dem Knoten.
        let label = VStack(alignment: n == .home ? .trailing : .leading, spacing: 0) {
            Text(info.value)
                .font(.system(.headline, design: .rounded).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Brand.text)
                .contentTransition(.numericText())
            Text(info.caption).font(.caption2).foregroundStyle(Brand.text2)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .accessibilityHidden(true)
        .allowsHitTesting(false)

        switch n {
        case .pv, .battery:
            label
                .frame(width: max(60, m.size.width / 2 - m.r - 18), alignment: .leading)
                .position(x: c.x + m.r + 10 + max(60, m.size.width / 2 - m.r - 18) / 2, y: c.y)
        case .grid:
            label
                .frame(width: max(70, m.size.width / 2 - m.hubR - 16), alignment: .leading)
                .position(x: 8 + max(70, m.size.width / 2 - m.hubR - 16) / 2, y: c.y + m.r + 24)
        case .home:
            label
                .frame(width: max(70, m.size.width / 2 - m.hubR - 16), alignment: .trailing)
                .position(x: m.size.width - 8 - max(70, m.size.width / 2 - m.hubR - 16) / 2, y: c.y + m.r + 24)
        }
    }

    struct NodeInfo { let title: String; let icon: String; let value: String; let caption: String }

    static func info(_ n: FlowEdge.Node, _ s: LiveStatus) -> NodeInfo {
        switch n {
        case .pv:
            return NodeInfo(title: "PV", icon: "sun.max.fill", value: Format.power(s.pvTotalW), caption: String(localized: "Erzeugung"))
        case .home:
            return NodeInfo(title: String(localized: "Haus"), icon: "house.fill", value: Format.power(s.loadW), caption: String(localized: "Verbrauch"))
        case .battery:
            let w = s.batteryPowerW
            let cap: String
            let soc = Format.percent(s.soc)
            if let w, abs(w) >= FlowEdge.idleW {
                cap = w > 0 ? String(localized: "lädt · \(soc)") : String(localized: "entlädt · \(soc)")
            } else {
                cap = String(localized: "Ruhe · \(soc)")
            }
            return NodeInfo(title: String(localized: "Akku"), icon: StatusText.batteryIcon(s.soc), value: Format.power(w), caption: cap)
        case .grid:
            return NodeInfo(title: String(localized: "Netz"), icon: "bolt.horizontal.fill", value: Format.power(StatusText.gridValue(s)), caption: StatusText.gridCaption(s))
        }
    }
}

/// Texte zum Kompakt-Status, die mehrere Ansichten brauchen.
enum StatusText {
    static func batteryIcon(_ soc: Double?) -> String {
        guard let soc else { return "battery.0percent" }
        switch soc {
        case ..<13: return "battery.0percent"
        case ..<38: return "battery.25percent"
        case ..<63: return "battery.50percent"
        case ..<88: return "battery.75percent"
        default: return "battery.100percent"
        }
    }

    /// DVhub: + = Laden, − = Entladen.
    static func batteryCaption(_ s: LiveStatus) -> String {
        guard let w = s.batteryPowerW else { return "–" }
        if abs(w) < FlowEdge.idleW { return String(localized: "Ruhe") }
        return w > 0 ? String(localized: "lädt \(Format.power(w))") : String(localized: "entlädt \(Format.power(w))")
    }

    static func gridValue(_ s: LiveStatus) -> Double? {
        if s.gridImportW == nil && s.gridExportW == nil { return nil }
        return max(s.gridImportW ?? 0, s.gridExportW ?? 0)
    }

    static func gridCaption(_ s: LiveStatus) -> String {
        guard s.gridImportW != nil || s.gridExportW != nil else { return String(localized: "kein Zähler") }
        let imp = s.gridImportW ?? 0, exp = s.gridExportW ?? 0
        if max(imp, exp) < FlowEdge.idleW { return String(localized: "ausgeglichen") }
        return imp >= exp ? String(localized: "Bezug") : String(localized: "Einspeisung")
    }

    static func isExporting(_ s: LiveStatus) -> Bool { (s.gridExportW ?? 0) > (s.gridImportW ?? 0) }
}
