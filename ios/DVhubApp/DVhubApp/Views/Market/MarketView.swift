// MarketView.swift — Markt: Börsenpreise und die Vorhersage der nächsten Tage.
//
// Drei Dinge, mehr nicht:
//   1. der Börsenpreis jetzt,
//   2. die Tage als Karten — Datum, erwarteter Preis mit Spanne, Ampel
//      (günstig / normal / teuer); heute und morgen sind feste Börsentage,
//   3. ein Diagramm auf einer Zeitachse: feste Viertelstunden-Preise als
//      Balken, danach die Prognose als Linie mit Band.
// Daten: dvhub.online (öffentlich), eigener Bezugspreis aus der Box.

import SwiftUI
import Charts
import DVhubLink

/// Ein Tag der Tagesleiste — fest (Börse) oder Prognose.
struct MarketDay: Identifiable, Equatable {
    let key: String
    let date: Date
    var known: ResidualOutlook.KnownDay?
    var forecast: ResidualOutlook.Day?
    /// Viertelstunden der Börse (nur feste Tage).
    var slots: [PricePoint] = []
    /// Ampel: bei Prognosetagen aus der Prognose, bei festen Tagen aus dem
    /// Tagesmittel nach denselben Schwellen.
    var priceClass: PriceClass?
    var id: String { key }

    var isFixed: Bool { forecast == nil }
    var meanCt: Double? {
        if let f = forecast { return f.band.p50 }
        if let s = PriceSeries.stats(slots) { return s.average }
        return known?.meanCt
    }
    /// Spanne: Band der Prognose bzw. Tagestief bis Tageshoch.
    var rangeCt: (Double, Double)? {
        if let f = forecast { return (f.band.p10, f.band.p90) }
        if let s = PriceSeries.stats(slots) { return (s.min.ctKwh, s.max.ctKwh) }
        if let k = known, let lo = k.minCt, let hi = k.maxCt { return (lo, hi) }
        return nil
    }
}

struct MarketView: View {
    let controller: SystemController?
    @Environment(MarketStore.self) private var market
    @State private var selectedKey: String = MarketTime.key(Date())
    @State private var boxPrices: [PricePoint] = []
    @State private var debugDayApplied = false

    var body: some View {
        AuroraPage { width in
            let days = self.days
            let selected = days.first { $0.key == selectedKey } ?? days.first
            if let err = market.priceError, market.prices.isEmpty { NoticeBanner(text: err, icon: "wifi.slash") }
            NowPriceCard(point: currentPoint, today: days.first { $0.key == MarketTime.key(Date()) }, importCt: currentImportCt)
            if !days.isEmpty {
                DayStrip(days: days, scale: scale(days), selected: $selectedKey, outlook: market.outlook, wide: Layout.isWide(width))
                TimelineCard(days: days, selected: selected, prices: chartPrices, hours: market.outlook?.hours ?? [], wide: Layout.isWide(width))
            } else if market.loading {
                ProgressView().frame(maxWidth: .infinity, minHeight: 200)
            }
            if let o = market.outlook, o.isStale() {
                NoticeBanner(text: "Die Prognose ist älter als 18 Stunden und kann überholt sein.")
            } else if let err = market.outlookError, market.outlook == nil {
                NoticeBanner(text: "Prognose nicht verfügbar: \(err)", icon: "wifi.slash")
            }
            Text("Börsenpreise (Day-Ahead DE-LU) und Prognose: dvhub.online\(market.pricesAt.map { " · Stand \(Format.dateTime($0))" } ?? ""). Ohne Netzentgelte, Steuern und Abgaben; Prognose ohne Gewähr.")
                .font(.caption2)
                .foregroundStyle(Brand.dim)
        }
        .navigationTitle("Markt")
        .screenActions(.market, [
            ScreenAction(id: "refresh", title: "Aktualisieren", icon: "arrow.clockwise", disabled: market.loading) {
                Task { await market.refresh(force: true) }
            },
        ])
        .refreshable { await market.refresh(force: true) }
        .task { await market.refresh() }
        .task(id: controller?.isOnline) { await loadBoxPrices() }
        .onChange(of: days.map(\.key), initial: true) { _, keys in
            #if DEBUG
            // Nur für Bildschirmfotos: -DVHUB_MARKET_DAY <n> wählt den n-ten Tag der Leiste.
            if let n = Int(UserDefaults.standard.string(forKey: "DVHUB_MARKET_DAY") ?? ""), keys.indices.contains(n), !debugDayApplied {
                debugDayApplied = true
                selectedKey = keys[n]
                return
            }
            #endif
            if !keys.contains(selectedKey), let first = keys.first { selectedKey = first }
        }
    }

