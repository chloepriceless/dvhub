// MarketView.swift — Markt: Börsenpreise und die Vorhersage der nächsten Tage.
//
// Drei Dinge, mehr nicht:
//   1. die Tage als Karten — Datum, Tagesmittel, Spanne, Ampel und die Lage
//      des Tagesmittels im üblichen Bereich. Prognosetage tragen die Einstufung
//      der Schnittstelle; heute und morgen dieselbe Regel aus den Börsenpreisen,
//   2. Einspeisung und Bezug in EINEM Diagramm: Balken = was die Einspeisung
//      bringt (Börsenpreis je Viertelstunde von heute bzw. morgen), Linie = was
//      der Bezug kostet (eigener Tarif aus DVhub). Der Abstand ist die Spanne.
//      Was gerade gilt, steht klein darüber. Direkt darunter, auf derselben
//      Zeitachse, die Energiemengen des Tages wie im Leitstand: woher der Strom
//      kam (oben) und wohin er ging (unten). Zwei Diagramme, weil ct/kWh und kW
//      nicht auf eine Achse gehören — eine Auswahl gilt für beide,
//   3. getrennt davon die Preisprognose der nächsten Tage mit Band.
// Daten: dvhub.online (öffentlich), eigener Bezugspreis aus der Box
// (/api/status → userEnergyPricing.slots), Energiemengen aus der Tages-Historie
// der Box (/api/history/summary?view=day).

import SwiftUI
import Charts
import DVhubLink

struct MarketView: View {
    let controller: SystemController?
    @Environment(MarketStore.self) private var market
    @Environment(Chrome.self) private var chrome
    @State private var selectedKey: String
    @State private var boxPrices: [PricePoint] = []
    @State private var boxLoaded = false
    /// Anlage, von der `boxPrices` stammen.
    @State private var boxSystem: String?
    /// Energiemengen je Viertelstunde von heute (Tages-Historie der Box).
    @State private var energy = MarketEnergy()
    @State private var debugDayApplied = false

    /// Der gewählte Tag beginnt dort, wo man zuletzt war (`Chrome`) — auch wenn
    /// Auf- oder Zuklappen die Ansicht neu aufbaut. Ein vergangener Tag fällt auf heute zurück (unten).
    init(controller: SystemController?, chrome: Chrome) {
        self.controller = controller
        _selectedKey = State(initialValue: chrome.marketDay ?? MarketTime.key(Date()))
    }

