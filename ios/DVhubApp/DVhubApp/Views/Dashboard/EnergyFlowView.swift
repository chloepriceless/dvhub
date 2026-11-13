// EnergyFlowView.swift — Energiefluss mit Partikeln: PV oben, Netz links, Haus
// rechts, Akku unten, alles über die Mitte. Partikel laufen in Flussrichtung;
// Dichte und Tempo folgen der Leistung (FlowEdge im Paket DVhubLink).
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
                hub(m)
                node(.pv, m)
                node(.grid, m)
                node(.home, m)
                node(.battery, m)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Energiefluss")
    }

    // MARK: Maße

    struct Metrics {
        let size: CGSize
        let r: CGFloat
        let hubR: CGFloat
        let hub: CGPoint

        init(size: CGSize) {
            self.size = size
            r = max(26, min(40, min(size.width, size.height) * 0.105))
            hubR = r * 0.72
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

    private func draw(_ ctx: inout GraphicsContext, m: Metrics, time: Date?) {
        for e in edges {
            let (a, b) = m.segment(e.node)
            let color = Self.color(e.node)
            var line = Path()
            line.move(to: a)
            line.addLine(to: b)
            // Leitung: ruhend haarfein, aktiv mit Lichtschein.
            if e.active {
                ctx.drawLayer { l in
                    l.addFilter(.blur(radius: 5))
                    l.stroke(line, with: .color(color.opacity(0.35)), style: StrokeStyle(lineWidth: 5, lineCap: .round))
                }
                ctx.stroke(line, with: .color(color.opacity(0.45)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            } else {
                ctx.stroke(line, with: .color(Brand.dim.opacity(0.35)), style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [2, 5]))
                continue
            }
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
            let n = e.particleCount
            let phase = phases.phase[e.node] ?? 0
            // Schweif-Länge wächst mit dem Tempo.
            let tail = min(0.16, 0.05 + e.speed * 0.06)
            var glow = Path()
            var cores: [(CGPoint, CGFloat)] = []
            for i in 0..<n {
                var along = (phase + Double(i) / Double(n)).truncatingRemainder(dividingBy: 1)
                if along < 0 { along += 1 }
                let head = e.towardHub ? along : 1 - along
                let back = e.towardHub ? max(0, head - tail) : min(1, head + tail)
                let ph = CGPoint(x: a.x + dx * head, y: a.y + dy * head)
                let pb = CGPoint(x: a.x + dx * back, y: a.y + dy * back)
                glow.move(to: pb)
                glow.addLine(to: ph)
                // An den Enden weich ein- und ausblenden.
                cores.append((ph, CGFloat(sin(.pi * along)).squareRoot()))
            }
            ctx.drawLayer { l in
                l.addFilter(.blur(radius: 3))
                l.stroke(glow, with: .color(color.opacity(0.9)), style: StrokeStyle(lineWidth: 4, lineCap: .round))
            }
            ctx.stroke(glow, with: .color(color.opacity(0.55)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            let core = scheme == .dark ? Color.white : color
            for (p, alpha) in cores {
                let rr: CGFloat = len > 60 ? 2.4 : 1.8
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - rr, y: p.y - rr, width: rr * 2, height: rr * 2)), with: .color(core.opacity(Double(alpha))))
            }
        }
    }

    // MARK: Knoten

    private func hub(_ m: Metrics) -> some View {
        ZStack {
            Circle().fill(Brand.bg0.opacity(0.85))
            Circle().strokeBorder(Brand.aurora, lineWidth: 2.5)
            Image(systemName: "bolt.fill")
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
            return NodeInfo(title: "PV", icon: "sun.max.fill", value: Format.power(s.pvTotalW), caption: "Erzeugung")
        case .home:
            return NodeInfo(title: "Haus", icon: "house.fill", value: Format.power(s.loadW), caption: "Verbrauch")
        case .battery:
            let w = s.batteryPowerW
            let cap: String
            if let w, abs(w) >= FlowEdge.idleW { cap = (w > 0 ? "lädt · " : "entlädt · ") + Format.percent(s.soc) } else { cap = "Ruhe · " + Format.percent(s.soc) }
            return NodeInfo(title: "Akku", icon: StatusText.batteryIcon(s.soc), value: Format.power(w), caption: cap)
        case .grid:
            return NodeInfo(title: "Netz", icon: "bolt.horizontal.fill", value: Format.power(StatusText.gridValue(s)), caption: StatusText.gridCaption(s))
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
        if abs(w) < FlowEdge.idleW { return "Ruhe" }
        return (w > 0 ? "lädt " : "entlädt ") + Format.power(w)
    }

    static func gridValue(_ s: LiveStatus) -> Double? {
        if s.gridImportW == nil && s.gridExportW == nil { return nil }
        return max(s.gridImportW ?? 0, s.gridExportW ?? 0)
    }

    static func gridCaption(_ s: LiveStatus) -> String {
        guard s.gridImportW != nil || s.gridExportW != nil else { return "kein Zähler" }
        let imp = s.gridImportW ?? 0, exp = s.gridExportW ?? 0
        if max(imp, exp) < FlowEdge.idleW { return "ausgeglichen" }
        return imp >= exp ? "Bezug" : "Einspeisung"
    }

    static func isExporting(_ s: LiveStatus) -> Bool { (s.gridExportW ?? 0) > (s.gridImportW ?? 0) }
}