    // MARK: Daten

    /// Heute, morgen (sobald fest) und die Prognosetage.
    private var days: [MarketDay] {
        var out: [String: MarketDay] = [:]
        let todayKey = MarketTime.key(Date())
        for d in [market.today, market.tomorrow] {
            let slots = market.prices(on: d)
            if !slots.isEmpty { out[MarketTime.key(d)] = MarketDay(key: MarketTime.key(d), date: d, slots: slots) }
        }
        for k in market.outlook?.knownDays ?? [] where k.key >= todayKey {
            var day = out[k.key] ?? MarketDay(key: k.key, date: k.date)
            day.known = k
            out[k.key] = day
        }
        for f in market.outlook?.days ?? [] where f.key >= todayKey && out[f.key] == nil {
            out[f.key] = MarketDay(key: f.key, date: f.date, forecast: f)
        }
        return out.values.sorted { $0.date < $1.date }.map { d in
            var d = d
            d.priceClass = d.forecast?.priceClass ?? d.meanCt.flatMap { market.outlook?.classify(meanCt: $0) }
            return d
        }
    }

    /// Feste Preise ab heute für das Diagramm.
    private var chartPrices: [PricePoint] { market.prices.filter { $0.start >= market.today } }

    /// Gemeinsame Preisspanne aller Tage — so sind die Spannen vergleichbar.
    private func scale(_ days: [MarketDay]) -> ClosedRange<Double> {
        var lo = 0.0, hi = 1.0
        for d in days { if let r = d.rangeCt { lo = min(lo, r.0); hi = max(hi, r.1) } }
        return lo...max(hi, lo + 1)
    }

    private var currentPoint: PricePoint? { market.currentPrice ?? PriceSeries.current(boxPrices) }
    private var currentImportCt: Double? { PriceSeries.current(boxPrices)?.importCtKwh }

    /// Eigener Bezugspreis je Viertelstunde aus der Box (Tarif aus DVhub).
    private func loadBoxPrices() async {
        guard let controller, controller.isOnline else { return }
        guard let r = try? await controller.request("GET", "/api/status"), r.status == 200 else { return }
        boxPrices = PriceSeries.from(status: r.body)
    }
}

// MARK: - Farben und Texte

enum MarketStyle {
    static func color(_ c: PriceClass?) -> Color {
        switch c {
        case .cheap: return Brand.green
        case .expensive: return Brand.red
        case .normal: return Brand.yellow
        case nil: return Brand.dim
        }
    }

    static func icon(_ c: PriceClass?) -> String {
        switch c {
        case .cheap: return "arrow.down.circle.fill"
        case .expensive: return "exclamationmark.triangle.fill"
        default: return "equal.circle.fill"
        }
    }

    static func weekday(_ d: Date) -> String {
        let cal = MarketTime.calendar
        if cal.isDateInToday(d) { return "Heute" }
        if cal.isDateInTomorrow(d) { return "Morgen" }
        var f = Date.FormatStyle.dateTime.weekday(.abbreviated).locale(Format.de)
        f.timeZone = MarketTime.zone
        return d.formatted(f)
    }

    static func dayMonth(_ d: Date) -> String {
        var f = Date.FormatStyle.dateTime.day().month(.twoDigits).locale(Format.de)
        f.timeZone = MarketTime.zone
        return d.formatted(f)
    }

