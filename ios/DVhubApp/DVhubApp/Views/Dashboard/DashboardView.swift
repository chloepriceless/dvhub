// DashboardView.swift — Leitstand. Jede Angabe steht genau einmal:
//   • der Energiefluss sagt, was JETZT fließt (Leistung an jedem Knoten),
//   • die Karten darunter sagen, was HEUTE zusammenkam (Energie, Spitze,
//     Tagesverlauf) — keine zweite Anzeige der Momentanwerte,
//   • dazu Erlös und Kosten, der Preisverlauf, Zustand und Meldungen.

import SwiftUI
import Charts
import DVhubLink

enum DetailKind: String, Hashable, CaseIterable {
    case pv, battery, grid, home, money, state

    static func from(_ n: FlowEdge.Node) -> DetailKind {
        switch n {
        case .pv: return .pv
        case .battery: return .battery
        case .grid: return .grid
        case .home: return .home
        }
    }
}

struct DashboardView: View {
    let controller: SystemController
    var open: (DetailKind) -> Void
    var openMarket: () -> Void
    @Environment(MarketStore.self) private var market
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        AuroraPage { width in
            HStack {
                ConnectionBadge(controller: controller)
                if let at = controller.displayAt {
                    Text(Format.time(at)).font(.caption.monospacedDigit()).foregroundStyle(Brand.dim)
                        .accessibilityLabel("Stand \(Format.dateTime(at))")
                }
            }
            if let banner { NoticeBanner(text: banner) }
            if let s = controller.displayStatus {
                // Spaltenwahl nach `width`, Maße nach der tatsächlichen Breite.
                let pageWidth = typeSize.pageWidth(width)
                if Layout.isWide(width) {
                    HStack(alignment: .top, spacing: 14) {
                        // Höhe folgt der Spaltenbreite — im Querformat ist wenig Höhe da.
                        flowCard(s, height: max(320, min(440, (pageWidth - max(300, pageWidth * 0.44)) * 1.12)))
                        VStack(alignment: .leading, spacing: 14) {
                            todayGrid
                            moneyCard(s)
                        }
                        .frame(width: max(300, pageWidth * 0.44))
                    }
                    HStack(alignment: .top, spacing: 14) {
                        marketCard
                        stateCard(s)
                    }
                } else {
                    flowCard(s, height: min(380, max(290, pageWidth * 0.84)))
                    todayGrid
                    moneyCard(s)
                    marketCard
                    stateCard(s)
                }
                if !controller.events.isEmpty { eventsCard }
            } else {
                GlassCard {
                    EmptyState(title: "Noch keine Werte", icon: "antenna.radiowaves.left.and.right",
                               text: String(localized: "Sobald die Anlage antwortet, erscheinen hier die Live-Werte."))
                }
            }
        }
        .navigationTitle(controller.credentials.boxName)
        .animation(.default, value: controller.displayStatus)
        .task(id: controller.isOnline) {
            // Tageswerte der Karten: beim Öffnen und dann alle zehn Minuten.
            // Der volle Status liefert den eigenen Bezugspreis für die Preis-Karte.
            while !Task.isCancelled && controller.isOnline {
                await controller.refreshDetail(maxAge: 600)
                await controller.refreshToday()
                try? await Task.sleep(nanoseconds: 600 * 1_000_000_000)
            }
        }
        .task { await market.refresh() }
    }

    private var banner: String? {
        switch controller.state {
        case .boxOffline, .offline:
            if let at = controller.mailboxAt { return String(localized: "Anlage gerade nicht erreichbar – letzter Stand von \(Format.dateTime(at)).") }
            return String(localized: "Anlage gerade nicht erreichbar.")
        default: return nil
        }
    }

    // MARK: Energiefluss

    private func flowCard(_ s: LiveStatus, height: CGFloat) -> some View {
        GlassCard(tint: Brand.cyan, padding: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Eyebrow(text: "Energiefluss", tint: Brand.cyan)
                    Spacer()
                    if let w = s.gridSetpointW, abs(w) > 0 {
                        Text("Sollwert \(Format.signedPower(w))").font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
                    }
                }
                EnergyFlowView(status: s) { open(.from($0)) }
                    .frame(height: height - 40)
            }
        }
    }

    // MARK: Karten

    /// Energie und Spitze eines Tages aus dem Verlauf (5-Minuten-Mittel der Box).
    private func energy(_ key: String, _ part: (Double) -> Double = { $0 }) -> DayEnergy? {
        DayEnergy.from(controller.todayValues(key).map { (date: $0.date, watts: part($0.value)) })
    }

    private static func peak(_ e: DayEnergy?) -> String {
        guard let e, e.peakW > 0 else { return String(localized: "noch kein Verlauf") }
        return String(localized: "Spitze \(Format.power(e.peakW)) · \(Format.time(e.peakAt))")
    }

    /// Was heute zusammenkam. Die Momentanwerte stehen im Energiefluss — hier
    /// stehen Tagesenergie, Spitze und Verlauf, also nichts doppelt.
    private var todayGrid: some View {
        let loadKey = controller.todayValues("load_power_w").isEmpty ? "self_consumption_w" : "load_power_w"
        let pv = energy("pv_total_w"), load = energy(loadKey)
        let exported = energy("grid_export_w"), imported = energy("grid_import_w")
        // DVhub: Akku + = Laden, − = Entladen.
        let charged = energy("battery_power_w") { max(0, $0) }, discharged = energy("battery_power_w") { max(0, -$0) }
        // In den Bedienungshilfen-Größen eine Karte je Zeile.
        let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: typeSize.isAccessibilitySize ? 1 : 2)
        return VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: "Heute bisher", icon: "sun.horizon", tint: Brand.text2)
            LazyVGrid(columns: columns, spacing: 12) {
                MetricCard(cardId: "PV", title: String(localized: "Erzeugt"), tint: Brand.pv, value: Format.energy(pv?.kwh), caption: Self.peak(pv),
                           spark: controller.todayValues("pv_total_w"), valueId: "pvToday") { open(.pv) }
                MetricCard(cardId: "Haus", title: String(localized: "Verbraucht"), tint: Brand.home, value: Format.energy(load?.kwh), caption: Self.peak(load),
                           spark: controller.todayValues(loadKey), valueId: "loadToday") { open(.home) }
                MetricCard(cardId: "Akku", title: String(localized: "Akku geladen"), tint: Brand.battery, value: Format.energy(charged?.kwh),
                           caption: String(localized: "entladen \(Format.energy(discharged?.kwh))"),
                           spark: controller.todayValues(BoxData.socKey), sparkRange: 0...100, sparkLabel: String(localized: "Ladestand")) { open(.battery) }
                MetricCard(cardId: "Netz", title: String(localized: "Eingespeist"), tint: Brand.grid, value: Format.energy(exported?.kwh),
                           caption: String(localized: "bezogen \(Format.energy(imported?.kwh))"),
                           spark: gridSpark, sparkLabel: String(localized: "oben Einspeisung, unten Bezug")) { open(.grid) }
            }
        }
    }

    /// Netz als eine Linie: Einspeisung nach oben, Bezug nach unten.
    private var gridSpark: [SeriesPoint] {
        let imp = Dictionary(controller.todayValues("grid_import_w").map { ($0.date, $0.value) }, uniquingKeysWith: { a, _ in a })
        let exp = controller.todayValues("grid_export_w")
        if exp.isEmpty { return controller.todayValues("grid_import_w").map { SeriesPoint(key: "grid", date: $0.date, value: -$0.value) } }
        return exp.map { SeriesPoint(key: "grid", date: $0.date, value: $0.value - (imp[$0.date] ?? 0)) }
    }

    private func moneyCard(_ s: LiveStatus) -> some View {
        let net = s.todayNetEur
        let tint = (net ?? 0) >= 0 ? Brand.money : Brand.red
        return Button { open(.money) } label: {
            GlassCard(tint: tint) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Eyebrow(text: "Erlös und Kosten heute", icon: "eurosign.circle.fill", tint: tint)
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(Brand.dim)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        MetricValue(value: Format.signedEuro(net), style: .largeTitle, color: tint)
                        Text((net ?? 0) >= 0 ? String(localized: "verdient") : String(localized: "gekostet")).font(.subheadline).foregroundStyle(Brand.text2)
                    }
                    MoneyBar(revenue: s.todayRevenueEur ?? 0, cost: s.todayCostEur ?? 0)
                    HStack {
                        Label("Erlös \(Format.euro(s.todayRevenueEur))", systemImage: "arrow.up.right").foregroundStyle(Brand.money)
                        Spacer(minLength: 8)
                        Label("Kosten \(Format.euro(s.todayCostEur))", systemImage: "arrow.down.right").foregroundStyle(Brand.red)
                    }
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                }
            }
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Heute \(Format.euro(net)) netto, Erlös \(Format.euro(s.todayRevenueEur)), Kosten \(Format.euro(s.todayCostEur))")
        .accessibilityHint("Zeigt Erlöse und Kosten im Detail")
        .accessibilityIdentifier("moneyCard")
    }

    /// Preise: der Tagesverlauf und was vorausliegt. Der Preis der laufenden
    /// Viertelstunde steht klein dabei — er allein sagt wenig.
    private var marketCard: some View {
        let today = market.prices(on: market.today)
        let now = market.currentPrice
        let importNow = controller.detail?.importPriceNowCtKwh
        // Die kommenden Tage wie im Markt: morgen aus Börsenpreisen eingestuft, danach die Prognose.
        let ahead = MarketDay.build(today: market.today, tomorrow: market.tomorrow, prices: { market.prices(on: $0) }, outlook: market.outlook)
            .filter { $0.date > market.today }
        let warn = ahead.first { $0.priceClass == .expensive }
        return Button(action: openMarket) {
            GlassCard(tint: Brand.blue) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Eyebrow(text: "Preise", icon: "chart.bar.fill", tint: Brand.blue)
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(Brand.dim)
                    }
                    if let warn {
                        Label("Teurer Tag voraus: \(MarketStyle.weekday(warn.date)) ⌀ \(Format.ct(warn.meanCt))", systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.red)
                    } else if let cheap = ahead.first(where: { $0.priceClass == .cheap }) {
                        Label("Günstiger Tag voraus: \(MarketStyle.weekday(cheap.date)) ⌀ \(Format.ct(cheap.meanCt))", systemImage: "arrow.down.circle.fill")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.green)
                    } else if market.outlook != nil {
                        Label("Keine teuren Tage in Sicht", systemImage: "checkmark.seal").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.text)
                    }
                    if !today.isEmpty {
                        MiniPriceBars(slots: today).frame(height: 40)
                    }
                    if let now {
                        Text(importNow.map { String(localized: "Gerade: Einspeisung \(Format.ct(now.ctKwh)) · Bezug \(Format.ct($0))") }
                             ?? String(localized: "Gerade: Börse \(Format.ct(now.ctKwh))"))
                            .font(.caption.monospacedDigit()).foregroundStyle(Brand.text2)
                    }
                }
            }
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Öffnet den Markt")
        .accessibilityIdentifier("marketCard")
    }

    private func stateCard(_ s: LiveStatus) -> some View {
        let tint = StateLines.color(s)
        return Button { open(.state) } label: {
            GlassCard(tint: tint) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Eyebrow(text: "Zustand", icon: "checkmark.shield.fill", tint: tint)
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(Brand.dim)
                    }
                    StateLines(status: s)
                }
            }
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("stateCard")
    }

    /// Meldungen aus dem Briefkasten (Alarme, Not-Halt), neueste zuerst.
    private var eventsCard: some View {
        GlassCard(tint: Brand.violet) {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Meldungen", icon: "bell.badge", tint: Brand.violet)
                EventList(events: Array(controller.events.prefix(4)))
            }
        }
        .accessibilityIdentifier("eventsList")
    }
}