    var body: some View {
        AuroraPage { width in
            let days = self.days
            if let err = market.priceError, market.prices.isEmpty { NoticeBanner(text: err, icon: "wifi.slash") }
            if !days.isEmpty {
                DayStrip(days: days, selected: $selectedKey, outlook: market.outlook, width: width)
                ExchangeCard(days: days.filter { !$0.slots.isEmpty }, box: boxPrices, now: currentPoint, tariffState: tariffState,
                             energy: shownEnergy, energyState: energyState, selectedKey: $selectedKey)
                if let o = market.outlook, days.contains(where: { !$0.isFixed }) {
                    ForecastCard(days: days.filter { !$0.isFixed }, hours: o.hours, selectedKey: $selectedKey, wide: Layout.isWide(width))
                }
            } else if market.loading {
                ProgressView().frame(maxWidth: .infinity, minHeight: 200)
            }
            if let o = market.outlook, o.isStale() {
                NoticeBanner(text: "Die Prognose ist älter als 18 Stunden und kann überholt sein.")
            } else if let err = market.outlookError, market.outlook == nil {
                NoticeBanner(text: "Prognose nicht verfügbar: \(err)", icon: "wifi.slash")
            }
            Text("Börsenpreise (Day-Ahead DE-LU) und Prognose: dvhub.online\(market.pricesAt.map { " · Stand \(Format.dateTime($0))" } ?? ""). Einspeisung zum Börsenpreis, wie DVhub die Erlöse rechnet – ohne Marktprämie. Bezug: dein Tarif aus DVhub mit Netzentgelten, Abgaben und Steuern. Prognose ohne Gewähr.")
                .font(.caption2)
                .foregroundStyle(Brand.dim)
        }
        .navigationTitle("Markt")
        .screenActions(.market, [
            ScreenAction(id: "refresh", title: String(localized: "Aktualisieren"), icon: "arrow.clockwise", disabled: market.loading) {
                Task { await refreshAll() }
            },
        ])
        .refreshable { await refreshAll() }
        .task { await market.refresh() }
        .task(id: BoxKey(system: systemID, online: controller?.isOnline)) { await loadBoxPrices() }
        .task(id: BoxKey(system: systemID, online: controller?.isOnline)) {
            // Die Historie wächst alle Viertelstunde um einen Slot — solange die Seite offen ist, nachladen.
            while !Task.isCancelled {
                await loadEnergy()
                try? await Task.sleep(for: .seconds(300))
            }
        }
        .onChange(of: selectedKey) { _, k in chrome.marketDay = k }
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

    /// Was von der Anlage kommt, gehört zu genau dieser Anlage und ihrem Verbindungsstand.
    private struct BoxKey: Equatable { let system: String?; let online: Bool? }

    private var systemID: String? { controller?.credentials.id }

    /// Beide Wege zum Aktualisieren (Knopf und Herunterziehen) laden alles neu.
    private func refreshAll() async {
        await market.refresh(force: true)
        await loadEnergy()
    }

    /// Heute, morgen (sobald fest) und die Prognosetage (Aufbau im Paket, dort getestet).
    private var days: [MarketDay] {
        MarketDay.build(today: market.today, tomorrow: market.tomorrow, prices: { market.prices(on: $0) }, outlook: market.outlook)
    }

    private var currentPoint: PricePoint? { market.currentPrice ?? PriceSeries.current(boxPrices) }

    /// Warum (noch) kein Bezugstarif im Diagramm steht — nil, wenn er da ist.
    private var tariffState: String? {
        if boxPrices.contains(where: { $0.importCtKwh != nil }) { return nil }
        guard let controller else { return String(localized: "Den Bezugstarif zeigt das Diagramm, sobald eine Anlage gekoppelt ist.") }
        if !controller.isOnline { return String(localized: "Der Bezugstarif kommt von der Anlage – sie ist gerade nicht verbunden.") }
        return boxLoaded ? String(localized: "In DVhub ist kein Bezugstarif eingerichtet (Einstellungen → Strompreise).") : nil
    }

    /// Warum (noch) keine Energiemengen im Diagramm stehen — nil, wenn sie da sind oder noch laden.
    private var energyState: String? {
        let energy = shownEnergy
        if energy.key == MarketTime.key(Date()), EnergyDay.hasFlows(energy.slots) { return nil }
        guard let controller else { return String(localized: "Die Energiemengen zeigt das Diagramm, sobald eine Anlage gekoppelt ist.") }
        if !controller.isOnline { return String(localized: "Die Energiemengen kommen von der Anlage – sie ist gerade nicht verbunden.") }
        if let e = energy.error { return e }
        return energy.key == MarketTime.key(Date()) ? String(localized: "Für heute liegen noch keine Energiemengen vor.") : nil
    }

    /// Nur die Werte der gewählten Anlage — nach einem Wechsel nie die der vorigen.
    private var shownEnergy: MarketEnergy { energy.system == systemID ? energy : MarketEnergy() }

    /// Energiemengen von heute (deutscher Börsentag) aus der Tages-Historie der Box.
    private func loadEnergy() async {
        #if DEBUG
        // Nur für Bildschirmfotos: -DVHUB_MARKET_ENERGY_DEMO 1 zeichnet einen Beispieltag.
        if UserDefaults.standard.bool(forKey: "DVHUB_MARKET_ENERGY_DEMO") {
            energy = MarketEnergy.demo(system: systemID)
            return
        }
        #endif
        // Andere Anlage gewählt: deren Vorgänger-Werte sofort weg, auch wenn sie nicht erreichbar ist.
        if energy.system != systemID { energy = MarketEnergy(system: systemID) }
        guard let controller, controller.isOnline else { return }
        let system = controller.credentials.id
        let key = MarketTime.key(Date())
        guard let from = MarketTime.day(key) else { return }
        let result = await BoxData.history(controller, view: .day, date: from, day: key)
        // Inzwischen andere Anlage gewählt: Antwort verwerfen.
        guard !Task.isCancelled, system == systemID else { return }
        switch result {
        case .ok(let s):
            energy = MarketEnergy(system: system, key: key, slots: EnergyDay.slots(s, from: from, to: MarketTime.dayEnd(from)), error: nil)
        case .proRequired:
            energy = MarketEnergy(system: system, key: nil, slots: [], error: String(localized: "Die Energiemengen des Tages gibt diese Anlage nicht frei."))
        case .failed(let m):
            // Werte desselben Tages bleiben stehen; ein alter Tag nicht.
            energy = energy.key == key ? MarketEnergy(system: system, key: key, slots: energy.slots, error: m)
                                       : MarketEnergy(system: system, key: nil, slots: [], error: m)
        }
    }

    /// Eigener Bezugspreis je Viertelstunde aus der Box (Tarif aus DVhub).
    private func loadBoxPrices() async {
        // Der Tarif einer anderen Anlage bleibt nicht stehen.
        if boxSystem != systemID { boxPrices = []; boxLoaded = false; boxSystem = systemID }
        guard let controller, controller.isOnline else { return }
        let system = controller.credentials.id
        guard let r = try? await controller.request("GET", "/api/status"), r.status == 200, system == systemID else { return }
        boxPrices = PriceSeries.from(status: r.body)
        boxLoaded = true
    }
}

/// Energiemengen eines Börsentags, wie sie zuletzt von der Box kamen.
struct MarketEnergy: Equatable {
    /// Anlage, von der die Werte stammen.
    var system: String?
    /// Tag (YYYY-MM-DD, deutsche Zeit), zu dem `slots` gehören; nil = noch nichts geladen.
    var key: String?
    var slots: [EnergySlot] = []
    var error: String?

    #if DEBUG
    /// Beispieltag bis „jetzt“: Sonne mittags, Akku lädt daraus und trägt den Abend, nachts Netz.
    static func demo(system: String?, now: Date = Date()) -> MarketEnergy {
        let from = MarketTime.startOfDay(now)
        var slots: [EnergySlot] = []
        var t = from
        while t < now {
            let h = t.timeIntervalSince(from) / 3600
            let sun = max(0, 2.2 * sin((h - 7.5) / 9 * .pi)) * (h > 7.5 && h < 16.5 ? 1 : 0)
            let home = 0.12 + 0.1 * abs(sin(h * 1.7)) + (h > 17 ? 0.15 : 0)
            let direct = min(sun, home)
            let spare = sun - direct
            let toBattery = h < 13 ? min(spare, 0.6) : 0
            let need = home - direct
            let fromBattery = h > 15.5 ? min(need, 0.2) : 0
            slots.append(EnergySlot(start: t, end: t.addingTimeInterval(900), solarToHomeKwh: direct, solarToBatteryKwh: toBattery,
                                    solarToGridKwh: spare - toBattery, batteryToHomeKwh: fromBattery,
                                    batteryToGridKwh: h > 17 && h < 18.5 ? 0.5 : 0,
                                    gridToHomeKwh: need - fromBattery, gridToBatteryKwh: h > 2 && h < 4 ? 0.8 : 0))
            t = t.addingTimeInterval(900)
        }
        return MarketEnergy(system: system, key: MarketTime.key(now), slots: slots, error: nil)
    }
    #endif
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

    /// Farbe nach Lage im üblichen Bereich: grün (unten) über gelb zu rot (oben).
    static func color(zone z: PriceBandZone?) -> Color {
        switch z {
        case .below: return Brand.green
        case .low: return Color(hex: 0x9be36a)
        case .middle: return Brand.yellow
        case .high: return Brand.orange
        case .above: return Brand.red
        case nil: return Brand.dim
        }
    }