    static func longDay(_ d: Date) -> String {
        var f = Date.FormatStyle.dateTime.weekday(.wide).day().month(.wide).locale(Format.de)
        f.timeZone = MarketTime.zone
        return d.formatted(f)
    }

    static func hour(_ d: Date) -> String {
        var f = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(Format.de)
        f.timeZone = MarketTime.zone
        return d.formatted(f)
    }

    static func range(_ a: Date, _ b: Date) -> String { "\(hour(a))–\(hour(b))" }

    static func ct1(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "–" }
        return v.formatted(.number.precision(.fractionLength(1)).locale(Format.de))
    }

    static func pct(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "–" }
        return (v * 100).formatted(.number.precision(.fractionLength(0)).locale(Format.de)) + " %"
    }
}

/// Stundenachse in deutscher Zeit.
func MarketHourAxis(everyHours: Int = 6) -> some AxisContent {
    AxisMarks(values: .stride(by: .hour, count: everyHours, calendar: MarketTime.calendar)) { value in
        AxisGridLine().foregroundStyle(Brand.hairline)
        if let d = value.as(Date.self) {
            AxisValueLabel {
                Text(String(format: "%02d", MarketTime.calendar.component(.hour, from: d)))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Brand.dim)
            }
        }
    }
}

func CtAxis() -> some AxisContent {
    AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
        AxisGridLine().foregroundStyle(Brand.hairline)
        AxisValueLabel {
            if let v = value.as(Double.self) {
                Text(v.formatted(.number.precision(.fractionLength(0)).locale(Format.de)))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Brand.dim)
            }
        }
    }
}

// MARK: - Jetzt

private struct NowPriceCard: View {
    let point: PricePoint?
    let today: MarketDay?
    let importCt: Double?

    var body: some View {
        GlassCard(tint: tint) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Eyebrow(text: "Börse jetzt", icon: "chart.bar.fill", tint: tint)
                    Spacer()
                    if let level { Pill(text: level.0, tint: level.1) }
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    MetricValue(value: MarketStyle.ct1(point?.ctKwh), style: .largeTitle, id: "marketNowPrice")
                    Text("ct/kWh").font(.subheadline).foregroundStyle(Brand.text2)
                    Spacer()
                    if let importCt {
                        VStack(alignment: .trailing, spacing: 0) {
                            Text("Mein Bezug").font(.caption2).foregroundStyle(Brand.dim)
                            Text(Format.ct(importCt)).font(.system(.headline, design: .rounded)).monospacedDigit().foregroundStyle(Brand.text)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                if let s = stats, let p = point {
                    DayPositionBar(min: s.min.ctKwh, max: s.max.ctKwh, average: s.average, value: p.ctKwh, tint: tint)
                    HStack {
                        Text("Tief \(MarketStyle.ct1(s.min.ctKwh)) · \(MarketStyle.hour(s.min.start))")
                        Spacer()
                        Text("⌀ \(MarketStyle.ct1(s.average))")
                        Spacer()
                        Text("Hoch \(MarketStyle.ct1(s.max.ctKwh)) · \(MarketStyle.hour(s.max.start))")
                    }
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Brand.text2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                } else if point == nil {
                    Text("Noch keine Preise geladen.").font(.footnote).foregroundStyle(Brand.text2)
                }
            }
        }
    }

    private var stats: PriceStats? { today.flatMap { PriceSeries.stats($0.slots) } }
    private var tint: Color { (point?.ctKwh ?? 0) < 0 ? Brand.red : Brand.blue }

    /// Lage im Tagesverlauf: unteres/oberes Drittel der heutigen Spanne.
    private var level: (String, Color)? {
        guard let s = stats, let p = point, s.max.ctKwh > s.min.ctKwh else { return nil }
        if p.ctKwh < 0 { return ("negativ", Brand.red) }
        let pos = (p.ctKwh - s.min.ctKwh) / (s.max.ctKwh - s.min.ctKwh)
        if pos < 1 / 3 { return ("heute günstig", Brand.green) }
        if pos > 2 / 3 { return ("heute teuer", Brand.orange) }
        return ("heute mittel", Brand.cyan)
    }
}