// MARK: - Bausteine

struct MetricCard: View {
    /// Feste Kennung für Tests — unabhängig von der Sprache.
    let cardId: String
    let title: String
    let tint: Color
    let value: String
    let caption: String
    var spark: [SeriesPoint] = []
    var sparkRange: ClosedRange<Double>? = nil
    /// Was die Linie zeigt, wenn es nicht der Wert darüber ist (z. B. Ladestand).
    var sparkLabel: String? = nil
    var valueId: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Eyebrow(text: title, tint: tint)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(Brand.dim)
                }
                MetricValue(value: value, id: valueId)
                Text(caption).font(.footnote).foregroundStyle(Brand.text2).lineLimit(1).minimumScaleFactor(0.8)
                Sparkline(points: spark, tint: tint, range: sparkRange)
                    .frame(height: 30)
                    .padding(.top, 2)
                if let sparkLabel {
                    Text(sparkLabel).font(.caption2).foregroundStyle(Brand.dim).lineLimit(1).minimumScaleFactor(0.7)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .background(CardBackground(tint: tint))
        }
        .buttonStyle(CardButtonStyle())
        // Kinder bleiben einzeln erreichbar (Wert mit eigener Kennung für UI-Tests);
        // VoiceOver liest die Karte als einen Knopf.
        .accessibilityElement(children: .combine)
        .accessibilityHint("Zeigt Detailwerte")
        .accessibilityIdentifier("card.\(cardId)")
    }
}