    /// Lage in Worten — eine Darstellung, keine zweite Einstufung.
    static func zoneText(_ z: PriceBandZone?) -> String {
        switch z {
        case .below: return String(localized: "unter dem üblichen Bereich")
        case .low: return String(localized: "nahe günstig")
        case .middle: return String(localized: "mittig")
        case .high: return String(localized: "nahe teuer")
        case .above: return String(localized: "über dem üblichen Bereich")
        case nil: return " "
        }
    }

    /// Lage mit Zahl: „nahe günstig · 8 %“ (0 % = untere, 100 % = obere Schwelle).
    /// Außerhalb des Bereichs sagt der Text schon alles; `short` für die schmale Tageskarte.
    static func zoneDetail(_ d: MarketDay, short: Bool = false) -> String {
        guard let z = d.zone, let p = d.position else { return " " }
        if z == .below { return short ? String(localized: "unter dem Üblichen") : zoneText(z) }
        if z == .above { return short ? String(localized: "über dem Üblichen") : zoneText(z) }
        return "\(zoneText(z)) · \(pct(p))"
    }

    /// Herkunft und Einstufung: „Börse · günstig“, „Prognose · normal“.
    static func classLine(_ d: MarketDay) -> String {
        let source = d.isFixed ? String(localized: "Börse") : String(localized: "Prognose")
        guard let c = d.priceClass else { return source }
        return "\(source) · \(c.title)"
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
        if cal.isDateInToday(d) { return String(localized: "Heute") }
        if cal.isDateInTomorrow(d) { return String(localized: "Morgen") }
        var f = Date.FormatStyle.dateTime.weekday(.abbreviated).locale(Format.locale)
        f.timeZone = MarketTime.zone
        return d.formatted(f)
    }

    static func dayMonth(_ d: Date) -> String {
        var f = Date.FormatStyle.dateTime.day().month(.twoDigits).locale(Format.locale)
        f.timeZone = MarketTime.zone
        return d.formatted(f)
    }

    static func longDay(_ d: Date) -> String {
        var f = Date.FormatStyle.dateTime.weekday(.wide).day().month(.wide).locale(Format.locale)
        f.timeZone = MarketTime.zone
        return d.formatted(f)
    }

    static func hour(_ d: Date) -> String {
        var f = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(Format.locale)
        f.timeZone = MarketTime.zone
        return d.formatted(f)
    }

    static func range(_ a: Date, _ b: Date) -> String { "\(hour(a))–\(hour(b))" }

    static func ct1(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "–" }
        return v.formatted(.number.precision(.fractionLength(1)).locale(Format.locale))
    }

    /// Leistung ohne Einheit, eine Nachkommastelle; unter 10 W „0“ statt „0,0“.
    static func kw1(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "–" }
        return abs(v) < 0.05 ? "0" : abs(v).formatted(.number.precision(.fractionLength(1)).locale(Format.locale))
    }

    static func color(_ p: EnergyParty) -> Color {
        switch p {
        case .solar: return Brand.pv
        case .battery: return Brand.battery
        case .grid: return Brand.grid
        case .home: return Brand.home
        }
    }

    static func pct(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "–" }
        return v.formatted(.percent.precision(.fractionLength(0)).locale(Format.locale))
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

/// `labelWidth`: feste Breite der Beschriftung — zwei Diagramme untereinander
/// bekommen so dieselbe Zeichenfläche, ihre Zeitachsen liegen genau übereinander.
/// `magnitude`: Beträge zeigen (unter der Nulllinie liegt eine Menge, kein Minus).
func CtAxis(labelWidth: CGFloat? = nil, magnitude: Bool = false) -> some AxisContent {
    AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
        AxisGridLine().foregroundStyle(Brand.hairline)
        AxisValueLabel {
            if let v = value.as(Double.self) {
                Text((magnitude ? abs(v) : v).formatted(.number.precision(.fractionLength(0)).locale(Format.locale)))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Brand.dim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .frame(width: labelWidth, alignment: .trailing)
            }
        }
    }
}

// MARK: - Tagesleiste

private struct DayStrip: View {
    let days: [MarketDay]
    @Binding var selected: String
    let outlook: ResidualOutlook?
    /// Breite der Seite (Spaltenwahl von AuroraPage).
    let width: CGFloat
    /// Kachelbreite wächst mit der Schriftgröße mit.
    @ScaledMetric(relativeTo: .title2) private var tileWidth: CGFloat = 118
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Alle Tage nebeneinander nur, wenn jede Kachel ihre volle Breite bekommt —
    /// sonst rollt die Leiste (schmaler würden die Texte abgeschnitten).
    private var wide: Bool {
        let n = CGFloat(max(1, days.count))
        return typeSize.pageWidth(width) - 32 >= n * tileWidth + (n - 1) * 10
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Die nächsten Tage")
            if wide {
                HStack(spacing: 10) { ForEach(days) { tile($0).frame(maxWidth: .infinity) } }
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) { ForEach(days) { tile($0).frame(width: tileWidth).id($0.key) } }
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
        let tint = MarketStyle.color(zone: d.zone)
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
                    Ampel(priceClass: d.priceClass, zone: d.zone)
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
                PositionScale(position: d.position)
                DaySpark(hours: outlook?.hours(on: d.key) ?? [], slots: d.slots, tint: tint)
                    .frame(height: 20)
                VStack(alignment: .leading, spacing: 0) {
                    // Herkunft und Einstufung in der Farbe der Lage, darunter die Lage selbst.
                    Text(MarketStyle.classLine(d)).foregroundStyle(d.priceClass == nil ? Brand.text2 : tint)
                    Text(MarketStyle.zoneDetail(d, short: true)).foregroundStyle(Brand.text2)
                }
                .font(.caption2.weight(.semibold))
                .lineLimit(1).minimumScaleFactor(0.6)
            }
            .padding(10)
            .background(shape.fill(.ultraThinMaterial))
            .background(shape.fill(tint.opacity(isSel ? 0.24 : 0.10)))
            // Prognose gestrichelt: Sie ist eine Schätzung, kein Börsenpreis.
            .overlay(shape.strokeBorder(isSel ? tint : tint.opacity(d.zone == nil ? 0 : 0.35),
                                        style: StrokeStyle(lineWidth: isSel ? 2 : 1, dash: d.isFixed ? [] : [5, 3])))
            .overlay { if !isSel, d.zone == nil { shape.strokeBorder(Brand.border, style: StrokeStyle(lineWidth: 1, dash: d.isFixed ? [] : [5, 3])) } }
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(a11y(d))
        .accessibilityAddTraits(isSel ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("marketDay.\(d.key)")
    }