/// Wo liegt der aktuelle Preis zwischen Tagestief und Tageshoch?
private struct DayPositionBar: View {
    let min: Double, max: Double, average: Double, value: Double
    let tint: Color

    var body: some View {
        GeometryReader { g in
            let span = Swift.max(0.0001, max - min)
            let x = { (v: Double) in CGFloat(Swift.min(1, Swift.max(0, (v - min) / span))) * g.size.width }
            ZStack(alignment: .leading) {
                Capsule().fill(LinearGradient(colors: [Brand.green.opacity(0.5), Brand.cyan.opacity(0.5), Brand.orange.opacity(0.6)], startPoint: .leading, endPoint: .trailing))
                    .frame(height: 6)
                Rectangle().fill(Brand.text2).frame(width: 1.5, height: 12).offset(x: x(average))
                Circle().fill(Brand.now).frame(width: 14, height: 14)
                    .overlay(Circle().strokeBorder(Brand.bg0, lineWidth: 2))
                    .shadow(color: Brand.now.opacity(0.7), radius: 6)
                    .offset(x: x(value) - 7)
            }
            .frame(height: 14)
        }
        .frame(height: 14)
        .accessibilityHidden(true)
    }
}

// MARK: - Tagesleiste

private struct DayStrip: View {
    let days: [MarketDay]
    let scale: ClosedRange<Double>
    @Binding var selected: String
    let outlook: ResidualOutlook?
    let wide: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Die nächsten Tage")
            if wide {
                HStack(spacing: 10) { ForEach(days) { tile($0).frame(maxWidth: .infinity) } }
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) { ForEach(days) { tile($0).frame(width: 118).id($0.key) } }
                            .padding(.horizontal, 16)
                    }
                    .padding(.horizontal, -16)
                    .onChange(of: selected) { _, k in withAnimation { proxy.scrollTo(k, anchor: .center) } }
                }
            }
        }
    }

    private func tile(_ d: MarketDay) -> some View {
        let isSel = d.key == selected
        let tint = MarketStyle.color(d.priceClass)
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        return Button { withAnimation(.snappy) { selected = d.key } } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(MarketStyle.weekday(d.date)).font(.subheadline.weight(.bold)).foregroundStyle(Brand.text)
                            .lineLimit(1).minimumScaleFactor(0.7)
                        Text(MarketStyle.dayMonth(d.date)).font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
                    }
                    Spacer(minLength: 2)
                    Ampel(priceClass: d.priceClass)
                }
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(MarketStyle.ct1(d.meanCt))
                        .font(.system(.title2, design: .rounded).weight(.bold)).monospacedDigit()
                        .foregroundStyle(Brand.text)
                    Text("ct").font(.caption2).foregroundStyle(Brand.text2)
                }
                .lineLimit(1).minimumScaleFactor(0.7)
                if let r = d.rangeCt {
                    Text("\(MarketStyle.ct1(r.0))–\(MarketStyle.ct1(r.1))").font(.caption2.monospacedDigit()).foregroundStyle(Brand.text2)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
                BandBar(day: d, scale: scale, tint: tint)
                DaySpark(hours: outlook?.hours(on: d.key) ?? [], slots: d.slots, tint: tint)
                    .frame(height: 20)
                HStack(spacing: 4) {
                    Text(d.priceClass?.title ?? "–").foregroundStyle(tint)
                    Spacer(minLength: 0)
                    // Fest (Börse) oder geschätzt — als Zeichen, der Platz ist knapp.
                    Image(systemName: d.isFixed ? "checkmark.seal.fill" : "scope").foregroundStyle(Brand.dim)
                }
                .font(.caption2.weight(.semibold))
                .lineLimit(1).minimumScaleFactor(0.7)
            }
            .padding(10)
            .background(shape.fill(.ultraThinMaterial))
            .background(shape.fill(tint.opacity(isSel ? 0.22 : 0.06)))
            // Prognose gestrichelt: Sie ist eine Schätzung, kein Börsenpreis.
            .overlay(shape.strokeBorder(isSel ? tint : Brand.border,
                                        style: StrokeStyle(lineWidth: isSel ? 2 : 1, dash: d.isFixed ? [] : [5, 3])))
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a11y(d))
        .accessibilityAddTraits(isSel ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("marketDay.\(d.key)")
    }

    private func a11y(_ d: MarketDay) -> String {
        var s = "\(MarketStyle.longDay(d.date)), \(d.isFixed ? "Börsenpreis" : "Prognose") im Mittel \(Format.ct(d.meanCt))"
        if let r = d.rangeCt { s += ", Spanne \(MarketStyle.ct1(r.0)) bis \(MarketStyle.ct1(r.1)) Cent" }
        if let c = d.priceClass { s += ", Ampel \(c.title)" }
        return s
    }
}

