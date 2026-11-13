// MarketView.swift — Markt: Börsenpreise (Day-Ahead) und Residuallast-Frühwarnung
// in einer Ansicht. Die Tagesleiste verbindet beides: Heute und Morgen sind
// feste Börsentage (Viertelstunden), danach folgen fünf Prognosetage mit
// Bandbreite und Einstufung. Daten: dvhub.online (öffentlich), eigener
// Bezugspreis aus der Box, falls verbunden.

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
    var id: String { key }

    var isFixed: Bool { forecast == nil }
    var meanCt: Double? {
        if let f = forecast { return f.band.p50 }
        if let s = PriceSeries.stats(slots) { return s.average }
        return known?.meanCt
    }
}

struct MarketView: View {
    let controller: SystemController?
    @Environment(MarketStore.self) private var market
    @State private var selectedKey: String = MarketTime.key(Date())
    @State private var boxPrices: [PricePoint] = []
    @State private var showMethod = false
    @State private var debugDayApplied = false

    var body: some View {
        AuroraPage { width in
            let days = self.days
            let selected = days.first { $0.key == selectedKey } ?? days.first
            if let err = market.priceError, market.prices.isEmpty { NoticeBanner(text: err, icon: "wifi.slash") }
            NowPriceCard(point: currentPoint, today: days.first { $0.key == MarketTime.key(Date()) }, importCt: currentImportCt)
            if let o = market.outlook { WarningCard(outlook: o, select: { selectedKey = $0 }) }
            if !days.isEmpty {
                DayStrip(days: days, scale: scale(days), selected: $selectedKey, outlook: market.outlook, wide: Layout.isWide(width))
            }
            if let o = market.outlook, o.isStale() {
                NoticeBanner(text: "Die Prognose ist älter als 18 Stunden. Der Rechendienst hat sich nicht aktualisiert; die Werte können überholt sein.")
            } else if let err = market.outlookError, market.outlook == nil {
                NoticeBanner(text: "Frühwarnung nicht verfügbar: \(err)", icon: "wifi.slash")
            }
            if let day = selected {
                if day.isFixed {
                    FixedDayCard(day: day, importPrices: boxPrices, tomorrowPending: false)
                } else if let o = market.outlook {
                    ForecastDayCard(day: day, outlook: o, wide: Layout.isWide(width))
                }
            } else if market.loading {
                ProgressView().frame(maxWidth: .infinity, minHeight: 200)
            }
            if !market.hasTomorrow, market.outlook?.knownDays.contains(where: { $0.key == MarketTime.key(market.tomorrow) }) != true {
                Label("Die Preise für morgen stehen gegen 13 Uhr fest. Bis dahin gilt die Prognose.", systemImage: "clock")
                    .font(.footnote).foregroundStyle(Brand.text2)
            }
            if let o = market.outlook {
                OutlookTimelineCard(outlook: o, selectedKey: selectedKey)
                if !o.darius.isEmpty { DariusCard(outlook: o) }
                if let s = market.score { ScoreCard(score: s) }
                MethodCard(outlook: o, expanded: $showMethod)
            }
            footer
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
            if let n = UserDefaults.standard.object(forKey: "DVHUB_MARKET_DAY") as? Int ?? Int(UserDefaults.standard.string(forKey: "DVHUB_MARKET_DAY") ?? ""),
               keys.indices.contains(n), !debugDayApplied {
                debugDayApplied = true
                selectedKey = keys[n]
                return
            }
            #endif
            if !keys.contains(selectedKey), let first = keys.first { selectedKey = first }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let at = market.pricesAt { Text("Börsenpreise: Day-Ahead DE-LU, Stand \(Format.dateTime(at)).") }
            if let at = market.outlook?.issuedAt { Text("Prognose vom \(Format.dateTime(at)).") }
            Text("Börsenpreise ohne Netzentgelte, Steuern und Abgaben. Quelle: dvhub.online.")
        }
        .font(.caption2)
        .foregroundStyle(Brand.dim)
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
        return out.values.sorted { $0.date < $1.date }
    }

    /// Gemeinsame Preisspanne aller Tage — so sind die Bänder vergleichbar.
    private func scale(_ days: [MarketDay]) -> ClosedRange<Double> {
        var lo = 0.0, hi = 1.0
        for d in days {
            if let f = d.forecast { lo = min(lo, f.band.p10); hi = max(hi, f.band.p90) }
            if let s = PriceSeries.stats(d.slots) { lo = min(lo, s.min.ctKwh); hi = max(hi, s.max.ctKwh) }
            else if let k = d.known { lo = min(lo, k.minCt ?? k.meanCt); hi = max(hi, k.maxCt ?? k.meanCt) }
        }
        return lo...max(hi, lo + 1)
    }

