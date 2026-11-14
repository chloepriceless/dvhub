// HistoryView.swift — Historie: Tag, Woche, Monat, Jahr aus /api/history/summary
// (Energie, Erlöse, Kosten, Kennzahlen), dazu im Tag der Ladestand aus
// /api/telemetry/series. Nur lesend. Woche/Monat/Jahr brauchen in DVhub Pro.

import SwiftUI
import Charts
import DVhubLink

struct HistoryView: View {
    let controller: SystemController

    @State private var period: HistoryPeriod
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(Chrome.self) private var chrome
    @Environment(\.scenePhase) private var scenePhase
    @State private var date: Date
    @State private var summary: HistorySummary?
    @State private var soc: [SeriesPoint] = []
    @State private var loading = false
    @State private var message: String?
    @State private var proRequired = false
    @State private var showPicker = false
    @State private var metric: Metric

    /// Zeitraum, Datum und Kennzahl beginnen dort, wo man zuletzt war
    /// (`Chrome`) — auch wenn Auf- oder Zuklappen die Ansicht neu aufbaut.
    init(controller: SystemController, chrome: Chrome) {
        self.controller = controller
        _period = State(initialValue: chrome.historyPeriod)
        _date = State(initialValue: chrome.historyDate ?? Date())
        _metric = State(initialValue: chrome.historyMetric)
    }

    struct Key: Equatable { let period: HistoryPeriod; let day: String; let online: Bool }
    private var key: Key { Key(period: period, day: HistorySummary.dateParam(date), online: controller.isOnline) }