/// Ampel: günstig (grün), normal (gelb), teuer (rot) — das aktive Licht leuchtet.
struct Ampel: View {
    let priceClass: PriceClass?

    var body: some View {
        VStack(spacing: 3) {
            light(.expensive, Brand.red)
            light(.normal, Brand.yellow)
            light(.cheap, Brand.green)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 4)
        .background(Brand.bg0.opacity(0.55), in: Capsule())
        .overlay(Capsule().strokeBorder(Brand.border, lineWidth: 1))
        .accessibilityHidden(true)
    }

    private func light(_ c: PriceClass, _ color: Color) -> some View {
        let on = priceClass == c
        return Circle()
            .fill(on ? color : color.opacity(0.14))
            .frame(width: 9, height: 9)
            .shadow(color: on ? color.opacity(0.9) : .clear, radius: 4)
    }
}

/// Bandbreite P10–P90 (Prognose) bzw. Tagestief–Tageshoch (fest) auf gemeinsamer Skala.
private struct BandBar: View {
    let day: MarketDay
    let scale: ClosedRange<Double>
    let tint: Color

    var body: some View {
        GeometryReader { g in
            let span = max(0.0001, scale.upperBound - scale.lowerBound)
            let x = { (v: Double) in CGFloat((v - scale.lowerBound) / span) * g.size.width }
            let lo = day.forecast?.band.p10 ?? PriceSeries.stats(day.slots)?.min.ctKwh ?? day.known?.minCt ?? day.meanCt ?? 0
            let hi = day.forecast?.band.p90 ?? PriceSeries.stats(day.slots)?.max.ctKwh ?? day.known?.maxCt ?? day.meanCt ?? 0
            ZStack(alignment: .leading) {
                Capsule().fill(Brand.hairline).frame(height: 4)
                Capsule().fill(tint.opacity(0.55)).frame(width: max(4, x(hi) - x(lo)), height: 4).offset(x: x(lo))
                if let m = day.meanCt {
                    Circle().fill(Brand.text).frame(width: 6, height: 6).offset(x: x(m) - 3)
                }
            }
            .frame(height: 6)
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

/// Stündlicher Verlauf als Mini-Balken; die vier günstigsten (grün) und
/// teuersten (rot) Stunden sind markiert — ▼/▲ der Webseite.
private struct DaySpark: View {
    let hours: [ResidualOutlook.Hour]
    let slots: [PricePoint]
    let tint: Color

    var body: some View {
        let values: [Double] = !hours.isEmpty ? hours.compactMap(\.ct) : hourly(slots)
        Canvas { ctx, size in
            guard values.count > 1, let lo = values.min(), let hi = values.max() else { return }
            let span = max(0.0001, hi - lo)
            let order = values.enumerated().sorted { $0.element < $1.element }.map(\.offset)
            let cheap = Set(order.prefix(4)), dear = Set(order.suffix(4))
            let w = size.width / CGFloat(values.count)
            for (i, v) in values.enumerated() {
                let h = max(2, CGFloat((v - lo) / span) * (size.height - 2) + 2)
                let rect = CGRect(x: CGFloat(i) * w + 0.5, y: size.height - h, width: max(1, w - 1), height: h)
                let c = cheap.contains(i) ? Brand.green : (dear.contains(i) ? Brand.red : tint.opacity(0.45))
                ctx.fill(Path(roundedRect: rect, cornerRadius: 1), with: .color(c))
            }
        }
        .accessibilityHidden(true)
    }

    private func hourly(_ s: [PricePoint]) -> [Double] {
        var byHour: [Int: [Double]] = [:]
        for p in s { byHour[MarketTime.calendar.component(.hour, from: p.start), default: []].append(p.ctKwh) }
        return byHour.keys.sorted().map { k in byHour[k]!.reduce(0, +) / Double(byHour[k]!.count) }
    }
}

// MARK: - Börse und Prognose auf einer Zeitachse

private struct TimelineCard: View {
    let days: [MarketDay]
    let selected: MarketDay?
    let prices: [PricePoint]
    let hours: [ResidualOutlook.Hour]
    let wide: Bool
    @State private var selection: Date?
    @State private var scroll = MarketTime.startOfDay(Date())

    /// Feste Preise als Balken: Viertelstunden von dvhub.online, sonst die
    /// festen Stunden aus der Prognose-Antwort.
    private var fixed: [PricePoint] {
        if !prices.isEmpty { return prices }
        return hours.compactMap { h in
            h.knownCt.map { PricePoint(start: h.start, end: h.start.addingTimeInterval(3600), ctKwh: $0, importCtKwh: nil) }
        }
    }

    /// Prognose-Stunden nach dem Ende der festen Preise.
    private var forecast: [ResidualOutlook.Hour] {
        let from = fixed.last?.end ?? .distantPast
        return hours.filter { $0.band != nil && $0.start >= from }
    }

    private var domain: ClosedRange<Date> {
        let start = days.first?.date ?? MarketTime.startOfDay(Date())
        let end = (days.last?.date ?? start).addingTimeInterval(86400)
        return start...max(end, start.addingTimeInterval(86400))
    }

    var body: some View {
        GlassCard(tint: Brand.blue) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Eyebrow(text: "Börse und Prognose", icon: "chart.bar.xaxis", tint: Brand.blue)
                    Spacer()
                    HStack(spacing: 10) {
                        key(Brand.priceUp, "Börse")
                        key(Brand.cyan, "Prognose", band: true)
                    }
                }
                readout
                chart.frame(height: wide ? 280 : 240)
                if let d = selected { summary(d) }
            }
        }
        .onChange(of: selected?.key, initial: true) { _, _ in
            // Tag gewählt: das Diagramm rollt dorthin.
            if let d = selected { withAnimation(.snappy) { scroll = d.date } }
        }
    }