    private var currentPoint: PricePoint? {
        market.currentPrice ?? PriceSeries.current(boxPrices)
    }

    private var currentImportCt: Double? {
        PriceSeries.current(boxPrices)?.importCtKwh
    }

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
        case .normal: return Brand.cyan
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

    static func ampelColor(_ a: String) -> Color {
        switch a {
        case "guenstig": return Brand.green
        case "normal": return Brand.yellow
        case "erhoeht": return Brand.orange
        case "hoch": return Brand.red
        default: return Brand.dim
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

// MARK: - Frühwarnung

private struct WarningCard: View {
    let outlook: ResidualOutlook
    let select: (String) -> Void

    var body: some View {
        let expensive = outlook.days.filter { $0.priceClass == .expensive }
        let cheap = outlook.days.filter { $0.priceClass == .cheap }
        if let first = expensive.first {
            card(day: first, others: expensive.dropFirst().map(\.date), cls: .expensive,
                 title: expensive.count == 1 ? "Teurer Tag voraus" : "\(expensive.count) teure Tage voraus",
                 text: "in \(first.leadDays) Tag\(first.leadDays == 1 ? "" : "en") – Akku vorher füllen, Verbrauch vorziehen.")
        } else if let first = cheap.first {
            card(day: first, others: cheap.dropFirst().map(\.date), cls: .cheap,
                 title: cheap.count == 1 ? "Günstiger Tag voraus" : "\(cheap.count) günstige Tage voraus",
                 text: "Laden und große Verbraucher lohnen sich dann besonders.")
        } else if !outlook.days.isEmpty {
            GlassCard(tint: Brand.cyan) {
                HStack(spacing: 12) {
                    Image(systemName: "checkmark.seal.fill").font(.title2).foregroundStyle(Brand.cyan)
                    VStack(alignment: .leading, spacing: 2) {
                        Eyebrow(text: "Frühwarnung", tint: Brand.cyan)
                        Text("Keine teuren Tage in Sicht").font(.headline).foregroundStyle(Brand.text)
                        Text("Die nächsten \(outlook.days.count) Tage liegen im üblichen Bereich der letzten vier Wochen.")
                            .font(.footnote).foregroundStyle(Brand.text2)
                    }
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func card(day: ResidualOutlook.Day, others: [Date], cls: PriceClass, title: String, text: String) -> some View {
        let tint = MarketStyle.color(cls)
        return Button { select(day.key) } label: {
            GlassCard(tint: tint) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: MarketStyle.icon(cls)).font(.title).foregroundStyle(tint)
                    VStack(alignment: .leading, spacing: 3) {
                        Eyebrow(text: "Frühwarnung", tint: tint)
                        Text(title).font(.headline).foregroundStyle(Brand.text)
                        Text("\(MarketStyle.longDay(day.date)): im Mittel \(Format.ct(day.band.p50)) (Band \(MarketStyle.ct1(day.band.p10))–\(MarketStyle.ct1(day.band.p90)))")
                            .font(.subheadline).foregroundStyle(Brand.text)
                        Text(others.isEmpty ? text : "Außerdem: " + others.map { MarketStyle.weekday($0) + " " + MarketStyle.dayMonth($0) }.joined(separator: ", ") + ".")
                            .font(.footnote).foregroundStyle(Brand.text2)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Brand.dim)
                }
            }
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityIdentifier("marketWarning")
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
            HStack {
                SectionTitle(text: "Die nächsten Tage")
                Spacer()
                HStack(spacing: 10) {
                    legend(dashed: true, "fest")
                    legend(dashed: false, "Prognose")
                }
            }
            if wide {
                HStack(spacing: 10) { ForEach(days) { tile($0).frame(maxWidth: .infinity) } }
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) { ForEach(days) { tile($0).frame(width: 112).id($0.key) } }
                            .padding(.horizontal, 16)
                    }
                    .padding(.horizontal, -16)
                    .onChange(of: selected) { _, k in withAnimation { proxy.scrollTo(k, anchor: .center) } }
                }
            }
        }
    }

    private func legend(dashed: Bool, _ text: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 3).strokeBorder(Brand.text2, style: StrokeStyle(lineWidth: 1, dash: dashed ? [3, 2] : []))
                .frame(width: 14, height: 10)
            Text(text)
        }
        .font(.caption2).foregroundStyle(Brand.dim)
        .accessibilityHidden(true)
    }

    private func tile(_ d: MarketDay) -> some View {
        let isSel = d.key == selected
        let cls = d.forecast?.priceClass
        let tint = d.isFixed ? Brand.blue : MarketStyle.color(cls)
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        return Button { withAnimation(.snappy) { selected = d.key } } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(MarketStyle.weekday(d.date)).font(.subheadline.weight(.bold)).foregroundStyle(Brand.text)
                        .lineLimit(1).minimumScaleFactor(0.7)
                    Spacer(minLength: 2)
                    Text(MarketStyle.dayMonth(d.date)).font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
                }
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(MarketStyle.ct1(d.meanCt))
                        .font(.system(.title2, design: .rounded).weight(.bold)).monospacedDigit()
                        .foregroundStyle(Brand.text)
                    Text("ct").font(.caption2).foregroundStyle(Brand.text2)
                }
                .lineLimit(1).minimumScaleFactor(0.7)
                BandBar(day: d, scale: scale, tint: tint)
                DaySpark(hours: outlook?.hours(on: d.key) ?? [], slots: d.slots, tint: tint)
                    .frame(height: 22)
                if d.isFixed {
                    Text("fest").font(.caption2.weight(.semibold)).foregroundStyle(Brand.blue)
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: MarketStyle.icon(cls)).imageScale(.small)
                        Text(cls?.title ?? "–")
                    }
                    .font(.caption2.weight(.semibold)).foregroundStyle(tint)
                }
            }
            .padding(10)
            .background(shape.fill(.ultraThinMaterial))
            .background(shape.fill(tint.opacity(isSel ? 0.22 : 0.06)))
            .overlay(shape.strokeBorder(isSel ? tint : Brand.border,
                                        style: StrokeStyle(lineWidth: isSel ? 2 : 1, dash: d.isFixed ? [5, 3] : [])))
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a11y(d))
        .accessibilityAddTraits(isSel ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("marketDay.\(d.key)")
    }

    private func a11y(_ d: MarketDay) -> String {
        var s = "\(MarketStyle.longDay(d.date)), im Mittel \(Format.ct(d.meanCt))"
        if let f = d.forecast {
            s += ", Prognose, Band \(MarketStyle.ct1(f.band.p10)) bis \(MarketStyle.ct1(f.band.p90)) Cent"
            if let c = f.priceClass { s += ", Einstufung \(c.title)" }
        } else {
            s += ", fester Börsenpreis"
        }
        return s
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

// MARK: - Fester Börsentag

private struct FixedDayCard: View {
    let day: MarketDay
    let importPrices: [PricePoint]
    let tomorrowPending: Bool
    @State private var selection: Date?
    @State private var showImport = false

    private var importSlots: [PricePoint] { OnlinePrices.day(importPrices, day.date).filter { $0.importCtKwh != nil } }

    var body: some View {
        GlassCard(tint: Brand.blue) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Eyebrow(text: "Day-Ahead · \(MarketStyle.weekday(day.date)) \(MarketStyle.dayMonth(day.date))", icon: "chart.bar.fill", tint: Brand.blue)
                    Spacer()
                    if !importSlots.isEmpty {
                        Toggle(isOn: $showImport) { Text("Mein Bezugspreis") }
                            .toggleStyle(.button).font(.caption).tint(Brand.violet)
                    }
                }
                if day.slots.isEmpty {
                    Text("Für diesen Tag liegen nur Tageswerte vor.").font(.footnote).foregroundStyle(Brand.text2)
                } else {
                    readout
                    chart.frame(height: 230)
                    statsGrid
                }
                if let k = day.known, let p50 = k.earlierP50Ct {
                    Hairline()
                    HStack(alignment: .firstTextBaseline) {
                        Image(systemName: "scope").foregroundStyle(Brand.cyan)
                        Text("Unsere frühere Prognose\(k.earlierLeadDays.map { " (\($0) Tag\($0 == 1 ? "" : "e") vorher)" } ?? ""): ⌀ \(Format.ct(p50))\(k.earlierClass.map { ", „\($0.title)“" } ?? "") – tatsächlich ⌀ \(Format.ct(k.meanCt)).")
                            .font(.footnote).foregroundStyle(Brand.text2)
                    }
                }
            }
        }
    }

    private var selected: PricePoint? {
        guard let selection else { return nil }
        return day.slots.first { $0.contains(selection) }
    }

    private var readout: some View {
        let p = selected ?? PriceSeries.current(day.slots)
        return HStack(alignment: .firstTextBaseline) {
            if let p {
                Text(MarketStyle.range(p.start, p.end)).font(.subheadline.monospacedDigit()).foregroundStyle(Brand.text2)
                Spacer()
                if showImport, let imp = importSlots.first(where: { $0.start == p.start })?.importCtKwh {
                    Text("Bezug \(Format.ct(imp))").font(.subheadline.monospacedDigit()).foregroundStyle(Brand.violet)
                }
                Text(Format.ct(p.ctKwh)).font(.system(.title3, design: .rounded).weight(.bold)).monospacedDigit()
                    .foregroundStyle(p.ctKwh < 0 ? Brand.red : Brand.text)
            } else {
                Text("Balken antippen und ziehen zeigt die Viertelstunde.").font(.footnote).foregroundStyle(Brand.dim)
                Spacer()
            }
        }
        .frame(minHeight: 28)
        .accessibilityElement(children: .combine)
    }

    private var chart: some View {
        let now = Date()
        let slots = day.slots
        let showNow = slots.contains { $0.contains(now) }
        return Chart {
            bars(slots, now: now)
            if showImport { importLine }
            if showNow { nowRule(now) }
            if let s = selected { selectionRule(s) }
        }
        .chartXSelection(value: $selection)
        .chartXAxis { MarketHourAxis(everyHours: 3) }
        .chartYAxis { CtAxis() }
        .chartXScale(domain: (slots.first?.start ?? day.date)...(slots.last?.end ?? day.date.addingTimeInterval(86400)))
        .accessibilityIdentifier("priceChart")
    }

    @ChartContentBuilder
    private func bars(_ slots: [PricePoint], now: Date) -> some ChartContent {
        ForEach(slots) { p in
            RectangleMark(xStart: .value("Beginn", p.start), xEnd: .value("Ende", p.end), yStart: .value("Null", 0.0), yEnd: .value("ct/kWh", p.ctKwh))
                .foregroundStyle(barStyle(p, now: now))
                .cornerRadius(1.5)
                .accessibilityLabel(MarketStyle.range(p.start, p.end))
                .accessibilityValue(Format.ct(p.ctKwh))
        }
    }

    @ChartContentBuilder
    private var importLine: some ChartContent {
        ForEach(importSlots) { p in
            LineMark(x: .value("Beginn", p.start), y: .value("ct/kWh", p.importCtKwh ?? 0), series: .value("Reihe", "Bezug"))
                .interpolationMethod(.stepEnd)
                .foregroundStyle(Brand.violet)
                .lineStyle(StrokeStyle(lineWidth: 2))
        }
    }

    @ChartContentBuilder
    private func nowRule(_ now: Date) -> some ChartContent {
        RuleMark(x: .value("Jetzt", now))
            .foregroundStyle(Brand.now)
            .lineStyle(StrokeStyle(lineWidth: 1.5))
            .annotation(position: .top, spacing: 2) {
                Text("jetzt").font(.caption2.weight(.bold)).foregroundStyle(Brand.now)
            }
    }

    @ChartContentBuilder
    private func selectionRule(_ s: PricePoint) -> some ChartContent {
        RuleMark(x: .value("Auswahl", s.start.addingTimeInterval(s.end.timeIntervalSince(s.start) / 2)))
            .foregroundStyle(Brand.text.opacity(0.6))
            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
    }

    private func barStyle(_ p: PricePoint, now: Date) -> Color {
        let base = p.ctKwh < 0 ? Brand.priceDown : Brand.priceUp
        if p.contains(now) { return Brand.now }
        return p.end <= now ? base.opacity(0.4) : base
    }

    @ViewBuilder
    private var statsGrid: some View {
        if let s = PriceSeries.stats(day.slots) {
            let cheap = OnlinePrices.window(day.slots, hours: 3, cheapest: true)
            let dear = OnlinePrices.window(day.slots, hours: 3, cheapest: false)
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
                    let step = day.slots.first.map { $0.end.timeIntervalSince($0.start) } ?? 900
                    ValueRow(label: "Negative Preise", value: Format.hours(Double(s.negativeSlots) * step / 3600), tint: Brand.red)
                }
            }
        }
    }
}