    private func a11y(_ d: MarketDay) -> String {
        let day = MarketStyle.longDay(d.date), mean = Format.ct(d.meanCt)
        var s = d.isFixed ? String(localized: "\(day), Börsenpreis im Mittel \(mean)") : String(localized: "\(day), Prognose im Mittel \(mean)")
        if let r = d.rangeCt { s += String(localized: ", Spanne \(Format.ct(r.0)) bis \(Format.ct(r.1))") }
        if let c = d.priceClass { s += String(localized: ", Einstufung \(c.title)") }
        if d.zone != nil { s += ", \(MarketStyle.zoneText(d.zone))" }
        return s
    }
}

/// Ampel: günstig (grün), normal (gelb), teuer (rot) — das Licht der Einstufung
/// leuchtet. Liegt ein normaler Tag nahe an einer Schwelle, glimmt das
/// Nachbarlicht mit: gelb mit grün = normal, nahe günstig.
struct Ampel: View {
    let priceClass: PriceClass?
    var zone: PriceBandZone? = nil

    /// Wohin der Tag neigt, ohne so eingestuft zu sein.
    private var leaning: PriceClass? {
        guard priceClass == .normal else { return nil }
        switch zone {
        case .low, .below: return .cheap
        case .high, .above: return .expensive
        default: return nil
        }
    }

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
        let glow = leaning == c
        return Circle()
            .fill(on ? color : color.opacity(glow ? 0.6 : 0.14))
            .frame(width: 9, height: 9)
            .shadow(color: on ? color.opacity(0.9) : (glow ? color.opacity(0.5) : .clear), radius: on ? 4 : 2)
    }
}

/// Lage des Tagesmittels zwischen den Schwellen der Einstufung: links günstig
/// (unter P20), rechts teuer (über P80), dazwischen der übliche Bereich.
private struct PositionScale: View {
    let position: Double?

    var body: some View {
        GeometryReader { g in
            // Ein Fünftel Rand je Seite für Werte außerhalb des Bereichs.
            let p = max(-0.25, min(1.25, position ?? 0.5))
            let x = CGFloat((p + 0.25) / 1.5) * g.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(LinearGradient(stops: [
                    .init(color: Brand.green, location: 0), .init(color: Brand.green, location: 0.16),
                    .init(color: Brand.yellow, location: 0.5),
                    .init(color: Brand.red, location: 0.84), .init(color: Brand.red, location: 1),
                ], startPoint: .leading, endPoint: .trailing))
                .opacity(position == nil ? 0.2 : 0.9)
                .frame(height: 6)
                // Marken für P20 und P80.
                Rectangle().fill(Brand.bg0).frame(width: 1.5, height: 11).offset(x: g.size.width / 6)
                Rectangle().fill(Brand.bg0).frame(width: 1.5, height: 11).offset(x: g.size.width * 5 / 6)
                if position != nil {
                    Circle().fill(Brand.text).frame(width: 11, height: 11)
                        .overlay(Circle().strokeBorder(Brand.bg0, lineWidth: 2))
                        .offset(x: min(g.size.width - 11, max(0, x - 5.5)))
                }
            }
            .frame(height: 11)
        }
        .frame(height: 11)
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
        // Feste Tage: die Börsenpreise selbst, nie die Prognose für denselben Tag.
        let values: [Double] = !slots.isEmpty ? hourly(slots) : hours.compactMap(\.ct)
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

// MARK: - Einspeisung und Bezug (heute / morgen)

/// Feste Viertelstunden eines Börsentags: Balken = Einspeisung (Börsenpreis),
/// Linie = eigener Bezugstarif. Zum Ablesen und Auswerten.
private struct ExchangeCard: View {
    let days: [MarketDay]
    /// Preise der Box mit dem eigenen Bezugstarif je Slot.
    let box: [PricePoint]
    let now: PricePoint?
    /// Hinweis, warum kein Bezugstarif da ist (nil = vorhanden oder noch unklar).
    let tariffState: String?
    /// Energiemengen von heute; für andere Tage gibt es (noch) keine.
    let energy: MarketEnergy
    /// Hinweis, warum keine Energiemengen da sind (nil = vorhanden oder noch unklar).
    let energyState: String?
    @Binding var selectedKey: String
    @State private var shownKey: String?
    /// Eine Auswahl für beide Diagramme (Preis und Energie).
    @State private var selection: Date?
    /// Feste Breite der Achsenbeschriftung: beide Diagramme zeichnen deckungsgleich.
    @ScaledMetric(relativeTo: .caption2) private var axisWidth: CGFloat = 24

    private var day: MarketDay? { days.first { $0.key == shownKey } ?? days.first }

    var body: some View {
        GlassCard(tint: Brand.blue) {
            VStack(alignment: .leading, spacing: 10) {
                ViewThatFits(in: .horizontal) {
                    HStack { title; Spacer(); dayPicker }
                    VStack(alignment: .leading, spacing: 8) { title; dayPicker }
                }
                if let d = day {
                    let points = Tariff.points(market: d.slots, box: box)
                    nowLine(points)
                    readout(d, points)
                    chart(d, points).frame(height: 220)
                    legend(points)
                    energySection(d)
                    stats(d, points)
                } else {
                    Text("Noch keine Börsenpreise geladen.").font(.footnote).foregroundStyle(Brand.text2)
                }
            }
        }
        // Tageskarte gewählt: fester Tag → hier zeigen.
        .onChange(of: selectedKey, initial: true) { _, k in
            if days.contains(where: { $0.key == k }) { shownKey = k; selection = nil }
        }
    }