/// Tagesverlauf als feine Linie ohne Achsen.
struct Sparkline: View {
    let points: [SeriesPoint]
    let tint: Color
    var range: ClosedRange<Double>? = nil

    var body: some View {
        Canvas { ctx, size in
            let pts = Self.thin(points, to: 120)
            guard pts.count > 1, let t0 = pts.first?.date.timeIntervalSince1970 else {
                var base = Path()
                base.move(to: CGPoint(x: 0, y: size.height - 1))
                base.addLine(to: CGPoint(x: size.width, y: size.height - 1))
                ctx.stroke(base, with: .color(Brand.hairline), lineWidth: 1)
                return
            }
            // Zeitachse: ganzer Tag, damit die Linie im Tagesverlauf „wächst“.
            let dayStart = Calendar.current.startOfDay(for: pts[0].date).timeIntervalSince1970
            let span = max(86400, (pts.last!.date.timeIntervalSince1970 - min(t0, dayStart)))
            let lo = range?.lowerBound ?? min(0, pts.map(\.value).min() ?? 0)
            let hi = range?.upperBound ?? max(pts.map(\.value).max() ?? 1, lo + 1)
            let x = { (d: Date) in CGFloat((d.timeIntervalSince1970 - min(t0, dayStart)) / span) * size.width }
            let y = { (v: Double) in size.height - 1 - CGFloat((v - lo) / (hi - lo)) * (size.height - 2) }
            var line = Path()
            line.move(to: CGPoint(x: x(pts[0].date), y: y(pts[0].value)))
            for p in pts.dropFirst() { line.addLine(to: CGPoint(x: x(p.date), y: y(p.value))) }
            var area = line
            let zero = y(max(lo, min(hi, 0)))
            area.addLine(to: CGPoint(x: x(pts.last!.date), y: zero))
            area.addLine(to: CGPoint(x: x(pts[0].date), y: zero))
            area.closeSubpath()
            ctx.fill(area, with: .linearGradient(Gradient(colors: [tint.opacity(0.35), tint.opacity(0.02)]),
                                                 startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
            ctx.stroke(line, with: .color(tint), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
            let last = CGPoint(x: x(pts.last!.date), y: y(pts.last!.value))
            ctx.fill(Path(ellipseIn: CGRect(x: last.x - 2.5, y: last.y - 2.5, width: 5, height: 5)), with: .color(tint))
        }
        .accessibilityHidden(true)
    }

    static func thin(_ p: [SeriesPoint], to n: Int) -> [SeriesPoint] {
        guard p.count > n else { return p }
        let step = Double(p.count) / Double(n)
        return (0..<n).map { p[min(p.count - 1, Int(Double($0) * step))] } + [p[p.count - 1]]
    }
}

/// Erlös gegen Kosten als zweifarbiger Balken.
struct MoneyBar: View {
    let revenue: Double
    let cost: Double

    var body: some View {
        GeometryReader { g in
            let total = max(0.0001, abs(revenue) + abs(cost))
            let w = g.size.width * CGFloat(abs(revenue) / total)
            HStack(spacing: 2) {
                Capsule().fill(Brand.money).frame(width: max(3, w - 1))
                Capsule().fill(Brand.red.opacity(0.85))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

/// Viertelstunden des Tages als kleine Balken, die laufende hervorgehoben.
struct MiniPriceBars: View {
    let slots: [PricePoint]

    var body: some View {
        Canvas { ctx, size in
            guard let lo = slots.map(\.ctKwh).min(), let hi = slots.map(\.ctKwh).max(), !slots.isEmpty else { return }
            let now = Date()
            let minV = min(0, lo), maxV = max(hi, minV + 1)
            let zero = size.height * CGFloat(maxV / (maxV - minV))
            let w = size.width / CGFloat(slots.count)
            for (i, p) in slots.enumerated() {
                let h = CGFloat(abs(p.ctKwh) / (maxV - minV)) * size.height
                let rect = CGRect(x: CGFloat(i) * w, y: p.ctKwh >= 0 ? zero - h : zero, width: max(1, w - 0.6), height: max(1, h))
                let c: Color = p.contains(now) ? Brand.now : (p.ctKwh < 0 ? Brand.priceDown : Brand.priceUp).opacity(p.end <= now ? 0.35 : 0.85)
                ctx.fill(Path(rect), with: .color(c))
            }
        }
        .accessibilityHidden(true)
    }
}

struct StateLines: View {
    let status: LiveStatus

    static func color(_ s: LiveStatus) -> Color {
        if s.emergencyStop == true || (s.alarmsActive ?? 0) > 0 { return Brand.red }
        if s.telemetryFrozen == true || s.alarmsStale == true { return Brand.orange }
        return Brand.green
    }

    var body: some View {
        let s = status
        let alarms = s.alarmsActive ?? 0
        VStack(alignment: .leading, spacing: 5) {
            if s.emergencyStop == true {
                Label("Not-Halt aktiv", systemImage: "exclamationmark.octagon.fill").foregroundStyle(Brand.red).fontWeight(.semibold)
            }
            Label(alarms == 0 ? String(localized: "Keine Alarme") : MailboxEvent.text(alarms: alarms, emergencyStop: false),
                  systemImage: alarms == 0 ? "bell" : "bell.badge.fill")
                .foregroundStyle(alarms == 0 ? Brand.text2 : Brand.red)
            if s.alarmsStale == true { Label("Alarm-Überwachung veraltet", systemImage: "clock.badge.exclamationmark").foregroundStyle(Brand.orange) }
            if s.controls?.dv?.curtailed == true {
                Label("Abregelung durch Direktvermarkter\(s.controls?.dv?.limitPct.map { " (\(Format.percent($0)))" } ?? "")", systemImage: "arrow.down.to.line")
                    .foregroundStyle(Brand.orange)
            }
            if s.controls?.negativePrice?.active == true { Label("Negativpreis-Schutz aktiv", systemImage: "minus.circle").foregroundStyle(Brand.orange) }
            if s.controls?.p14a?.active == true { Label("§14a-Begrenzung aktiv", systemImage: "gauge.with.dots.needle.33percent").foregroundStyle(Brand.orange) }
            if s.controls?.feedInLimit?.blocked == true { Label("Einspeisung gesperrt", systemImage: "nosign").foregroundStyle(Brand.orange) }
            if s.telemetryFrozen == true { Label("Messwerte eingefroren", systemImage: "snowflake").foregroundStyle(Brand.orange) }
            if s.emergencyStop != true && alarms == 0 { Label("Regelung läuft", systemImage: "checkmark.circle").foregroundStyle(Brand.green) }
        }
        .font(.footnote)
    }
}

struct EventList: View {
    let events: [MailboxEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(events) { e in
                let bad = e.emergencyStop || e.alarmsActive > 0
                HStack(alignment: .firstTextBaseline) {
                    Image(systemName: bad ? "exclamationmark.triangle.fill" : "checkmark.circle")
                        .foregroundStyle(bad ? Brand.red : Brand.green)
                    Text(e.text).foregroundStyle(Brand.text)
                    Spacer(minLength: 8)
                    Text(Format.dateTime(e.at)).foregroundStyle(Brand.dim).monospacedDigit()
                }
                .font(.footnote)
                .accessibilityElement(children: .combine)
            }
        }
    }
}