// MARK: - Prognosetag

private struct ForecastDayCard: View {
    let day: MarketDay
    let outlook: ResidualOutlook
    let wide: Bool
    @State private var selection: Date?

    private var hours: [ResidualOutlook.Hour] { outlook.hours(on: day.key) }
    private var tint: Color { MarketStyle.color(day.forecast?.priceClass) }

    var body: some View {
        GlassCard(tint: tint) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Eyebrow(text: "Prognose · \(MarketStyle.weekday(day.date)) \(MarketStyle.dayMonth(day.date))", icon: "scope", tint: tint)
                    Spacer()
                    if let c = day.forecast?.priceClass { Pill(text: c.title, icon: MarketStyle.icon(c), tint: tint) }
                }
                if let f = day.forecast {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        MetricValue(value: MarketStyle.ct1(f.band.p50), style: .largeTitle)
                        Text("ct/kWh im Mittel").font(.subheadline).foregroundStyle(Brand.text2)
                    }
                    Text("Band \(MarketStyle.ct1(f.band.p10))–\(MarketStyle.ct1(f.band.p90)) ct (80 % der Fälle im Rückblick)\(f.backtestMaeCt.map { " · typischer Stundenfehler ±\(MarketStyle.ct1($0)) ct" } ?? "")")
                        .font(.footnote).foregroundStyle(Brand.text2)
                }
                if hours.isEmpty {
                    Text("Für diesen Tag liegen keine Stundenwerte vor.").font(.footnote).foregroundStyle(Brand.text2)
                } else if wide {
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) { readout; priceChart.frame(height: 220) }
                        VStack(alignment: .leading, spacing: 6) { residualLegend; residualChart.frame(height: 220) }
                    }
                } else {
                    readout
                    priceChart.frame(height: 200)
                    residualLegend
                    residualChart.frame(height: 150)
                }
                extremes
                if let f = day.forecast {
                    Hairline()
                    RowStack {
                        ValueRow(label: "Residuallast", value: "\(gw(f.residualMinGw))–\(gw(f.residualMaxGw)) GW · ⌀ \(gw(f.residualMeanGw))", tint: Brand.violet,
                                 hint: "Verbrauch minus Wind und Sonne")
                        ValueRow(label: "Wind im Mittel", value: "\(gw(f.windGw)) GW", tint: Brand.cyan)
                        ValueRow(label: "Sonne im Mittel", value: "\(gw(f.solarGw)) GW", tint: Brand.yellow)
                        if let p20 = f.p20Ct, let p80 = f.p80Ct {
                            ValueRow(label: "Schwellen", value: "günstig < \(MarketStyle.ct1(p20)) · teuer > \(MarketStyle.ct1(p80)) ct",
                                     hint: "20-%- und 80-%-Quantil der letzten 28 Tage")
                        }
                    }
                }
            }
        }
    }

    private func gw(_ v: Double?) -> String {
        guard let v else { return "–" }
        return v.formatted(.number.precision(.fractionLength(1)).locale(Format.de))
    }

    private var selected: ResidualOutlook.Hour? {
        guard let selection else { return nil }
        return hours.last { $0.start <= selection }
    }

    private var readout: some View {
        HStack(alignment: .firstTextBaseline) {
            if let h = selected, let b = h.band {
                Text("\(MarketStyle.hour(h.start)) Uhr").font(.subheadline.monospacedDigit()).foregroundStyle(Brand.text2)
                Spacer()
                Text("\(MarketStyle.ct1(b.p10))–\(MarketStyle.ct1(b.p90))").font(.caption.monospacedDigit()).foregroundStyle(Brand.dim)
                Text(Format.ct(b.p50)).font(.system(.title3, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
            } else {
                HStack(spacing: 10) {
                    key(Brand.cyan, "Preis (Mitte)")
                    key(Brand.cyan.opacity(0.3), "Band 10–90 %")
                }
                Spacer()
            }
        }
        .frame(minHeight: 26)
    }

    private func key(_ c: Color, _ t: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2).fill(c).frame(width: 12, height: 4)
            Text(t).font(.caption2).foregroundStyle(Brand.text2)
        }
    }

    private var priceChart: some View {
        let cheap = Set(outlook.extremeHours(on: day.key, cheapest: true).map(\.start))
        let dear = Set(outlook.extremeHours(on: day.key, cheapest: false).map(\.start))
        return Chart {
            ForEach(hours) { h in
                if let b = h.band {
                    AreaMark(x: .value("Zeit", h.start), yStart: .value("P10", b.p10), yEnd: .value("P90", b.p90))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Brand.cyan.opacity(0.22))
                    LineMark(x: .value("Zeit", h.start), y: .value("ct/kWh", b.p50))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Brand.cyan)
                        .lineStyle(StrokeStyle(lineWidth: 2.5))
                    if cheap.contains(h.start) || dear.contains(h.start) {
                        PointMark(x: .value("Zeit", h.start), y: .value("ct/kWh", b.p50))
                            .symbol(cheap.contains(h.start) ? .circle : .diamond)
                            .symbolSize(46)
                            .foregroundStyle(cheap.contains(h.start) ? Brand.green : Brand.red)
                    }
                }
            }
            if let h = selected {
                RuleMark(x: .value("Auswahl", h.start)).foregroundStyle(Brand.text.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXSelection(value: $selection)
        .chartXAxis { MarketHourAxis(everyHours: 3) }
        .chartYAxis { CtAxis() }
        .accessibilityLabel("Preisprognose je Stunde mit Bandbreite")
    }

    private var residualLegend: some View {
        HStack(spacing: 10) {
            key(Brand.violet, "Residuallast")
            key(Brand.cyan, "Wind")
            key(Brand.yellow, "Sonne")
            Spacer()
            if let h = selected, let r = h.residualGw {
                Text("\(gw(r)) GW").font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(Brand.violet)
            } else {
                Text("GW").font(.caption2).foregroundStyle(Brand.dim)
            }
        }
    }

    private var residualChart: some View {
        Chart {
            ForEach(hours) { h in
                if let r = h.residualGw {
                    AreaMark(x: .value("Zeit", h.start), y: .value("GW", r), series: .value("Reihe", "RL-Fläche"))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(LinearGradient(colors: [Brand.violet.opacity(0.35), Brand.violet.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value("Zeit", h.start), y: .value("GW", r), series: .value("Reihe", "Residuallast"))
                        .interpolationMethod(.monotone).foregroundStyle(Brand.violet).lineStyle(StrokeStyle(lineWidth: 2.5))
                }
                if let w = h.windGw {
                    LineMark(x: .value("Zeit", h.start), y: .value("GW", w), series: .value("Reihe", "Wind"))
                        .interpolationMethod(.monotone).foregroundStyle(Brand.cyan).lineStyle(StrokeStyle(lineWidth: 1.5))
                }
                if let s = h.solarGw {
                    LineMark(x: .value("Zeit", h.start), y: .value("GW", s), series: .value("Reihe", "Sonne"))
                        .interpolationMethod(.monotone).foregroundStyle(Brand.yellow).lineStyle(StrokeStyle(lineWidth: 1.5))
                }
            }
            if let h = selected {
                RuleMark(x: .value("Auswahl", h.start)).foregroundStyle(Brand.text.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXSelection(value: $selection)
        .chartXAxis { MarketHourAxis(everyHours: 3) }
        .chartYAxis { CtAxis() }
        .accessibilityLabel("Residuallast, Wind und Sonne in Gigawatt")
    }

    @ViewBuilder
    private var extremes: some View {
        let cheap = outlook.extremeHours(on: day.key, cheapest: true)
        let dear = outlook.extremeHours(on: day.key, cheapest: false)
        if !cheap.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HourChips(title: "Günstigste Stunden", icon: "arrowtriangle.down.fill", hours: cheap, tint: Brand.green)
                HourChips(title: "Teuerste Stunden", icon: "arrowtriangle.up.fill", hours: dear, tint: Brand.red)
                Text("Die genaue Stunde kann sich um ein, zwei Stunden verschieben.").font(.caption2).foregroundStyle(Brand.dim)
            }
        }
    }
}

private struct HourChips: View {
    let title: String
    let icon: String
    let hours: [ResidualOutlook.Hour]
    let tint: Color

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { label; chips }
            VStack(alignment: .leading, spacing: 4) { label; HStack(spacing: 6) { chips } }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title): " + hours.map { "\(MarketTime.calendar.component(.hour, from: $0.start)) Uhr" }.joined(separator: ", "))
    }

    private var label: some View {
        Label(title, systemImage: icon).font(.caption.weight(.semibold)).foregroundStyle(tint).lineLimit(1)
    }

    @ViewBuilder private var chips: some View {
        ForEach(hours) { h in
            Text(String(format: "%02d", MarketTime.calendar.component(.hour, from: h.start)))
                .font(.caption.monospacedDigit().weight(.bold))
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background(tint.opacity(0.18), in: Capsule())
                .foregroundStyle(tint)
        }
    }
}

// MARK: - Gesamter Zeitstrahl

/// Feste Börsenpreise und Prognose auf einer Zeitachse: wo endet das Bekannte,
/// wie breit wird das Band nach hinten.
private struct OutlookTimelineCard: View {
    let outlook: ResidualOutlook
    let selectedKey: String

    var body: some View {
        let hours = outlook.hours
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow(text: "Börse und Prognose im Zusammenhang", icon: "waveform.path.ecg", tint: Brand.cyan)
                HStack(spacing: 10) {
                    key(Brand.blue, "Börse (fest)")
                    key(Brand.dim, "frühere Prognose", dashed: true)
                    key(Brand.cyan, "Prognose")
                }
                Chart {
                    if let start = MarketTime.day(selectedKey) {
                        RectangleMark(xStart: .value("a", start), xEnd: .value("b", start.addingTimeInterval(86400)))
                            .foregroundStyle(Brand.text.opacity(0.07))
                    }
                    ForEach(hours) { h in
                        if let b = h.band {
                            AreaMark(x: .value("Zeit", h.start), yStart: .value("P10", b.p10), yEnd: .value("P90", b.p90), series: .value("R", "Band"))
                                .interpolationMethod(.monotone).foregroundStyle(Brand.cyan.opacity(0.2))
                            LineMark(x: .value("Zeit", h.start), y: .value("ct", b.p50), series: .value("R", "Prognose"))
                                .interpolationMethod(.monotone).foregroundStyle(Brand.cyan).lineStyle(StrokeStyle(lineWidth: 2))
                        }
                        if let k = h.knownCt {
                            LineMark(x: .value("Zeit", h.start), y: .value("ct", k), series: .value("R", "Börse"))
                                .interpolationMethod(.stepEnd).foregroundStyle(Brand.blue).lineStyle(StrokeStyle(lineWidth: 2))
                        }
                        if let e = h.earlierP50Ct {
                            LineMark(x: .value("Zeit", h.start), y: .value("ct", e), series: .value("R", "früher"))
                                .interpolationMethod(.monotone).foregroundStyle(Brand.dim).lineStyle(StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
                        }
                    }
                    RuleMark(x: .value("Jetzt", Date())).foregroundStyle(Brand.now).lineStyle(StrokeStyle(lineWidth: 1.2))
                }
                .chartXAxis {
                    AxisMarks(values: .stride(by: .day, calendar: MarketTime.calendar)) { value in
                        AxisGridLine().foregroundStyle(Brand.border)
                        if let d = value.as(Date.self) {
                            AxisValueLabel { Text(MarketStyle.weekday(d)).font(.caption2).foregroundStyle(Brand.text2) }
                        }
                    }
                }
                .chartYAxis { CtAxis() }
                .frame(height: 170)
                .accessibilityLabel("Feste Börsenpreise und Prognose mit Bandbreite über alle Tage")
            }
        }
    }

    private func key(_ c: Color, _ t: String, dashed: Bool = false) -> some View {
        HStack(spacing: 4) {
            Rectangle().fill(.clear).frame(width: 14, height: 3)
                .overlay(Line().stroke(c, style: StrokeStyle(lineWidth: 2.5, dash: dashed ? [3, 2] : [])))
            Text(t).font(.caption2).foregroundStyle(Brand.text2).lineLimit(1)
        }
    }

    private struct Line: Shape {
        func path(in r: CGRect) -> Path { var p = Path(); p.move(to: CGPoint(x: 0, y: r.midY)); p.addLine(to: CGPoint(x: r.maxX, y: r.midY)); return p }
    }
}