    private var title: some View { Eyebrow(text: "Einspeisung und Bezug", icon: "arrow.up.arrow.down", tint: Brand.blue) }

    @ViewBuilder private var dayPicker: some View {
        if days.count > 1 {
            Picker("Tag", selection: Binding(get: { day?.key ?? "" }, set: { shownKey = $0; selectedKey = $0 })) {
                ForEach(days) { Text(MarketStyle.weekday($0.date)).tag($0.key) }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 190)
        } else if let d = day {
            Text("\(MarketStyle.weekday(d.date)) \(MarketStyle.dayMonth(d.date))").font(.caption.monospacedDigit()).foregroundStyle(Brand.text2)
        }
    }

    /// Was gerade gilt — bewusst klein: Der Verlauf darunter sagt mehr als die eine Zahl.
    @ViewBuilder
    private func nowLine(_ points: [TariffPoint]) -> some View {
        if let now {
            let importNow = (PriceSeries.current(box)?.importCtKwh) ?? points.first { $0.contains(Date()) }?.importCt
            HStack(spacing: 4) {
                Text("Gerade gilt:")
                Text(verbatim: MarketStyle.ct1(now.ctKwh)).accessibilityIdentifier("marketNowPrice")
                Text(importNow.map { String(localized: "ct Einspeisung · \(MarketStyle.ct1($0)) ct Bezug") } ?? String(localized: "ct/kWh an der Börse"))
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(Brand.text2)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .accessibilityElement(children: .combine)
        }
    }

    private func selected(_ points: [TariffPoint]) -> TariffPoint? {
        if let selection { return points.first { $0.contains(selection) } }
        return points.first { $0.contains(Date()) }
    }

    private func readout(_ d: MarketDay, _ points: [TariffPoint]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let p = selected(points) {
                HStack(alignment: .firstTextBaseline) {
                    Text(MarketStyle.range(p.start, p.end)).foregroundStyle(Brand.text2)
                    Spacer()
                    if let spread = p.spreadCt {
                        Text("Spanne \(Format.ct(spread))").font(.system(.headline, design: .rounded).weight(.bold)).foregroundStyle(Brand.text)
                    } else {
                        Text(Format.ct(p.exportCt)).font(.system(.headline, design: .rounded).weight(.bold)).foregroundStyle(p.exportCt < 0 ? Brand.red : Brand.text)
                    }
                }
                if let imp = p.importCt {
                    HStack {
                        Label("Einspeisung \(Format.ct(p.exportCt))", systemImage: "arrow.up.right").foregroundStyle(p.exportCt < 0 ? Brand.red : Brand.priceUp)
                        Spacer(minLength: 8)
                        Label("Bezug \(Format.ct(imp))", systemImage: "arrow.down.right").foregroundStyle(Brand.orange)
                    }
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                }
            } else {
                Text((d.slotSeconds ?? 900) >= 3600 ? String(localized: "Halten und ziehen zeigt die Stunde.") : String(localized: "Halten und ziehen zeigt die Viertelstunde."))
                    .foregroundStyle(Brand.dim)
            }
        }
        .font(.subheadline.monospacedDigit())
        .frame(minHeight: 44, alignment: .top)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tariffReadout")
    }