    var body: some View {
        AuroraPage { width in
            Picker("Zeitraum", selection: $period) {
                Text("Tag").tag(HistoryPeriod.day)
                Text("Woche").tag(HistoryPeriod.week)
                Text("Monat").tag(HistoryPeriod.month)
                Text("Jahr").tag(HistoryPeriod.year)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("historyPeriod")
            navigator
            if proRequired {
                NoticeBanner(text: "Woche, Monat und Jahr gibt es mit DVhub Pro. Die Tagesansicht ist frei.", icon: "lock.fill", tint: Brand.violet)
            } else if let message {
                NoticeBanner(text: message)
            }
            if let s = shown {
                moneyCard(s)
                energyGrid(s, wide: Layout.isWide(width))
                if s.view == .day {
                    dayCharts(s, wide: Layout.isWide(width))
                } else {
                    periodCharts(s)
                    rowsTable(s)
                }
                sharesCard(s, wide: Layout.isWide(width))
                moreCard(s)
            } else if loading {
                ProgressView().frame(maxWidth: .infinity, minHeight: 240)
            }
        }
        .navigationTitle("Historie")
        .screenActions(.history, [
            ScreenAction(id: "today", title: String(localized: "Heute"), icon: "calendar.badge.clock", disabled: Calendar.current.isDateInToday(date)) { date = Date() },
        ])
        .refreshable { await load(force: true) }
        .task(id: key) { await load(force: false) }
        .onChange(of: period) { _, p in chrome.historyPeriod = p }
        .onChange(of: date) { _, d in chrome.historyDate = Calendar.current.isDateInToday(d) ? nil : d }
        .onChange(of: metric) { _, m in chrome.historyMetric = m }
        // Stand die Historie auf „heute“ und die App kommt an einem neuen Tag zurück: wieder heute zeigen.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, chrome.historyDate == nil, !Calendar.current.isDateInToday(date) { date = Date() }
        }
        #if DEBUG
        // Nur für Bildschirmfotos: -DVHUB_HISTORY week|month|year
        .onAppear { if let p = UserDefaults.standard.string(forKey: "DVHUB_HISTORY").flatMap(HistoryPeriod.init(rawValue:)) { period = p } }
        #endif
        .sheet(isPresented: $showPicker) {
            NavigationStack {
                DatePicker(String(localized: "Datum"), selection: $date, in: ...Date(), displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .environment(\.locale, Format.locale)
                    .padding()
                    .navigationTitle("Datum wählen")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fertig") { showPicker = false } } }
            }
            .presentationDetents([.medium, .large])
        }
    }

    /// Nur zeigen, was zum gewählten Zeitraum gehört — nie Werte eines anderen.
    private var shown: HistorySummary? {
        guard let s = summary, s.view == period, s.date == HistorySummary.dateParam(date) else { return nil }
        return s
    }

    // MARK: Zeitraum

    private var navigator: some View {
        HStack(spacing: 10) {
            Button { date = HistorySummary.shift(date, view: period, by: -1) } label: {
                Image(systemName: "chevron.left").font(.headline).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Zurück")
            Button { showPicker = true } label: {
                VStack(spacing: 1) {
                    Text(rangeTitle).font(.headline).foregroundStyle(Brand.text)
                    if let sub = rangeSubtitle { Text(sub).font(.caption2).foregroundStyle(Brand.dim) }
                }
                .frame(maxWidth: .infinity)
            }
            .accessibilityHint("Datum wählen")
            Button { date = min(Date(), HistorySummary.shift(date, view: period, by: 1)) } label: {
                Image(systemName: "chevron.right").font(.headline).frame(width: 44, height: 44)
            }
            .disabled(isCurrent)
            .accessibilityLabel("Weiter")
        }
        .tint(Brand.cyan)
        .padding(.horizontal, 4)
        .background(CardBackground(radius: 16))
        .overlay(alignment: .bottom) { if loading { ProgressView().controlSize(.mini).padding(.bottom, 2) } }
    }

    private var isCurrent: Bool {
        let cal = Calendar.current
        let unit: Calendar.Component = switch period {
        case .day: .day
        case .week: .weekOfYear
        case .month: .month
        case .year: .year
        }
        return cal.isDate(date, equalTo: Date(), toGranularity: unit) || date > Date()
    }

    /// Heute oder gestern (dann steht das Wort als Titel, das Datum darunter).
    private var isRecentDay: Bool { Calendar.current.isDateInToday(date) || Calendar.current.isDateInYesterday(date) }

    private var rangeTitle: String {
        switch period {
        case .day: return isRecentDay
            ? Format.day(date) : date.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Format.locale))
        case .week:
            let cal = Calendar.current
            let w = cal.component(.weekOfYear, from: date)
            return String(localized: "KW \(String(w)) · \(String(cal.component(.yearForWeekOfYear, from: date)))", comment: "Kalenderwoche und Jahr")
        case .month: return date.formatted(.dateTime.month(.wide).year().locale(Format.locale))
        case .year: return date.formatted(.dateTime.year().locale(Format.locale))
        }
    }