// MARK: - Explorativ: Darius

private struct DariusCard: View {
    let outlook: ResidualOutlook

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Eyebrow(text: "Ampel nach Darius’ Methode", icon: "light.beacon.max", tint: Brand.dim)
                    Spacer()
                    Pill(text: "explorativ", icon: "flask", tint: Brand.violet)
                }
                HStack(spacing: 8) {
                    ForEach(outlook.darius) { d in
                        VStack(spacing: 4) {
                            Text(MarketStyle.weekday(d.date)).font(.caption2.weight(.semibold)).foregroundStyle(Brand.text2)
                            Circle().fill(MarketStyle.ampelColor(d.ampel)).frame(width: 18, height: 18)
                                .shadow(color: MarketStyle.ampelColor(d.ampel).opacity(0.6), radius: 5)
                            Text(d.title).font(.caption2).foregroundStyle(Brand.text)
                            Text(d.peakGw.map { "\($0.formatted(.number.precision(.fractionLength(0)).locale(Format.de))) GW" } ?? "–")
                                .font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
                        }
                        .frame(maxWidth: .infinity)
                        .lineLimit(1).minimumScaleFactor(0.7)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(MarketStyle.longDay(d.date)): \(d.title), Spitze \(d.peakGw.map { "\(Int($0)) Gigawatt" } ?? "unbekannt")")
                    }
                }
                Text("Nur zum Vergleich: unser Nachbau des Forum-Modells von Darius75, nicht sein Original und nicht Teil der Prüfung. Maßgeblich sind die Tage oben.")
                    .font(.caption).foregroundStyle(Brand.text2)
                if let rule = outlook.dariusRule {
                    Text(rule).font(.caption2).foregroundStyle(Brand.dim)
                }
            }
        }
    }
}