    private func chart(_ d: MarketDay, _ points: [TariffPoint]) -> some View {
        let now = Date()
        // Treppe: je Slot ein Punkt am Beginn, am Ende des letzten noch einer.
        let importSteps: [(Date, Double)] = points.compactMap { p in p.importCt.map { (p.start, $0) } }
            + (points.last.flatMap { p in p.importCt.map { [(p.end, $0)] } } ?? [])
        return Chart {
            ForEach(points) { p in
                RectangleMark(xStart: .value("Beginn", p.start), xEnd: .value("Ende", p.end), yStart: .value("Null", 0.0), yEnd: .value("ct/kWh", p.exportCt))
                    .foregroundStyle(barStyle(p, now: now))
                    .accessibilityLabel(MarketStyle.range(p.start, p.end))
                    .accessibilityValue(p.importCt.map { String(localized: "Einspeisung \(Format.ct(p.exportCt)), Bezug \(Format.ct($0))") } ?? Format.ct(p.exportCt))
            }
            ForEach(Array(importSteps.enumerated()), id: \.offset) { _, step in
                LineMark(x: .value("Zeit", step.0), y: .value("Bezug", step.1), series: .value("Reihe", "Bezug"))
                    .interpolationMethod(.stepEnd)
                    .foregroundStyle(Brand.orange)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .accessibilityHidden(true)
            }
            if points.contains(where: { $0.contains(now) }) {
                RuleMark(x: .value("Jetzt", now))
                    .foregroundStyle(Brand.now)
                    .lineStyle(StrokeStyle(lineWidth: 1.5))
                    .annotation(position: .topTrailing, spacing: 2) { Text("jetzt").font(.caption2.weight(.bold)).foregroundStyle(Brand.now) }
            }
            if let selection {
                RuleMark(x: .value("Auswahl", selection)).foregroundStyle(Brand.text.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXSelection(value: $selection)
        .chartXScale(domain: d.date...MarketTime.dayEnd(d.date))
        .chartXAxis { MarketHourAxis(everyHours: 3) }
        .chartYAxis { CtAxis(labelWidth: axisWidth) }
        .accessibilityLabel(importSteps.isEmpty ? Text("Börsenpreise im Tagesverlauf") : Text("Einspeisung und Bezug im Tagesverlauf"))
        .accessibilityChartDescriptor(TimeSeriesDescriptor(
            title: String(localized: "Einspeisung und Bezug \(MarketStyle.longDay(d.date))"),
            summary: ChartSummary.lowHigh(points.map { ($0.start, $0.exportCt) }, format: Format.ct),
            yTitle: String(localized: "Cent je Kilowattstunde"),
            series: [.init(name: String(localized: "Einspeisung"), points: points.map { ($0.start, $0.exportCt) })]
                + (importSteps.isEmpty ? [] : [.init(name: String(localized: "Bezug"), points: points.compactMap { p in p.importCt.map { (p.start, $0) } })]),
            format: Format.ct))
        .accessibilityIdentifier("priceChart")
    }

    private func barStyle(_ p: TariffPoint, now: Date) -> Color {
        let base = p.exportCt < 0 ? Brand.priceDown : Brand.priceUp
        if p.contains(now) { return Brand.now }
        return p.end <= now ? base.opacity(0.4) : base
    }

    @ViewBuilder
    private func legend(_ points: [TariffPoint]) -> some View {
        let hasImport = points.contains { $0.importCt != nil }
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                HStack(spacing: 5) { RoundedRectangle(cornerRadius: 2).fill(Brand.priceUp).frame(width: 10, height: 10); Text("Einspeisung (Börsenpreis)") }
                if hasImport {
                    HStack(spacing: 5) { Capsule().fill(Brand.orange).frame(width: 14, height: 3); Text("Bezug (dein Tarif, brutto)") }
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            if !hasImport, let tariffState { Text(tariffState).foregroundStyle(Brand.dim) }
        }
        .font(.caption2)
        .foregroundStyle(Brand.text2)
        .accessibilityIdentifier("tariffLegend")
    }

    // MARK: Energiemengen im Tagesverlauf

    /// Unter dem Preis, auf derselben Zeitachse: woher der Strom kam und wohin er ging.
    @ViewBuilder
    private func energySection(_ d: MarketDay) -> some View {
        let isToday = d.key == MarketTime.key(Date())
        let slots = isToday && energy.key == d.key ? energy.slots : []
        Hairline()
        HStack(alignment: .firstTextBaseline) {
            Text("Energie im Tagesverlauf").font(.caption.weight(.bold)).foregroundStyle(Brand.text)
            Spacer(minLength: 8)
            Text("kW je Viertelstunde").font(.caption2).foregroundStyle(Brand.dim)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        if EnergyDay.hasFlows(slots) {
            energyReadout(slots)
            energyChart(d, slots).frame(height: 170)
            energyLegend(slots)
        } else if !isToday {
            Text("Energiemengen werden gemessen, nicht vorhergesagt – für diesen Tag gibt es noch keine.")
                .font(.caption2).foregroundStyle(Brand.dim)
                .accessibilityIdentifier("energyState")
        } else if let energyState {
            Text(energyState).font(.caption2).foregroundStyle(Brand.dim)
                .accessibilityIdentifier("energyState")
        } else {
            ProgressView().frame(maxWidth: .infinity, minHeight: 60)
        }
    }

    /// Slot zur Auswahl; ohne Auswahl der laufende, sonst der letzte gemessene.
    private func selectedEnergy(_ slots: [EnergySlot]) -> EnergySlot? {
        if let selection { return slots.first { $0.contains(selection) } }
        return slots.first { $0.contains(Date()) } ?? slots.last
    }

    private func energyReadout(_ slots: [EnergySlot]) -> some View {
        let s = selectedEnergy(slots)
        let battery = s?.batteryNetKw, grid = s?.gridNetKw
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 6) {
                energyValue(.solar, String(localized: "Solar"), s.map { $0.kw($0.sourceKwh(.solar)) })
                energyValue(.home, String(localized: "Haus"), s.map { $0.kw($0.sinkKwh(.home)) })
                energyValue(.battery, (battery ?? 0) < -0.05 ? String(localized: "Akku entlädt") : ((battery ?? 0) > 0.05 ? String(localized: "Akku lädt") : String(localized: "Akku")), battery)
                energyValue(.grid, (grid ?? 0) < -0.05 ? String(localized: "Einspeisung") : ((grid ?? 0) > 0.05 ? String(localized: "Bezug") : String(localized: "Netz")), grid)
            }
            Text(s.map { MarketStyle.range($0.start, $0.end) } ?? String(localized: "Für diese Zeit gibt es noch keine Messwerte."))
                .font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("energyReadout")
    }

    private func energyValue(_ p: EnergyParty, _ label: String, _ kw: Double?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Circle().fill(MarketStyle.color(p)).frame(width: 7, height: 7)
                Text(label).font(.caption2).foregroundStyle(Brand.text2)
            }
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(MarketStyle.kw1(kw)).font(.system(.subheadline, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
                Text("kW").font(.caption2).foregroundStyle(Brand.dim)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(label) \(MarketStyle.kw1(kw)) kW"))
    }

    private func energyChart(_ d: MarketDay, _ slots: [EnergySlot]) -> some View {
        let now = Date()
        let extent = EnergyDay.extentKw(slots)
        // Etwas Luft, und nie eine Achse ohne Ausschlag.
        let up = max(0.5, extent.up * 1.08), down = max(0.5, extent.down * 1.08)
        func series(_ name: String, _ f: (EnergySlot) -> Double) -> TimeSeriesDescriptor.Series {
            .init(name: name, points: slots.map { ($0.start, f($0)) })
        }
        return Chart {
            ForEach(slots) { s in
                // Schmale Fuge zwischen den Slots, damit die Stapel lesbar bleiben.
                let gap = s.end.timeIntervalSince(s.start) * 0.08
                ForEach(s.bars) { b in
                    RectangleMark(xStart: .value("Beginn", b.start.addingTimeInterval(gap)), xEnd: .value("Ende", b.end.addingTimeInterval(-gap)),
                                  yStart: .value("von", b.fromKw), yEnd: .value("kW", b.toKw))
                        .foregroundStyle(MarketStyle.color(b.party))
                        .accessibilityHidden(true)
                }
            }
            RuleMark(y: .value("Null", 0.0)).foregroundStyle(Brand.text2.opacity(0.7)).lineStyle(StrokeStyle(lineWidth: 1))
                .accessibilityHidden(true)
            if now >= d.date, now < MarketTime.dayEnd(d.date) {
                RuleMark(x: .value("Jetzt", now)).foregroundStyle(Brand.now).lineStyle(StrokeStyle(lineWidth: 1.5))
                    .accessibilityHidden(true)
            }
            if let selection {
                RuleMark(x: .value("Auswahl", selection)).foregroundStyle(Brand.text.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .accessibilityHidden(true)
            }
        }
        .chartXSelection(value: $selection)
        .chartXScale(domain: d.date...MarketTime.dayEnd(d.date))
        .chartYScale(domain: -down...up)
        .chartXAxis { MarketHourAxis(everyHours: 3) }
        .chartYAxis { CtAxis(labelWidth: axisWidth, magnitude: true) }
        .accessibilityLabel(Text("Energie im Tagesverlauf"))
        .accessibilityChartDescriptor(TimeSeriesDescriptor(
            title: String(localized: "Energie im Tagesverlauf \(MarketStyle.longDay(d.date))"),
            yTitle: String(localized: "Kilowatt im Mittel der Viertelstunde"),
            series: [
                series(String(localized: "Solar")) { $0.kw($0.sourceKwh(.solar)) },
                series(String(localized: "Haus")) { $0.kw($0.sinkKwh(.home)) },
                series(String(localized: "Akku (plus lädt, minus entlädt)")) { $0.batteryNetKw },
                series(String(localized: "Netz (plus Bezug, minus Einspeisung)")) { $0.gridNetKw },
            ],
            format: { "\(Format.number($0, digits: 1)) kW" }))
        .accessibilityIdentifier("energyChart")
    }

    private func energyLegend(_ slots: [EnergySlot]) -> some View {
        let t = EnergyDay.totals(slots)
        return VStack(alignment: .leading, spacing: 6) {
            // Die Farben erklärt die Ablesezeile über dem Diagramm (Punkt + Name).
            Text("Über der Nulllinie: woher der Strom kam. Darunter: wohin er ging.").foregroundStyle(Brand.dim)
            RowStack {
                ValueRow(label: "Solar erzeugt", value: Format.energy(t.solarKwh), tint: Brand.pv)
                ValueRow(label: "Haus verbraucht", value: Format.energy(t.homeKwh), tint: Brand.home)
                ValueRow(label: "Aus dem Netz bezogen", value: Format.energy(t.importKwh), tint: Brand.grid)
                ValueRow(label: "Ins Netz eingespeist", value: Format.energy(t.exportKwh), tint: Brand.grid)
            }
            .accessibilityIdentifier("energyTotals")
        }
        .font(.caption2)
        .foregroundStyle(Brand.text2)
        .accessibilityIdentifier("energyLegend")
    }

    /// Einstufung des Börsentags: Tagesmittel gegen den üblichen Bereich der letzten vier Wochen.
    private func classRow(_ d: MarketDay) -> ValueRow? {
        guard let c = d.priceClass, let p20 = d.p20Ct, let p80 = d.p80Ct else { return nil }
        return ValueRow(label: "Einstufung des Tagesmittels", value: c.title, tint: MarketStyle.color(zone: d.zone),
                        hint: String(localized: "\(MarketStyle.zoneDetail(d)) · üblich \(MarketStyle.ct1(p20))–\(MarketStyle.ct1(p80)) ct"))
    }

    @ViewBuilder
    private func stats(_ d: MarketDay, _ points: [TariffPoint]) -> some View {
        if let t = Tariff.stats(points) {
            RowStack {
                ValueRow(label: "Einspeisung im Mittel", value: Format.ct(t.meanExportCt), tint: Brand.priceUp)
                ValueRow(label: "Bezug im Mittel", value: Format.ct(t.meanImportCt), tint: Brand.orange)
                ValueRow(label: "Spanne im Mittel", value: Format.ct(t.meanSpreadCt),
                         hint: String(localized: "kleinste \(MarketStyle.ct1(t.minSpread.spreadCt)) ct um \(MarketStyle.hour(t.minSpread.start)) · größte \(MarketStyle.ct1(t.maxSpread.spreadCt)) ct um \(MarketStyle.hour(t.maxSpread.start))"))
            }
            .accessibilityIdentifier("tariffStats")
            Text("Börsenpreise im Einzelnen").font(.caption.weight(.bold)).foregroundStyle(Brand.text).padding(.top, 2)
        }
        if d.slotsAreFallback {
            // Ersatz-Stunden aus der Prognose-Antwort: Tageswerte des Servers zeigen,
            // nicht aus (womöglich lückenhaften) Stunden neu rechnen.
            RowStack {
                if let r = d.rangeCt { ValueRow(label: "Tief", value: Format.ct(r.0), tint: Brand.green) }
                if let m = d.meanCt { ValueRow(label: "Mittel", value: Format.ct(m)) }
                if let r = d.rangeCt { ValueRow(label: "Hoch", value: Format.ct(r.1), tint: Brand.orange) }
                if let row = classRow(d) { row }
            }
            if d.slotsIncomplete {
                Text("Für diesen Tag liegen noch nicht alle Stunden vor.").font(.caption).foregroundStyle(Brand.dim)
            }
        } else if let s = PriceSeries.stats(d.slots) {
            let cheap = OnlinePrices.window(d.slots, hours: 3, cheapest: true)
            let dear = OnlinePrices.window(d.slots, hours: 3, cheapest: false)
            RowStack {
                ValueRow(label: "Tief", value: "\(Format.ct(s.min.ctKwh)) · \(MarketStyle.hour(s.min.start))", tint: Brand.green)
                ValueRow(label: "Mittel", value: Format.ct(s.average))
                ValueRow(label: "Hoch", value: "\(Format.ct(s.max.ctKwh)) · \(MarketStyle.hour(s.max.start))", tint: Brand.orange)
                if let cheap {
                    ValueRow(label: "Günstigste 3 Stunden", value: String(localized: "\(MarketStyle.range(cheap.start, cheap.end)) · ⌀ \(MarketStyle.ct1(cheap.averageCt)) ct"), tint: Brand.green)
                }
                if let dear {
                    ValueRow(label: "Teuerste 3 Stunden", value: String(localized: "\(MarketStyle.range(dear.start, dear.end)) · ⌀ \(MarketStyle.ct1(dear.averageCt)) ct"), tint: Brand.orange)
                }
                if s.negativeSlots > 0 {
                    let step = d.slots.first.map { $0.end.timeIntervalSince($0.start) } ?? 900
                    ValueRow(label: "Negative Preise", value: Format.hours(Double(s.negativeSlots) * step / 3600), tint: Brand.red)
                }
                if let row = classRow(d) { row }
            }
        }
    }
}

// MARK: - Preisprognose der nächsten Tage

/// Prognose je Stunde mit Band (10–90 %) über die Prognosetage.
private struct ForecastCard: View {
    let days: [MarketDay]
    let hours: [ResidualOutlook.Hour]
    @Binding var selectedKey: String
    let wide: Bool
    @State private var selection: Date?

    private var forecast: [ResidualOutlook.Hour] {
        guard let from = days.first?.date else { return [] }
        return hours.filter { $0.band != nil && $0.start >= from }
    }

    private var selectedDay: MarketDay? { days.first { $0.key == selectedKey } }

    var body: some View {
        GlassCard(tint: Brand.cyan) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Eyebrow(text: "Preisprognose · nächste Tage", icon: "scope", tint: Brand.cyan)
                    Spacer()
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2).fill(Brand.cyan.opacity(0.35)).frame(width: 12, height: 8)
                            .overlay { Rectangle().fill(Brand.cyan).frame(height: 2) }
                        Text("Mitte und Band 10–90 %").font(.caption2).foregroundStyle(Brand.text2).lineLimit(1).minimumScaleFactor(0.7)
                    }
                    .accessibilityHidden(true)
                }
                readout
                chart.frame(height: wide ? 240 : 200)
                if let d = selectedDay, let f = d.forecast {
                    Hairline()
                    Text(MarketStyle.longDay(d.date)).font(.caption.weight(.bold)).foregroundStyle(Brand.text)
                    RowStack {
                        ValueRow(label: "Erwartetes Tagesmittel", value: Format.ct(f.band.p50), tint: Brand.cyan)
                        ValueRow(label: "Spanne (10–90 %)", value: String(localized: "\(MarketStyle.ct1(f.band.p10))–\(MarketStyle.ct1(f.band.p90)) ct"))
                        if let lo = f.minHourCt, let hi = f.maxHourCt {
                            ValueRow(label: "Günstigste / teuerste Stunde", value: String(localized: "\(MarketStyle.ct1(lo)) / \(MarketStyle.ct1(hi)) ct"))
                        }
                        ValueRow(label: "Einstufung", value: f.priceClass?.title ?? "–", tint: MarketStyle.color(zone: d.zone),
                                 hint: d.zone == nil ? nil : MarketStyle.zoneDetail(d))
                        if let p20 = f.p20Ct, let p80 = f.p80Ct {
                            ValueRow(label: "Üblicher Bereich", value: String(localized: "\(MarketStyle.ct1(p20))–\(MarketStyle.ct1(p80)) ct"), hint: String(localized: "Tagesmittel der letzten vier Wochen"))
                        }
                    }
                }
            }
        }
    }