    private var rangeSubtitle: String? {
        switch period {
        case .day:
            return isRecentDay ? date.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Format.locale)) : nil
        case .week:
            var cal = Calendar.current
            cal.firstWeekday = 2
            guard let iv = cal.dateInterval(of: .weekOfYear, for: date) else { return nil }
            let f = Date.FormatStyle.dateTime.day().month(.abbreviated).locale(Format.locale)
            return "\(iv.start.formatted(f)) – \(iv.end.addingTimeInterval(-1).formatted(f))"
        default: return nil
        }
    }

    // MARK: Laden

    private func load(force: Bool) async {
        guard controller.isOnline else {
            if shown == nil { message = String(localized: "Die Historie braucht eine Verbindung zur Anlage.") }
            return
        }
        if !force, shown != nil, !Calendar.current.isDateInToday(date) { return }
        let want = key
        loading = true
        defer { if want == key { loading = false } }
        let result = await BoxData.history(controller, view: want.period, date: date)
        // Inzwischen anderer Zeitraum gewählt: Antwort verwerfen.
        guard want == key, !Task.isCancelled else { return }
        switch result {
        case .ok(let s):
            summary = s
            proRequired = false
            message = s.kpis.isEmpty ? String(localized: "Für diesen Zeitraum liegen keine Werte vor.") : nil
        case .proRequired:
            summary = nil
            proRequired = true
            message = nil
        case .failed(let m):
            proRequired = false
            message = m
        }
        if want.period == .day {
            let start = Calendar.current.startOfDay(for: date)
            let end = Calendar.current.date(byAdding: .day, value: 1, to: start) ?? start
            if case .success(let pts) = await BoxData.series(controller, keys: [BoxData.socKey], start: start, end: end), want == key {
                soc = pts
            } else if want == key {
                soc = []
            }
        }
    }

    // MARK: Geld

    private func moneyCard(_ s: HistorySummary) -> some View {
        let net = s.netEur
        let tint = net >= 0 ? Brand.money : Brand.red
        return GlassCard(tint: tint) {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow(text: "Ergebnis", icon: "eurosign.circle.fill", tint: tint)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    MetricValue(value: Format.signedEuro(net), style: .largeTitle, color: tint, id: "historyNet")
                    Text("netto").font(.subheadline).foregroundStyle(Brand.text2)
                }
                MoneyBar(revenue: s.exportRevenueEur, cost: s.importCostEur)
                HStack(alignment: .top) {
                    money(String(localized: "Einnahmen"), s.exportRevenueEur, Brand.money)
                    Spacer(minLength: 6)
                    money(String(localized: "Strombezug"), s.importCostEur, Brand.red)
                    if let a = s.kpi("avoidedImportGrossEur") {
                        Spacer(minLength: 6)
                        money(String(localized: "Vermieden"), a, Brand.cyan)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func money(_ label: String, _ v: Double, _ c: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(Brand.dim)
            Text(Format.euro(v)).font(.system(.subheadline, design: .rounded).weight(.semibold)).monospacedDigit().foregroundStyle(c)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
    }

    // MARK: Energie

    private func energyGrid(_ s: HistorySummary, wide: Bool) -> some View {
        let cols = Array(repeating: GridItem(.flexible(), spacing: 10), count: typeSize.isAccessibilitySize ? (wide ? 3 : 1) : (wide ? 6 : 3))
        return LazyVGrid(columns: cols, spacing: 10) {
            EnergyTile(title: "PV", icon: "sun.max.fill", tint: Brand.pv, value: s.kpi("pvKwh"))
            EnergyTile(title: String(localized: "Verbrauch"), icon: "house.fill", tint: Brand.home, value: s.kpi("loadKwh"))
            EnergyTile(title: String(localized: "Bezug"), icon: "arrow.down.to.line", tint: Brand.red, value: s.kpi("importKwh"))
            EnergyTile(title: String(localized: "Einspeisung"), icon: "arrow.up.to.line", tint: Brand.cyan, value: s.kpi("exportKwh"))
            EnergyTile(title: String(localized: "Akku geladen"), icon: "battery.100percent.bolt", tint: Brand.battery, value: s.kpi("batteryChargeKwh"))
            EnergyTile(title: String(localized: "Akku entladen"), icon: "battery.25percent", tint: Brand.battery, value: s.kpi("batteryDischargeKwh"))
        }
    }

    // MARK: Tag

    @ViewBuilder
    private func dayCharts(_ s: HistorySummary, wide: Bool) -> some View {
        let power = dayLines(s)
        let prices = priceLines(s)
        if wide {
            HStack(alignment: .top, spacing: 14) {
                SlotChartCard(title: String(localized: "Leistung"), unit: "kW", tint: Brand.pv, lines: power, day: date)
                SlotChartCard(title: String(localized: "Ladestand"), unit: "%", tint: Brand.battery, range: 0...100,
                              lines: [.init(name: "SoC", color: Brand.battery, points: soc.map { ($0.date, $0.value) }, area: true)], day: date)
            }
        } else {
            SlotChartCard(title: String(localized: "Leistung"), unit: "kW", tint: Brand.pv, lines: power, day: date)
            SlotChartCard(title: String(localized: "Ladestand"), unit: "%", tint: Brand.battery, range: 0...100,
                          lines: [.init(name: "SoC", color: Brand.battery, points: soc.map { ($0.date, $0.value) }, area: true)], day: date)
        }
        if !prices.isEmpty {
            SlotChartCard(title: String(localized: "Preise"), unit: "ct/kWh", tint: Brand.blue, lines: prices, day: date, step: true)
        }
        if s.rows.contains(where: { $0.values["netEur"] != nil }) { NetCurveCard(rows: s.rows) }
    }

    /// Viertelstunden-Energie (kWh) als mittlere Leistung (kW).
    private func dayLines(_ s: HistorySummary) -> [SlotChartCard.Line] {
        func line(_ name: String, _ key: String, _ c: Color, area: Bool = false) -> SlotChartCard.Line {
            .init(name: name, color: c, points: s.rows.compactMap { r in
                guard let d = r.date, let v = r.values[key] else { return nil }
                return (d, v * 4)
            }, area: area)
        }
        return [line("PV", "pvKwh", Brand.pv, area: true), line(String(localized: "Haus"), "loadKwh", Brand.home),
                line(String(localized: "Bezug"), "importKwh", Brand.red), line(String(localized: "Einspeisung"), "exportKwh", Brand.cyan)]
            .filter { !$0.points.isEmpty }
    }

    private func priceLines(_ s: HistorySummary) -> [SlotChartCard.Line] {
        func line(_ name: String, _ key: String, _ c: Color) -> SlotChartCard.Line {
            .init(name: name, color: c, points: s.dayPrices.compactMap { r in
                guard let d = r.date, let v = r.values[key] else { return nil }
                return (d, v)
            })
        }
        return [line(String(localized: "Börse"), "marketPriceCtKwh", Brand.blue), line(String(localized: "Mein Bezug"), "userImportPriceCtKwh", Brand.violet)].filter { !$0.points.isEmpty }
    }

    // MARK: Woche / Monat / Jahr

    enum Metric: String, CaseIterable, Identifiable {
        case pv, load, imp, exp, net
        var id: String { rawValue }
        var title: String {
            switch self {
            case .pv: return "PV"
            case .load: return String(localized: "Verbrauch")
            case .imp: return String(localized: "Bezug")
            case .exp: return String(localized: "Einspeisung")
            case .net: return String(localized: "Netto €")
            }
        }
        var key: String {
            switch self {
            case .pv: return "pvKwh"
            case .load: return "loadKwh"
            case .imp: return "importKwh"
            case .exp: return "exportKwh"
            case .net: return "netEur"
            }
        }
        var color: Color {
            switch self {
            case .pv: return Brand.pv
            case .load: return Brand.home
            case .imp: return Brand.red
            case .exp: return Brand.cyan
            case .net: return Brand.money
            }
        }
        var isMoney: Bool { self == .net }
    }

    @ViewBuilder
    private func periodCharts(_ s: HistorySummary) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow(text: s.view == .year ? String(localized: "Je Monat") : String(localized: "Je Tag"), icon: "chart.bar.fill", tint: metric.color)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Metric.allCases) { m in
                            Button { withAnimation(.snappy) { metric = m } } label: {
                                Pill(text: m.title, tint: m.color, filled: metric == m)
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(metric == m ? .isSelected : [])
                        }
                    }
                }
                PeriodBarChart(rows: s.rows, metric: metric, view: s.view)
                    .frame(height: 210)
            }
        }
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow(text: "Erlöse und Kosten", icon: "eurosign", tint: Brand.money)
                MoneyBarChart(rows: s.rows, view: s.view).frame(height: 190)
            }
        }
    }

    private func rowsTable(_ s: HistorySummary) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: s.view == .year ? String(localized: "Monate") : String(localized: "Tage"), icon: "list.bullet", tint: Brand.text2)
                Grid(alignment: .trailing, horizontalSpacing: 10, verticalSpacing: 0) {
                    GridRow {
                        Text("").gridColumnAlignment(.leading)
                        Text("PV"); Text("Verbr."); Text("Netto")
                        Text("")
                    }
                    .font(.caption2.monospaced().weight(.semibold)).foregroundStyle(Brand.dim).padding(.vertical, 6)
                    ForEach(s.rows.reversed()) { r in
                        Divider().overlay(Brand.hairline).gridCellUnsizedAxes(.horizontal)
                        GridRow {
                            Text(rowLabel(r, s.view)).font(.subheadline).foregroundStyle(Brand.text).gridColumnAlignment(.leading)
                            Text(Format.number(r.value("pvKwh"), digits: r.value("pvKwh") >= 100 ? 0 : 1))
                            Text(Format.number(r.value("loadKwh"), digits: r.value("loadKwh") >= 100 ? 0 : 1))
                            Text(Format.signedEuro(r.values["netEur"])).foregroundStyle((r.values["netEur"] ?? 0) >= 0 ? Brand.money : Brand.red)
                            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(Brand.dim)
                        }
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(Brand.text2)
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                        .onTapGesture { drill(r, s.view) }
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(.isButton)
                        .accessibilityHint("Öffnet diesen Zeitraum")
                    }
                }
                Text("PV und Verbrauch in kWh").font(.caption2).foregroundStyle(Brand.dim).padding(.top, 6)
            }
        }
    }

    private func rowLabel(_ r: HistoryRow, _ view: HistoryPeriod) -> String {
        guard let d = r.date else { return r.label }
        if view == .year { return d.formatted(.dateTime.month(.wide).locale(Format.locale)) }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.twoDigits).locale(Format.locale))
    }

    /// Zeile antippen: Woche/Monat → Tag, Jahr → Monat.
    private func drill(_ r: HistoryRow, _ view: HistoryPeriod) {
        guard let d = r.date, d <= Date() else { return }
        date = d
        period = view == .year ? .month : .day
    }

    // MARK: Anteile und Kennzahlen

    @ViewBuilder
    private func sharesCard(_ s: HistorySummary, wide: Bool) -> some View {
        let consumption = GlassCard(tint: Brand.home) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Eyebrow(text: "Woher kam der Strom?", icon: "arrow.triangle.merge", tint: Brand.home)
                    Spacer()
                    if let a = s.autarkyPct { Pill(text: "Autarkie \(Format.percent(a))", tint: Brand.green) }
                }
                ShareBar(parts: [
                    .init(name: String(localized: "Solar"), value: s.kpi("solarDirectUseKwh"), color: Brand.pv),
                    .init(name: String(localized: "Akku"), value: s.kpi("batteryDirectUseKwh"), color: Brand.battery),
                    .init(name: String(localized: "Netz"), value: s.kpi("gridDirectUseKwh"), color: Brand.grid),
                ], format: Format.energy)
            }
        }
        let production = GlassCard(tint: Brand.pv) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Eyebrow(text: "Wohin ging der Solarstrom?", icon: "arrow.triangle.branch", tint: Brand.pv)
                    Spacer()
                    if let q = s.selfUsePct { Pill(text: "Eigenverbrauch \(Format.percent(q))", tint: Brand.pv) }
                }
                ShareBar(parts: [
                    .init(name: String(localized: "Haus"), value: s.kpi("solarDirectUseKwh"), color: Brand.home),
                    .init(name: String(localized: "Akku"), value: s.kpi("solarToBatteryKwh"), color: Brand.battery),
                    .init(name: String(localized: "Netz"), value: s.kpi("solarToGridKwh"), color: Brand.grid),
                ], format: Format.energy)
            }
        }
        if wide {
            HStack(alignment: .top, spacing: 14) { consumption; production }
        } else {
            consumption
            production
        }
    }

    private func moreCard(_ s: HistorySummary) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: "Kennzahlen", icon: "number", tint: Brand.text2)
                RowStack {
                    if let v = s.kpi("avgSpotPriceCtKwh") { ValueRow(label: "Börsenpreis im Mittel", value: Format.ct(v)) }
                    if let v = s.kpi("exportPvCtKwh"), v != 0 { ValueRow(label: "Erlös je kWh Solar", value: Format.ct(v)) }
                    if let v = s.kpi("marketPremiumEur"), abs(v) > 0.004 { ValueRow(label: "Marktprämie", value: Format.euro(v), tint: Brand.money) }
                    if let v = s.kpi("dvNetAdvantageEur") { ValueRow(label: "Vorteil Direktvermarktung", value: Format.signedEuro(v), tint: v >= 0 ? Brand.money : Brand.red, hint: String(localized: "gegenüber fester Einspeisevergütung")) }
                    if let v = s.kpi("pvFullLoadHours") { ValueRow(label: "Volllaststunden PV", value: Format.number(v) + " h") }
                    if let v = s.kpi("cycles") { ValueRow(label: "Akku-Zyklen", value: Format.number(v, digits: 2)) }
                    if let v = s.kpi("gridToBatteryKwh"), v > 0.05 { ValueRow(label: "Netzstrom in den Akku", value: Format.energy(v)) }
                    if let v = s.kpi("batteryToGridKwh"), v > 0.05 { ValueRow(label: "Akku ins Netz", value: Format.energy(v)) }
                    if let v = s.kpi("curtailedPvKwh"), v > 0.05 { ValueRow(label: "Abgeregelt", value: Format.energy(v), tint: Brand.orange) }
                    if let v = s.kpi("negPriceQuarterHourCount"), v > 0 { ValueRow(label: "Negative Preise", value: Format.hours(v / 4), tint: Brand.red) }
                    if let v = s.kpi("selfConsumptionCostEur"), abs(v) > 0.004 { ValueRow(label: "Gestehungskosten Eigenverbrauch", value: Format.euro(v)) }
                }
            }
        }
    }
}