// MARK: - Bilanz

private struct ScoreCard: View {
    let score: ResidualScore
    @State private var expanded = false

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow(text: "Wie gut ist die Prognose?", icon: "checklist", tint: Brand.cyan)
                Grid(alignment: .trailing, horizontalSpacing: 8, verticalSpacing: 7) {
                    GridRow {
                        Text("Tage voraus").gridColumnAlignment(.leading)
                        ForEach(score.leads) { Text("\($0.leadDays)") }
                    }
                    .font(.caption2.monospaced().weight(.semibold)).foregroundStyle(Brand.dim)
                    row("Fehler je Stunde (ct)") { MarketStyle.ct1($0.shown.maeCt) }
                    row("Einstufung getroffen") { MarketStyle.pct($0.shown.classAccuracy) }
                    row("Teure Tage erkannt") { MarketStyle.pct($0.shown.expensiveRecall) }
                    row("Speicher-Nutzen") { MarketStyle.pct($0.shown.storageCapture) }
                    row("Im Band (Soll 80 %)") { MarketStyle.pct($0.shown.bandCoverage) }
                }
                let live = score.leads.filter { !$0.lowData }.count
                Text(live == score.leads.count
                     ? "Live-Bilanz seit \(score.since ?? "Start")."
                     : "Werte aus dem Rückblick\(score.backtestPeriod.map { " (\($0))" } ?? ""). Die Live-Bilanz zählt seit \(score.since ?? "kurzem") und ersetzt sie je Vorlauf nach \(score.lowDataDays ?? 14) Tagen.")
                    .font(.caption2).foregroundStyle(Brand.dim)
                DisclosureGroup(isExpanded: $expanded) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(score.comparisons) { c in comparison(c) }
                    }
                    .padding(.top, 6)
                } label: {
                    Text("Vergleich mit anderen Verfahren").font(.footnote.weight(.semibold)).foregroundStyle(Brand.text)
                }
                .tint(Brand.cyan)
            }
        }
    }

    private func row(_ label: String, _ value: @escaping (ResidualScore.Lead) -> String) -> some View {
        GridRow {
            Text(label).font(.caption).foregroundStyle(Brand.text2).gridColumnAlignment(.leading).lineLimit(1).minimumScaleFactor(0.7)
            ForEach(score.leads) { l in
                Text(value(l)).font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(Brand.text).lineLimit(1).minimumScaleFactor(0.6)
            }
        }
    }

    private func comparison(_ c: ResidualScore.Comparison) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(c.label).font(.caption.weight(.semibold)).foregroundStyle(Brand.text)
                Spacer(minLength: 6)
                if c.explorative { Pill(text: "explorativ", icon: "flask", tint: Brand.violet) }
            }
            if c.hasLiveData {
                ForEach(c.rows.filter { $0.liveDays > 0 }) { r in
                    HStack {
                        Text("\(r.leadDays) Tag\(r.leadDays == 1 ? "" : "e") voraus · \(r.liveDays) Tage").foregroundStyle(Brand.text2)
                        Spacer()
                        Text("wir \(MarketStyle.ct1(r.ours.maeCt)) · dort \(MarketStyle.ct1(r.other.maeCt)) ct").monospacedDigit().foregroundStyle(Brand.text)
                    }
                    .font(.caption2)
                }
            } else {
                Text("Noch keine gemeinsamen Live-Tage.").font(.caption2).foregroundStyle(Brand.dim)
            }
            if let note = c.note { Text(note).font(.caption2).foregroundStyle(Brand.dim) }
        }
    }
}