    private var readout: some View {
        HStack(alignment: .firstTextBaseline) {
            if let selection, let h = forecast.last(where: { $0.start <= selection }), let b = h.band {
                Text("\(MarketStyle.weekday(h.start)) \(MarketStyle.hour(h.start))").foregroundStyle(Brand.text2)
                Spacer()
                Text("\(MarketStyle.ct1(b.p10))–\(MarketStyle.ct1(b.p90))").font(.caption).foregroundStyle(Brand.dim)
                Text(Format.ct(b.p50)).font(.system(.title3, design: .rounded).weight(.bold)).foregroundStyle(Brand.cyan)
            } else {
                Text("Halten und ziehen zeigt die Stunde.").foregroundStyle(Brand.dim)
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
        let start = days.first?.date ?? MarketTime.startOfDay(Date())
        let end = MarketTime.dayEnd(days.last?.date ?? start)
        return Chart {
            if let d = selectedDay {
                RectangleMark(xStart: .value("a", d.date), xEnd: .value("b", MarketTime.dayEnd(d.date)))
                    .foregroundStyle(Brand.text.opacity(0.07))
            }
            ForEach(forecast) { h in
                if let b = h.band {
                    AreaMark(x: .value("Zeit", h.start), yStart: .value("P10", b.p10), yEnd: .value("P90", b.p90))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Brand.cyan.opacity(0.22))
                    LineMark(x: .value("Zeit", h.start), y: .value("ct/kWh", b.p50))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Brand.cyan)
                        .lineStyle(StrokeStyle(lineWidth: 2.5))
                }
            }
            if let selection {
                RuleMark(x: .value("Auswahl", selection)).foregroundStyle(Brand.text.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXSelection(value: $selection)
        .chartXScale(domain: start...end)
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, calendar: MarketTime.calendar)) { value in
                AxisGridLine().foregroundStyle(Brand.border)
                if let d = value.as(Date.self) {
                    AxisValueLabel { Text(MarketStyle.weekday(d)).font(.caption2.weight(.bold)).foregroundStyle(Brand.text2) }
                }
            }
        }
        .chartYAxis { CtAxis() }
        .accessibilityLabel("Preisprognose je Stunde mit Bandbreite")
        .accessibilityChartDescriptor(TimeSeriesDescriptor(
            title: String(localized: "Preisprognose der nächsten Tage"),
            summary: ChartSummary.lowHigh(forecast.compactMap { h in h.band.map { (h.start, $0.p50) } }, format: Format.ct),
            yTitle: String(localized: "Cent je Kilowattstunde"),
            series: [
                .init(name: String(localized: "Mitte der Prognose"), points: forecast.compactMap { h in h.band.map { (h.start, $0.p50) } }),
                .init(name: String(localized: "Untere Grenze (10 %)"), points: forecast.compactMap { h in h.band.map { (h.start, $0.p10) } }),
                .init(name: String(localized: "Obere Grenze (90 %)"), points: forecast.compactMap { h in h.band.map { (h.start, $0.p90) } }),
            ],
            format: Format.ct))
        .accessibilityIdentifier("forecastChart")
    }
}