// MARK: - Bausteine

private struct EnergyTile: View {
    let title: String
    let icon: String
    let tint: Color
    let value: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: icon).font(.subheadline).foregroundStyle(tint)
            Text(Format.number(value, digits: (value ?? 0) >= 100 ? 0 : 1))
                .font(.system(.title3, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
                .lineLimit(1).minimumScaleFactor(0.6)
            Text("\(title) · kWh").font(.caption2).foregroundStyle(Brand.text2).lineLimit(1).minimumScaleFactor(0.7)
        }
        .padding(10)
        .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
        .background(CardBackground(tint: tint, radius: 16))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title) \(Format.energy(value))")
    }
}

/// Linien über einen Tag (Zeitstempel aus der Historie), mit Ablesen.
struct SlotChartCard: View {
    struct Line: Identifiable {
        let name: String
        let color: Color
        let points: [(Date, Double)]
        var area = false
        var id: String { name }
    }

    let title: String
    let unit: String
    let tint: Color
    var range: ClosedRange<Double>? = nil
    let lines: [Line]
    let day: Date
    var step = false
    @State private var selection: Date?

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Eyebrow(text: title, icon: "chart.xyaxis.line", tint: tint)
                    Spacer()
                    Text(selection.map(readout) ?? unit).font(.caption.monospacedDigit()).foregroundStyle(selection == nil ? Brand.dim : Brand.text)
                        .lineLimit(1).minimumScaleFactor(0.6)
                }
                if lines.allSatisfy({ $0.points.isEmpty }) {
                    Text("Keine Werte für diesen Tag.").font(.footnote).foregroundStyle(Brand.dim).frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    chart.frame(height: 180)
                    if lines.count > 1 {
                        HStack(spacing: 10) {
                            ForEach(lines) { l in
                                HStack(spacing: 4) { Circle().fill(l.color).frame(width: 7, height: 7); Text(l.name) }
                            }
                        }
                        .font(.caption2).foregroundStyle(Brand.text2)
                    }
                }
            }
        }
    }

    private func readout(_ d: Date) -> String {
        let vals = lines.compactMap { l -> String? in
            guard let p = l.points.min(by: { abs($0.0.timeIntervalSince(d)) < abs($1.0.timeIntervalSince(d)) }) else { return nil }
            return (lines.count > 1 ? l.name + " " : "") + Format.number(p.1, digits: unit == "%" ? 0 : 1)
        }
        return ([Format.time(d)] + vals).joined(separator: " · ")
    }

    private var chart: some View {
        let start = Calendar.current.startOfDay(for: day)
        return Chart {
            ForEach(lines) { l in
                ForEach(Array(l.points.enumerated()), id: \.offset) { _, p in
                    if l.area {
                        AreaMark(x: .value("Zeit", p.0), y: .value(unit, p.1), series: .value("Reihe", l.name + "-Fläche"))
                            .interpolationMethod(step ? .stepEnd : .monotone)
                            .foregroundStyle(LinearGradient(colors: [l.color.opacity(0.3), l.color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    }
                    LineMark(x: .value("Zeit", p.0), y: .value(unit, p.1), series: .value("Reihe", l.name))
                        .interpolationMethod(step ? .stepEnd : .monotone)
                        .foregroundStyle(l.color)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                }
            }
            if let selection {
                RuleMark(x: .value("Auswahl", selection)).foregroundStyle(Brand.text.opacity(0.5)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXSelection(value: $selection)
        .chartXScale(domain: start...start.addingTimeInterval(86400))
        .modifier(YDomain(range: range))
        .chartXAxis { DayHourAxis() }
        .chartYAxis { PlainYAxis() }
        .accessibilityLabel(title)
        .accessibilityChartDescriptor(TimeSeriesDescriptor(
            title: title, yTitle: unit,
            series: lines.map { .init(name: $0.name, points: $0.points) },
            format: { "\(Format.number($0, digits: unit == "%" ? 0 : 1)) \(unit)" }))
    }

    private struct YDomain: ViewModifier {
        let range: ClosedRange<Double>?
        func body(content: Content) -> some View {
            if let range { content.chartYScale(domain: range) } else { content }
        }
    }
}

private func periodAxisLabel(_ r: HistoryRow, _ view: HistoryPeriod) -> String {
    guard let d = r.date else { return r.label }
    switch view {
    case .year: return d.formatted(.dateTime.month(.narrow).locale(Format.locale))
    case .week: return d.formatted(.dateTime.weekday(.short).locale(Format.locale))
    default: return String(Calendar.current.component(.day, from: d))
    }
}

/// Eine Kennzahl je Tag bzw. Monat als Balken, mit Ablesen.
private struct PeriodBarChart: View {
    let rows: [HistoryRow]
    let metric: HistoryView.Metric
    let view: HistoryPeriod
    @State private var selection: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(readout).font(.caption.monospacedDigit()).foregroundStyle(selection == nil ? Brand.dim : Brand.text)
            Chart {
                ForEach(rows) { r in
                    let v = r.value(metric.key)
                    BarMark(x: .value("Zeitraum", r.key), y: .value(metric.title, v))
                        .foregroundStyle(metric.isMoney && v < 0 ? Brand.red : metric.color)
                        .opacity(selection == nil || selection == r.key ? 1 : 0.4)
                        .cornerRadius(3)
                        .accessibilityLabel(r.label)
                        .accessibilityValue(metric.isMoney ? Format.euro(v) : Format.energy(v))
                }
            }
            .chartXSelection(value: $selection)
            .chartXAxis {
                AxisMarks(values: axisKeys) { value in
                    AxisValueLabel {
                        if let k = value.as(String.self), let r = rows.first(where: { $0.key == k }) {
                            Text(periodAxisLabel(r, view)).font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
                        }
                    }
                }
            }
            .chartYAxis { PlainYAxis() }
            .accessibilityLabel(metric.title)
            .accessibilityChartDescriptor(CategoryDescriptor(
                title: metric.title, summary: readoutSum,
                xTitle: view == .year ? String(localized: "Monat") : String(localized: "Tag"),
                yTitle: metric.isMoney ? String(localized: "Euro") : String(localized: "Kilowattstunden"),
                categories: rows.map(longLabel),
                series: [.init(name: metric.title, values: rows.map { $0.value(metric.key) })],
                format: { metric.isMoney ? Format.signedEuro($0) : Format.energy($0) }))
        }
    }

    private func longLabel(_ r: HistoryRow) -> String {
        r.date.map { view == .year ? $0.formatted(.dateTime.month(.wide).locale(Format.locale)) : $0.formatted(.dateTime.weekday(.abbreviated).day().month().locale(Format.locale)) } ?? r.label
    }

    private var readoutSum: String {
        let sum = rows.reduce(0) { $0 + $1.value(metric.key) }
        return String(localized: "Summe \(metric.isMoney ? Format.signedEuro(sum) : Format.energy(sum))")
    }

    /// Im Monat nur jeden fünften Tag beschriften.
    private var axisKeys: [String] {
        rows.count <= 12 ? rows.map(\.key) : rows.enumerated().filter { $0.offset % 5 == 0 }.map(\.element.key)
    }

    private var readout: String {
        guard let selection, let r = rows.first(where: { $0.key == selection }) else { return readoutSum }
        let v = r.value(metric.key)
        return "\(longLabel(r)) · " + (metric.isMoney ? Format.signedEuro(v) : Format.energy(v))
    }
}

/// Einnahmen nach oben, Bezugskosten nach unten, Netto als Linie.
private struct MoneyBarChart: View {
    let rows: [HistoryRow]
    let view: HistoryPeriod

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Chart {
                ForEach(rows) { r in
                    BarMark(x: .value("Zeitraum", r.key), y: .value("€", r.value("exportRevenueEur")))
                        .foregroundStyle(Brand.money.opacity(0.85)).cornerRadius(3)
                    BarMark(x: .value("Zeitraum", r.key), y: .value("€", -(r.values["gridCostEur"] ?? r.value("importCostEur"))))
                        .foregroundStyle(Brand.red.opacity(0.8)).cornerRadius(3)
                    LineMark(x: .value("Zeitraum", r.key), y: .value("€", r.value("netEur")))
                        .foregroundStyle(Brand.text).lineStyle(StrokeStyle(lineWidth: 1.5))
                        .symbol(.circle).symbolSize(rows.count > 12 ? 0 : 20)
                }
                RuleMark(y: .value("Null", 0)).foregroundStyle(Brand.border)
            }
            .chartXAxis {
                AxisMarks(values: rows.count <= 12 ? rows.map(\.key) : rows.enumerated().filter { $0.offset % 5 == 0 }.map(\.element.key)) { value in
                    AxisValueLabel {
                        if let k = value.as(String.self), let r = rows.first(where: { $0.key == k }) {
                            Text(periodAxisLabel(r, view)).font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
                        }
                    }
                }
            }
            .chartYAxis { PlainYAxis() }
            .accessibilityLabel("Einnahmen, Bezugskosten und Netto je Zeitraum")
            .accessibilityChartDescriptor(CategoryDescriptor(
                title: String(localized: "Erlöse und Kosten"),
                xTitle: view == .year ? String(localized: "Monat") : String(localized: "Tag"),
                yTitle: String(localized: "Euro"),
                categories: rows.map { r in
                    r.date.map { view == .year ? $0.formatted(.dateTime.month(.wide).locale(Format.locale)) : $0.formatted(.dateTime.weekday(.abbreviated).day().month().locale(Format.locale)) } ?? r.label
                },
                series: [
                    .init(name: String(localized: "Einnahmen"), values: rows.map { $0.value("exportRevenueEur") }),
                    .init(name: String(localized: "Strombezug"), values: rows.map { -($0.values["gridCostEur"] ?? $0.value("importCostEur")) }),
                    .init(name: String(localized: "Netto"), values: rows.map { $0.value("netEur") }),
                ],
                format: Format.signedEuro))
            HStack(spacing: 10) {
                key(Brand.money, String(localized: "Einnahmen")); key(Brand.red, String(localized: "Strombezug")); key(Brand.text, String(localized: "Netto"))
            }
        }
    }

    private func key(_ c: Color, _ t: String) -> some View {
        HStack(spacing: 4) { Circle().fill(c).frame(width: 7, height: 7); Text(t) }
            .font(.caption2).foregroundStyle(Brand.text2)
    }
}