// MARK: - Methode und Quellen

private struct MethodCard: View {
    let outlook: ResidualOutlook
    @Binding var expanded: Bool

    var body: some View {
        GlassCard {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Die Residuallast ist der Verbrauch, der nach Wind und Sonne übrig bleibt und von Kraftwerken gedeckt werden muss. Ist sie hoch, setzen meist Gaskraftwerke den Preis, und der Strom wird teuer; ist sie niedrig, wird er günstig.")
                    if let m = outlook.method { Text(m) }
                    if let c = outlook.classificationRule { Text(c) }
                    if let p = outlook.priceLevelBasis { Text("Preisniveau: \(p).") }
                    Text("Die Idee stammt von Darius75 im Akkudoktor-Forum („Residuallast-Frühwarnung: 5 Tage Vorlauf vor teuren Tagen“). Umgesetzt mit eigenem Code auf dvhub.online.")
                    if let d = outlook.disclaimer { Text(d).fontWeight(.semibold) }
                    if !outlook.sources.isEmpty {
                        Text("Quellen").font(.caption.weight(.bold)).foregroundStyle(Brand.text)
                        ForEach(outlook.sources) { s in
                            Text("• \(s.name)\(s.license.map { " (\($0))" } ?? "")")
                        }
                    }
                    if let a = outlook.attribution { Text(a).font(.caption2).foregroundStyle(Brand.dim) }
                    if let url = URL(string: "https://dvhub.online/tools/residuallast/") {
                        Link(destination: url) { Label("Ausführlich auf dvhub.online", systemImage: "safari") }.font(.footnote.weight(.semibold))
                    }
                }
                .font(.caption)
                .foregroundStyle(Brand.text2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
            } label: {
                Eyebrow(text: "So entsteht die Prognose\(outlook.modelVersion.map { " · \($0)" } ?? "")", icon: "info.circle", tint: Brand.text2)
            }
            .tint(Brand.cyan)
        }
    }
}