    private func key(_ c: Color, _ t: String, band: Bool = false) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2).fill(c.opacity(band ? 0.35 : 1)).frame(width: 12, height: 8)
                .overlay { if band { Rectangle().fill(c).frame(height: 2) } }
            Text(t).font(.caption2).foregroundStyle(Brand.text2).lineLimit(1)
        }
        .accessibilityHidden(true)
    }

    private var readout: some View {
        let t = selection ?? Date()
        return HStack(alignment: .firstTextBaseline) {
            if let p = fixed.first(where: { $0.contains(t) }) {
                Text("\(MarketStyle.weekday(p.start)) \(MarketStyle.range(p.start, p.end))").foregroundStyle(Brand.text2)
                Spacer()
                Text(Format.ct(p.ctKwh)).font(.system(.title3, design: .rounded).weight(.bold)).foregroundStyle(p.ctKwh < 0 ? Brand.red : Brand.text)
            } else if let h = forecast.last(where: { $0.start <= t }), let b = h.band, selection != nil {
                Text("\(MarketStyle.weekday(h.start)) \(MarketStyle.hour(h.start)) · Prognose").foregroundStyle(Brand.text2)
                Spacer()
                Text("\(MarketStyle.ct1(b.p10))–\(MarketStyle.ct1(b.p90))").font(.caption).foregroundStyle(Brand.dim)
                Text(Format.ct(b.p50)).font(.system(.title3, design: .rounded).weight(.bold)).foregroundStyle(Brand.cyan)
            } else {
                Text("Halten und ziehen zeigt den Preis.").foregroundStyle(Brand.dim)
                Spacer()
            }
        }
        .font(.subheadline.monospacedDigit())
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .frame(minHeight: 26)
        .accessibilityElement(children: .combine)
    }

    private var chart: some View {
        let now = Date()
        let span = domain.upperBound.timeIntervalSince(domain.lowerBound)
        return Chart {
            selectedDayMark
            fixedBars(now)
            forecastBand
            forecastStart
            if domain.contains(now) { nowRule(now) }
            if let selection {
                RuleMark(x: .value("Auswahl", selection)).foregroundStyle(Brand.text.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXSelection(value: $selection)
        .chartXScale(domain: domain)
        .chartScrollableAxes(.horizontal)
        // Schmal: zwei Tage sichtbar, der Rest rollt. Breit: alles auf einen Blick.
        .chartXVisibleDomain(length: wide ? span : min(span, 2 * 86400))
        .chartScrollPosition(x: $scroll)
        .chartXAxis { dayAxis }
        .chartYAxis { CtAxis() }
        .accessibilityLabel("Börsenpreise und Preisprognose mit Bandbreite auf einer Zeitachse")
        .accessibilityIdentifier("priceChart")
    }

    @ChartContentBuilder
    private var selectedDayMark: some ChartContent {
        if let d = selected {
            RectangleMark(xStart: .value("a", d.date), xEnd: .value("b", d.date.addingTimeInterval(86400)))
                .foregroundStyle(Brand.text.opacity(0.06))
        }
    }

    @ChartContentBuilder
    private func fixedBars(_ now: Date) -> some ChartContent {
        ForEach(fixed) { p in
            RectangleMark(xStart: .value("Beginn", p.start), xEnd: .value("Ende", p.end), yStart: .value("Null", 0.0), yEnd: .value("ct/kWh", p.ctKwh))
                .foregroundStyle(barStyle(p, now: now))
                .accessibilityLabel("\(MarketStyle.weekday(p.start)) \(MarketStyle.range(p.start, p.end))")
                .accessibilityValue(Format.ct(p.ctKwh))
        }
    }

    private func barStyle(_ p: PricePoint, now: Date) -> Color {
        let base = p.ctKwh < 0 ? Brand.priceDown : Brand.priceUp
        if p.contains(now) { return Brand.now }
        return p.end <= now ? base.opacity(0.4) : base
    }

    @ChartContentBuilder
    private var forecastBand: some ChartContent {
        ForEach(forecast) { h in
            if let b = h.band {
                AreaMark(x: .value("Zeit", h.start), yStart: .value("P10", b.p10), yEnd: .value("P90", b.p90))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Brand.cyan.opacity(0.22))
                LineMark(x: .value("Zeit", h.start), y: .value("ct/kWh", b.p50))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Brand.cyan)
                    .lineStyle(StrokeStyle(lineWidth: 2.5, dash: [6, 3]))
            }
        }
    }

    /// Grenze zwischen Börse und Prognose, beschriftet.
    @ChartContentBuilder
    private var forecastStart: some ChartContent {
        if let first = forecast.first {
            RuleMark(x: .value("Prognose ab", first.start))
                .foregroundStyle(Brand.cyan.opacity(0.7))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                .annotation(position: .topTrailing, spacing: 2) {
                    Text("Prognose").font(.caption2.weight(.bold)).foregroundStyle(Brand.cyan)
                }
        }
    }

    @ChartContentBuilder
    private func nowRule(_ now: Date) -> some ChartContent {
        RuleMark(x: .value("Jetzt", now))
            .foregroundStyle(Brand.now)
            .lineStyle(StrokeStyle(lineWidth: 1.5))
            .annotation(position: .topTrailing, spacing: 2) {
                Text("jetzt").font(.caption2.weight(.bold)).foregroundStyle(Brand.now)
            }
    }

    /// Tagesgrenzen mit Wochentag, dazwischen 6-Stunden-Marken.
    @AxisContentBuilder
    private var dayAxis: some AxisContent {
        AxisMarks(values: .stride(by: .hour, count: 6, calendar: MarketTime.calendar)) { value in
            if let d = value.as(Date.self) {
                let midnight = MarketTime.calendar.component(.hour, from: d) == 0
                AxisGridLine().foregroundStyle(midnight ? Brand.border : Brand.hairline)
                AxisValueLabel {
                    if midnight {
                        Text(MarketStyle.weekday(d)).font(.caption2.weight(.bold)).foregroundStyle(Brand.text2)
                    } else if !wide {
                        Text(String(format: "%02d", MarketTime.calendar.component(.hour, from: d)))
                            .font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
                    }
                }
            }
        }
    }

    /// Kennwerte des gewählten Tags.
    @ViewBuilder
    private func summary(_ d: MarketDay) -> some View {
        Hairline()
        Text("\(MarketStyle.longDay(d.date)) · \(d.isFixed ? "Börse" : "Prognose")")
            .font(.caption.weight(.bold)).foregroundStyle(Brand.text)
        if let s = PriceSeries.stats(d.slots) {
            let cheap = OnlinePrices.window(d.slots, hours: 3, cheapest: true)
            let dear = OnlinePrices.window(d.slots, hours: 3, cheapest: false)
            RowStack {
                ValueRow(label: "Tief", value: "\(Format.ct(s.min.ctKwh)) · \(MarketStyle.hour(s.min.start))", tint: Brand.green)
                ValueRow(label: "Mittel", value: Format.ct(s.average))
                ValueRow(label: "Hoch", value: "\(Format.ct(s.max.ctKwh)) · \(MarketStyle.hour(s.max.start))", tint: Brand.orange)
                if let cheap {
                    ValueRow(label: "Günstigste 3 Stunden", value: "\(MarketStyle.range(cheap.start, cheap.end)) · ⌀ \(MarketStyle.ct1(cheap.averageCt)) ct", tint: Brand.green)
                }
                if let dear {
                    ValueRow(label: "Teuerste 3 Stunden", value: "\(MarketStyle.range(dear.start, dear.end)) · ⌀ \(MarketStyle.ct1(dear.averageCt)) ct", tint: Brand.orange)
                }
                if s.negativeSlots > 0 {
                    let step = d.slots.first.map { $0.end.timeIntervalSince($0.start) } ?? 900
                    ValueRow(label: "Negative Preise", value: Format.hours(Double(s.negativeSlots) * step / 3600), tint: Brand.red)
                }
            }
        } else if let f = d.forecast {
            RowStack {
                ValueRow(label: "Erwartet im Mittel", value: Format.ct(f.band.p50), tint: Brand.cyan)
                ValueRow(label: "Spanne", value: "\(MarketStyle.ct1(f.band.p10))–\(MarketStyle.ct1(f.band.p90)) ct")
                if let lo = f.minHourCt, let hi = f.maxHourCt {
                    ValueRow(label: "Günstigste / teuerste Stunde", value: "\(MarketStyle.ct1(lo)) / \(MarketStyle.ct1(hi)) ct")
                }
                ValueRow(label: "Einstufung", value: d.priceClass?.title ?? "–", tint: MarketStyle.color(d.priceClass))
            }
        } else if let k = d.known {
            RowStack {
                ValueRow(label: "Mittel", value: Format.ct(k.meanCt))
                if let lo = k.minCt, let hi = k.maxCt { ValueRow(label: "Tief / Hoch", value: "\(MarketStyle.ct1(lo)) / \(MarketStyle.ct1(hi)) ct") }
            }
        }
    }
}
