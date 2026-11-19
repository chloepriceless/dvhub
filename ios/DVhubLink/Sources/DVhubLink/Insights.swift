// Insights.swift — Auswertung der Box-Antworten für Details, Börsenpreise,
// Historie und Energiefluss. Bewusst hier im Paket statt in der App: so
// lässt sich alles mit `swift test` prüfen, ohne Simulator.
//
// Quellen (Node-Code ist die Referenz):
//   GET /api/status          → server.js buildCurrentStatusPayload()
//   GET /api/history/summary → history-runtime.js getSummary()

import Foundation

// MARK: - Zahlen tolerant lesen

extension JSONValue {
    /// Zahl oder Zahl als Text; nicht endlich → nil.
    public var number: Double? { LiveStatus.num(self) }
}

// MARK: - Börsenpreise (Day-Ahead)

public struct PricePoint: Equatable, Sendable, Identifiable {
    public let start: Date
    public let end: Date
    /// Börsenpreis in ct/kWh (EPEX Day-Ahead).
    public let ctKwh: Double
    /// Eigener Bezugspreis brutto in ct/kWh (Tarif aus DVhub), falls eingerichtet.
    public let importCtKwh: Double?
    public var id: Date { start }

    public init(start: Date, end: Date, ctKwh: Double, importCtKwh: Double?) {
        self.start = start
        self.end = end
        self.ctKwh = ctKwh
        self.importCtKwh = importCtKwh
    }

    public func contains(_ d: Date) -> Bool { d >= start && d < end }
}

public struct PriceStats: Equatable, Sendable {
    public let min: PricePoint
    public let max: PricePoint
    /// Zeitgewichtetes Mittel.
    public let average: Double
    public let negativeSlots: Int
}

public enum PriceSeries {
    /// Preise aus `/api/status` (`epex.data`, dazu `userEnergyPricing.slots`
    /// für den eigenen Bezugspreis). `ts` ist Unix-ms (Zahl) oder ISO-Text.
    /// Die Slot-Länge folgt aus dem Abstand der Zeitstempel (15 oder 60 min).
    public static func from(status: JSONValue) -> [PricePoint] {
        let rows = status["epex"]?["data"]?.array ?? []
        var importByTs: [Int64: Double] = [:]
        for s in status["userEnergyPricing"]?["slots"]?.array ?? [] {
            if let ts = timestampMs(s["ts"]), let p = s["importPriceCtKwh"]?.number { importByTs[ts] = p }
        }
        var raw: [(Int64, Double)] = []
        for r in rows {
            guard let ts = timestampMs(r["ts"]) else { continue }
            let ct = r["ct_kwh"]?.number ?? r["eur_mwh"]?.number.map { $0 / 10 }
            guard let ct else { continue }
            raw.append((ts, ct))
        }
        raw.sort { $0.0 < $1.0 }
        // Doppelte Zeitstempel (z. B. Nachladen) nur einmal.
        var seen = Set<Int64>()
        raw = raw.filter { seen.insert($0.0).inserted }
        let step = typicalStepMs(raw.map(\.0))
        return raw.enumerated().map { i, item in
            let next = i + 1 < raw.count ? raw[i + 1].0 : item.0 + step
            // Lücke im Datensatz: nicht über die Lücke strecken.
            let endMs = (next - item.0) > step ? item.0 + step : next
            return PricePoint(start: Date(timeIntervalSince1970: Double(item.0) / 1000),
                              end: Date(timeIntervalSince1970: Double(endMs) / 1000),
                              ctKwh: item.1, importCtKwh: importByTs[item.0])
        }
    }

    static func timestampMs(_ v: JSONValue?) -> Int64? {
        guard let v else { return nil }
        if let d = v.number, d > 1e11 { return Int64(d) }
        if let s = v.string, let d = parseISODate(s) { return Int64((d.timeIntervalSince1970 * 1000).rounded()) }
        return nil
    }

    static func typicalStepMs(_ ts: [Int64]) -> Int64 {
        guard ts.count >= 2 else { return 900_000 }
        var counts: [Int64: Int] = [:]
        for i in 1..<ts.count { counts[ts[i] - ts[i - 1], default: 0] += 1 }
        let best = counts.max { a, b in a.value == b.value ? a.key > b.key : a.value < b.value }?.key ?? 900_000
        return best > 0 && best <= 3_600_000 ? best : 900_000
    }

    /// Nur die Slots eines Kalendertags (Zeitzone der App).
    public static func day(_ points: [PricePoint], containing day: Date, calendar: Calendar = .current) -> [PricePoint] {
        points.filter { calendar.isDate($0.start, inSameDayAs: day) }
    }

    public static func stats(_ points: [PricePoint]) -> PriceStats? {
        guard let lo = points.min(by: { $0.ctKwh < $1.ctKwh }), let hi = points.max(by: { $0.ctKwh < $1.ctKwh }) else { return nil }
        let weight = points.reduce(0.0) { $0 + $1.end.timeIntervalSince($1.start) }
        let sum = points.reduce(0.0) { $0 + $1.ctKwh * $1.end.timeIntervalSince($1.start) }
        return PriceStats(min: lo, max: hi, average: weight > 0 ? sum / weight : lo.ctKwh,
                          negativeSlots: points.filter { $0.ctKwh < 0 }.count)
    }

    public static func current(_ points: [PricePoint], at now: Date = Date()) -> PricePoint? {
        points.first { $0.contains(now) }
    }
}

// MARK: - Detailwerte aus /api/status

/// Die Felder der Detailansichten. Vorzeichen wie in DVhub: Akku + = Laden.
public struct StatusDetail: Equatable, Sendable {
    public var at: Date?
    // PV
    public var pvTotalW: Double?
    public var pvDcW: Double?
    public var pvAcW: Double?
    public var pvAcPhasesW: [Double?] = []
    public var pvAc2PhasesW: [Double?] = []
    // Akku
    public var soc: Double?
    public var batteryPowerW: Double?
    public var minSocPct: Double?
    public var maxDischargeW: Double?
    public var secondSocPct: Double?
    public var secondBatteryW: Double?
    // Netz
    public var gridImportW: Double?
    public var gridExportW: Double?
    public var gridSetpointW: Double?
    public var gridTotalW: Double?
    public var gridPhasesW: [Double?] = []
    /// „grid_import“ = positiver Zählerwert bedeutet Bezug.
    public var gridPositiveMeans: String?
    public var activeSetpointW: Double?
    public var activeSetpointSource: String?
    public var activeMinSocPct: Double?
    // Haus
    public var loadW: Double?
    // Flüsse (W)
    public var solarDirectUseW: Double?
    public var solarToBatteryW: Double?
    public var solarToGridW: Double?
    public var gridDirectUseW: Double?
    public var gridToBatteryW: Double?
    public var batteryDirectUseW: Double?
    public var batteryToGridW: Double?
    // Heute (Zähler der Box)
    public var importKwh: Double?
    public var exportKwh: Double?
    public var costEur: Double?
    public var revenueEur: Double?
    public var netEur: Double?
    public var spotNowCtKwh: Double?
    public var importPriceNowCtKwh: Double?
    public var timeZone: String?
    public var prices: [PricePoint] = []
    // Netzspannung je Phase (V) und Frequenz, falls ein Zähler sie liefert.
    public var gridVoltagesV: [Double?] = []
    public var gridFrequencyHz: Double?
    // Zustand
    public struct Alarm: Equatable, Sendable, Identifiable {
        public let key: String
        public let label: String
        public let severity: Int
        public var id: String { key }
    }
    public var alarmsConfigured = false
    public var alarmsStale = false
    public var alarms: [Alarm] = []
    public var warnings: [String] = []
    public var emergencyStop: Bool?

    public init() {}

    public static func from(status v: JSONValue) -> StatusDetail? {
        guard v.object != nil else { return nil }
        var d = StatusDetail()
        if let now = v["now"]?.number { d.at = Date(timeIntervalSince1970: now / 1000) }
        d.timeZone = v["timeZone"]?.string
        let vic = v["victron"] ?? .null
        d.pvTotalW = vic["pvTotalW"]?.number
        d.pvDcW = vic["pvPowerW"]?.number
        d.pvAcW = vic["pvAcW"]?.number
        d.pvAcPhasesW = ["acPvL1W", "acPvL2W", "acPvL3W"].map { vic[$0]?.number }
        d.pvAc2PhasesW = ["acPv2L1W", "acPv2L2W", "acPv2L3W"].map { vic[$0]?.number }
        if d.pvAcPhasesW.allSatisfy({ $0 == nil }) { d.pvAcPhasesW = [] }
        if d.pvAc2PhasesW.allSatisfy({ $0 == nil }) { d.pvAc2PhasesW = [] }
        d.soc = vic["soc"]?.number
        d.batteryPowerW = vic["batteryPowerW"]?.number
        d.minSocPct = vic["minSocPct"]?.number
        d.maxDischargeW = vic["maxDischargeW"]?.number
        d.secondSocPct = vic["secondBatterySocPct"]?.number
        if let c = vic["secondBatteryChargeW"]?.number, let dis = vic["secondBatteryDischargeW"]?.number { d.secondBatteryW = c - dis }
        d.gridImportW = vic["gridImportW"]?.number
        d.gridExportW = vic["gridExportW"]?.number
        d.gridSetpointW = vic["gridSetpointW"]?.number
        d.loadW = vic["selfConsumptionW"]?.number
        d.solarDirectUseW = vic["solarDirectUseW"]?.number
        d.solarToBatteryW = vic["solarToBatteryW"]?.number
        d.solarToGridW = vic["solarToGridW"]?.number
        d.gridDirectUseW = vic["gridDirectUseW"]?.number
        d.gridToBatteryW = vic["gridToBatteryW"]?.number
        d.batteryDirectUseW = vic["batteryDirectUseW"]?.number
        d.batteryToGridW = vic["batteryToGridW"]?.number
        let meter = v["meter"] ?? .null
        d.gridTotalW = meter["grid_total_w"]?.number
        d.gridPhasesW = ["grid_l1_w", "grid_l2_w", "grid_l3_w"].map { meter[$0]?.number }
        if d.gridPhasesW.allSatisfy({ $0 == nil }) { d.gridPhasesW = [] }
        d.gridPositiveMeans = meter["semantics"]?["positiveMeans"]?.string
        let active = v["schedule"]?["active"] ?? .null
        d.activeSetpointW = active["gridSetpointW"]?["value"]?.number
        d.activeSetpointSource = active["gridSetpointW"]?["source"]?.string
        d.activeMinSocPct = active["minSocPct"]?["value"]?.number
        let costs = v["costs"] ?? .null
        d.importKwh = costs["importKwh"]?.number
        d.exportKwh = costs["exportKwh"]?.number
        d.costEur = costs["costEur"]?.number
        d.revenueEur = costs["revenueEur"]?.number
        d.netEur = costs["netEur"]?.number
        d.spotNowCtKwh = costs["priceNowCtKwh"]?.number
        d.importPriceNowCtKwh = costs["userImportPriceNowCtKwh"]?.number
        if let c = v["userEnergyPricing"]?["current"]?["importPriceCtKwh"]?.number { d.importPriceNowCtKwh = c }
        d.prices = PriceSeries.from(status: v)
        if let gv = v["gridVoltage"], gv["ok"]?.bool == true {
            d.gridVoltagesV = ["l1", "l2", "l3"].map { gv[$0]?.number }
            d.gridFrequencyHz = gv["frequencyHz"]?.number
        }
        let al = v["victronAlarms"] ?? .null
        d.alarmsConfigured = al["configured"]?.bool ?? false
        d.alarmsStale = al["stale"]?.bool ?? false
        d.alarms = (al["active"]?.array ?? []).compactMap { a in
            guard let label = a["label"]?.string ?? a["key"]?.string else { return nil }
            return Alarm(key: a["key"]?.string ?? label, label: label, severity: Int(a["severity"]?.number ?? 0))
        }
        d.warnings = (v["systemWarnings"]?.array ?? []).compactMap { $0["message"]?.string }
        d.emergencyStop = v["emergencyStop"]?["active"]?.bool
        return d
    }

    /// Phasenleistung des Netzzählers als Bezug (+) / Einspeisung (−). DVhub
    /// kennt zwei Einstellungen (`gridPositiveMeans`): „grid_import“ (positiv =
    /// Bezug) und den Standard „feed_in“ (positiv = Einspeisung) — alles außer
    /// „grid_import“ gilt wie auf der Box als „feed_in“ (server-utils.js gridDirection).
    public func gridPhaseAsImport(_ w: Double) -> Double {
        gridPositiveMeans == "grid_import" ? w : -w
    }
}

// MARK: - Historie (/api/history/summary)

public enum HistoryPeriod: String, CaseIterable, Sendable {
    case day, week, month, year
}

public struct HistoryRow: Equatable, Sendable, Identifiable {
    public let key: String
    public let label: String
    /// Ortsdatum bzw. Zeitpunkt der Zeile (Tag, Monatsanfang, Slot).
    public let date: Date?
    public let values: [String: Double]
    public var id: String { key }
    public func value(_ k: String) -> Double { values[k] ?? 0 }
}

public struct HistorySummary: Equatable, Sendable {
    public let view: HistoryPeriod
    public let date: String
    public let kpis: [String: Double]
    /// Woche/Monat: je Tag; Jahr: je Monat; Tag: je Viertelstunde (aus `charts`).
    public let rows: [HistoryRow]
    /// Tagesansicht: Preise je Viertelstunde (Börse, eigener Bezug).
    public let dayPrices: [HistoryRow]

    public func kpi(_ k: String) -> Double? { kpis[k] }

    /// Bezugskosten wie in der Web-Historie: gridCostEur, sonst importCostEur.
    public var importCostEur: Double { kpis["gridCostEur"] ?? kpis["importCostEur"] ?? 0 }
    public var exportRevenueEur: Double { kpis["exportRevenueEur"] ?? 0 }
    /// Netto wie in der Web-Historie (Feld netEur der Box).
    public var netEur: Double { kpis["netEur"] ?? (exportRevenueEur - importCostEur) }
    /// Autarkie: Anteil des Verbrauchs, der nicht aus dem Netz kam.
    public var autarkyPct: Double? {
        guard let load = kpis["loadKwh"], load > 0 else { return nil }
        let grid = kpis["gridShareKwh"] ?? kpis["importKwh"] ?? 0
        return max(0, min(100, (1 - grid / load) * 100))
    }
    /// Eigenverbrauchsquote: Anteil der PV-Erzeugung, der nicht eingespeist wurde.
    public var selfUsePct: Double? {
        guard let pv = kpis["pvKwh"], pv > 0 else { return nil }
        let toGrid = kpis["solarToGridKwh"] ?? kpis["exportKwh"] ?? 0
        return max(0, min(100, (1 - toGrid / pv) * 100))
    }

    public static func from(_ v: JSONValue, view: HistoryPeriod, date: String) -> HistorySummary? {
        guard v.object != nil, let kp = v["kpis"]?.object else { return nil }
        let kpis = numbers(kp)
        var rows: [HistoryRow] = []
        var prices: [HistoryRow] = []
        if view == .day {
            rows = (v["charts"]?["dayEnergyLines"]?.array ?? []).compactMap { slotRow($0) }
            // Geldwerte je Slot dazu (gleiche ts).
            let fin = Dictionary((v["charts"]?["dayFinancialLines"]?.array ?? []).compactMap { r -> (String, [String: Double])? in
                guard let ts = r["ts"]?.string, let o = r.object else { return nil }
                return (ts, numbers(o))
            }, uniquingKeysWith: { a, _ in a })
            rows = rows.map { r in
                guard let f = fin[r.key] else { return r }
                return HistoryRow(key: r.key, label: r.label, date: r.date, values: r.values.merging(f) { a, _ in a })
            }
            prices = (v["charts"]?["dayPriceLines"]?.array ?? []).compactMap { slotRow($0) }
        } else {
            rows = (v["rows"]?.array ?? []).compactMap { r in
                guard let o = r.object, let key = r["key"]?.string else { return nil }
                return HistoryRow(key: key, label: r["label"]?.string ?? key, date: localDate(key), values: numbers(o))
            }
        }
        return HistorySummary(view: view, date: date, kpis: kpis, rows: rows, dayPrices: prices)
    }

    static func slotRow(_ r: JSONValue) -> HistoryRow? {
        guard let o = r.object, let ts = r["ts"]?.string ?? r["ts"]?.number.map({ String(Int64($0)) }) else { return nil }
        let date = parseISODate(ts) ?? PriceSeries.timestampMs(r["ts"]).map { Date(timeIntervalSince1970: Double($0) / 1000) }
        return HistoryRow(key: ts, label: r["label"]?.string ?? ts, date: date, values: numbers(o))
    }

    static func numbers(_ o: [String: JSONValue]) -> [String: Double] {
        var out: [String: Double] = [:]
        for (k, v) in o { if case .bool = v { continue }; if let d = v.number, v.string == nil { out[k] = d } }
        return out
    }

    /// „2026-11-13“ bzw. „2026-11“ bzw. „2026“ als Ortsdatum (Mitternacht).
    public static func localDate(_ key: String, calendar: Calendar = .current) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard (1...3).contains(parts.count), key.count <= 10 else { return nil }
        var c = DateComponents()
        c.year = parts[0]
        c.month = parts.count > 1 ? parts[1] : 1
        c.day = parts.count > 2 ? parts[2] : 1
        return calendar.date(from: c)
    }

    /// Antwort auf Woche/Monat/Jahr ohne Pro-Lizenz?
    public static func isProRequired(status: Int, body: JSONValue) -> Bool {
        status == 403 && body["error"]?.string == "pro_required"
    }

    /// `date`-Parameter (YYYY-MM-DD) für einen Tag im Kalender der App.
    public static func dateParam(_ d: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    /// Vorheriger/nächster Zeitraum.
    public static func shift(_ d: Date, view: HistoryPeriod, by n: Int, calendar: Calendar = .current) -> Date {
        let comp: Calendar.Component = switch view {
        case .day: .day
        case .week: .weekOfYear
        case .month: .month
        case .year: .year
        }
        return calendar.date(byAdding: comp, value: n, to: d) ?? d
    }
}

// MARK: - Energiemengen je Viertelstunde (Markt: Verlauf unter dem Börsenpreis)

/// Wer im Verlauf vorkommt. Über der Nulllinie als Quelle, darunter als Ziel.
public enum EnergyParty: String, CaseIterable, Sendable {
    case solar, battery, grid, home
}

/// Ein Abschnitt eines gestapelten Balkens in kW (Mittel des Slots):
/// Quellen wachsen von null nach oben, Ziele von null nach unten.
public struct EnergyBar: Equatable, Sendable, Identifiable {
    public let start: Date
    public let end: Date
    public let party: EnergyParty
    public let isSource: Bool
    public let fromKw: Double
    public let toKw: Double
    public var id: String { "\(start.timeIntervalSince1970)-\(party.rawValue)-\(isSource)" }
}

/// Die sieben Energieflüsse eines Slots der Tages-Historie (kWh), dieselben wie
/// im Leitstand (app.js, „Realised energy as stacked bars“). Fürs Handy nach
/// Quelle und Ziel zusammengefasst: Was oben hineingeht, kommt unten heraus.
public struct EnergySlot: Equatable, Sendable, Identifiable {
    public let start: Date
    public let end: Date
    public let solarToHomeKwh: Double
    public let solarToBatteryKwh: Double
    public let solarToGridKwh: Double
    public let batteryToHomeKwh: Double
    public let batteryToGridKwh: Double
    public let gridToHomeKwh: Double
    public let gridToBatteryKwh: Double
    public var id: Date { start }

    public init(start: Date, end: Date, solarToHomeKwh: Double = 0, solarToBatteryKwh: Double = 0, solarToGridKwh: Double = 0,
                batteryToHomeKwh: Double = 0, batteryToGridKwh: Double = 0, gridToHomeKwh: Double = 0, gridToBatteryKwh: Double = 0) {
        self.start = start
        self.end = end
        self.solarToHomeKwh = solarToHomeKwh
        self.solarToBatteryKwh = solarToBatteryKwh
        self.solarToGridKwh = solarToGridKwh
        self.batteryToHomeKwh = batteryToHomeKwh
        self.batteryToGridKwh = batteryToGridKwh
        self.gridToHomeKwh = gridToHomeKwh
        self.gridToBatteryKwh = gridToBatteryKwh
    }

    public func contains(_ d: Date) -> Bool { d >= start && d < end }

    /// Energie, die eine Seite als Quelle abgegeben hat (das Haus gibt nichts ab).
    public func sourceKwh(_ p: EnergyParty) -> Double {
        switch p {
        case .solar: solarToHomeKwh + solarToBatteryKwh + solarToGridKwh
        case .battery: batteryToHomeKwh + batteryToGridKwh
        case .grid: gridToHomeKwh + gridToBatteryKwh
        case .home: 0
        }
    }

    /// Energie, die bei einer Seite angekommen ist (in die PV fließt nichts).
    public func sinkKwh(_ p: EnergyParty) -> Double {
        switch p {
        case .solar: 0
        case .battery: solarToBatteryKwh + gridToBatteryKwh
        case .grid: solarToGridKwh + batteryToGridKwh
        case .home: solarToHomeKwh + batteryToHomeKwh + gridToHomeKwh
        }
    }

    /// kWh im Slot → mittlere Leistung in kW (wie der Leitstand: Viertelstunde × 4).
    public func kw(_ kwh: Double) -> Double {
        let h = end.timeIntervalSince(start) / 3600
        return h > 0 ? kwh / h : 0
    }

    /// Akku netto in kW: + lädt, − entlädt.
    public var batteryNetKw: Double { kw(sinkKwh(.battery) - sourceKwh(.battery)) }
    /// Netz netto in kW: + Bezug, − Einspeisung.
    public var gridNetKw: Double { kw(sourceKwh(.grid) - sinkKwh(.grid)) }

    /// Feste Reihenfolge der Stapel (von der Nulllinie weg).
    public static let sourceOrder: [EnergyParty] = [.solar, .battery, .grid]
    public static let sinkOrder: [EnergyParty] = [.home, .battery, .grid]

    /// Gestapelte Abschnitte dieses Slots; leere Anteile fehlen.
    public var bars: [EnergyBar] {
        var out: [EnergyBar] = []
        var top = 0.0
        for p in Self.sourceOrder {
            let v = kw(sourceKwh(p))
            guard v > 0 else { continue }
            out.append(EnergyBar(start: start, end: end, party: p, isSource: true, fromKw: top, toKw: top + v))
            top += v
        }
        var bottom = 0.0
        for p in Self.sinkOrder {
            let v = kw(sinkKwh(p))
            guard v > 0 else { continue }
            out.append(EnergyBar(start: start, end: end, party: p, isSource: false, fromKw: bottom, toKw: bottom - v))
            bottom -= v
        }
        return out
    }
}

/// Summen über die gezeigten Slots in kWh.
public struct EnergyTotals: Equatable, Sendable {
    public let solarKwh: Double
    public let homeKwh: Double
    public let importKwh: Double
    public let exportKwh: Double
    public let batteryChargeKwh: Double
    public let batteryDischargeKwh: Double
}

public enum EnergyDay {
    /// Die Box bildet die Tages-Historie immer in Viertelstunden
    /// (history-runtime.js, SLOT_BUCKET_SECONDS). Slots ohne Messwerte fehlen
    /// in der Antwort — der Abstand der Zeilen sagt also nichts über die Länge.
    public static let slotSeconds: TimeInterval = 900

    /// Slots eines Tages aus der Tages-Historie. Nur Vergangenes (Beginn vor
    /// `now`) und nur der Bereich `from ..< to`; ohne Zeitstempel fällt die
    /// Zeile weg, fehlende Viertelstunden bleiben Lücken. Ein zweiter Akku
    /// (`second…`-Felder, zusätzlich zu denen des ersten) zählt zum Akku.
    /// Negative oder unlesbare Anteile zählen als null.
    public static func slots(_ s: HistorySummary, from: Date, to: Date, now: Date = Date()) -> [EnergySlot] {
        guard s.view == .day else { return [] }
        let dated = s.rows.compactMap { r in r.date.map { ($0, r) } }.sorted { $0.0 < $1.0 }
        var out: [EnergySlot] = []
        for (d, r) in dated where d >= from && d < to && d < now {
            if let last = out.last, last.start == d { continue }
            func f(_ k: String) -> Double {
                let v = r.values[k] ?? 0
                return v.isFinite && v > 0 ? v : 0
            }
            out.append(EnergySlot(start: d, end: d.addingTimeInterval(slotSeconds),
                                  solarToHomeKwh: f("solarDirectUseKwh"),
                                  solarToBatteryKwh: f("solarToBatteryKwh") + f("secondSolarToBatteryKwh"),
                                  solarToGridKwh: f("solarToGridKwh"),
                                  batteryToHomeKwh: f("batteryDirectUseKwh") + f("secondBatteryDirectUseKwh"),
                                  batteryToGridKwh: f("batteryToGridKwh") + f("secondBatteryToGridKwh"),
                                  gridToHomeKwh: f("gridDirectUseKwh"),
                                  gridToBatteryKwh: f("gridToBatteryKwh") + f("secondGridToBatteryKwh")))
        }
        return out
    }

    /// Hat überhaupt ein Slot einen Fluss? (Leere Historie: nichts zeichnen.)
    public static func hasFlows(_ slots: [EnergySlot]) -> Bool {
        slots.contains { !$0.bars.isEmpty }
    }

    public static func totals(_ slots: [EnergySlot]) -> EnergyTotals {
        func sum(_ f: (EnergySlot) -> Double) -> Double { slots.reduce(0) { $0 + f($1) } }
        return EnergyTotals(solarKwh: sum { $0.sourceKwh(.solar) }, homeKwh: sum { $0.sinkKwh(.home) },
                            importKwh: sum { $0.sourceKwh(.grid) }, exportKwh: sum { $0.sinkKwh(.grid) },
                            batteryChargeKwh: sum { $0.sinkKwh(.battery) }, batteryDischargeKwh: sum { $0.sourceKwh(.battery) })
    }

    /// Größter Ausschlag nach oben und unten in kW — für eine ruhige, feste Achse.
    public static func extentKw(_ slots: [EnergySlot]) -> (down: Double, up: Double) {
        var up = 0.0, down = 0.0
        for s in slots {
            up = max(up, s.kw(EnergySlot.sourceOrder.reduce(0) { $0 + s.sourceKwh($1) }))
            down = max(down, s.kw(EnergySlot.sinkOrder.reduce(0) { $0 + s.sinkKwh($1) }))
        }
        return (down, up)
    }
}

// MARK: - Energiefluss

/// Ein Fluss zwischen zwei Knoten des Energiefluss-Diagramms. Alles läuft über
/// den Mittelpunkt (wie im Leitstand): PV → Mitte, Mitte → Haus, Akku ↔ Mitte,
/// Netz ↔ Mitte.
public struct FlowEdge: Equatable, Sendable {
    public enum Node: String, Sendable, CaseIterable { case pv, battery, grid, home }
    public let node: Node
    /// true: vom Knoten zur Mitte (PV, Entladen, Bezug); false: zur Mitte hin weg (Haus, Laden, Einspeisung).
    public let towardHub: Bool
    public let watts: Double
    /// Woher die Energie auf dieser Strecke stammt, als Anteile (Summe 1):
    /// PV, Akku (Entladen), Netz (Bezug). Die Partikel tragen die Farbe ihrer
    /// Quelle — zum Haus laufen sie gemischt, wie im Web-Leitstand.
    public let sources: [Node: Double]

    public init(node: Node, towardHub: Bool, watts: Double, sources: [Node: Double]? = nil) {
        self.node = node
        self.towardHub = towardHub
        self.watts = watts
        self.sources = sources ?? [node == .home ? .grid : node: 1]
    }

    /// Unter dieser Leistung ruht ein Fluss (Messrauschen).
    public static let idleW: Double = 20
    /// Obergrenze der Partikel je Strecke (Zeichenaufwand auf dem Handy).
    public static let maxParticles = 72

    public var active: Bool { watts >= Self.idleW }

    /// Weg pro Sekunde als Anteil der Strecke. Wie im Web-Leitstand wächst
    /// das Tempo mit der Wurzel der Leistung (0,2 kW treibt, 9 kW strömt) —
    /// für die kurzen Strecken auf dem Handy schneller gestellt.
    public var speed: Double {
        guard active else { return 0 }
        return min(0.6, 0.05 + 0.14 * (watts / 1000).squareRoot())
    }

    /// Anzahl Partikel auf der Strecke (Dichte): wie im Web-Leitstand
    /// proportional zur Leistung (18 je kW), 4 … `maxParticles`.
    public var particleCount: Int {
        guard active else { return 0 }
        return max(4, min(Self.maxParticles, Int((watts / 1000 * 18).rounded())))
    }

    /// Lage des i-ten Partikels (0 … 1, 0 = am Knoten) zur Zeit t.
    public func position(particle i: Int, time t: Double) -> Double {
        let n = max(1, particleCount)
        let p = (t * speed + Double(i) / Double(n)).truncatingRemainder(dividingBy: 1)
        let along = p < 0 ? p + 1 : p
        return towardHub ? along : 1 - along
    }

    /// Quelle eines Partikels: `rank` (0 … 1, je Partikel fest) fällt in die
    /// Anteile der Quellen in der Reihenfolge PV, Akku, Netz.
    public func source(rank: Double) -> Node {
        var edge = 0.0
        let order: [Node] = [.pv, .battery, .grid]
        for n in order {
            edge += sources[n] ?? 0
            if rank < edge { return n }
        }
        return order.last { (sources[$0] ?? 0) > 0 } ?? node
    }

    public static func edges(from s: LiveStatus) -> [FlowEdge] {
        let pv = max(0, s.pvTotalW ?? 0)
        let load = max(0, s.loadW ?? 0)
        let bat = s.batteryPowerW ?? 0
        // Netz netto wie im Web-Leitstand (app.js updateFlowDiagram): Bezug minus Einspeisung.
        let net = max(0, s.gridImportW ?? 0) - max(0, s.gridExportW ?? 0)
        // Quellen in der Mitte: PV, entladender Akku, Netzbezug (netto).
        let batOut = max(0, -bat)
        let gridIn = max(0, net)
        func shares(_ parts: [(Node, Double)]) -> [Node: Double]? {
            let total = parts.reduce(0) { $0 + $1.1 }
            guard total > 0 else { return nil }
            return Dictionary(uniqueKeysWithValues: parts.filter { $0.1 > 0 }.map { ($0.0, $0.1 / total) })
        }
        return [
            FlowEdge(node: .pv, towardHub: true, watts: pv),
            FlowEdge(node: .home, towardHub: false, watts: load, sources: shares([(.pv, pv), (.battery, batOut), (.grid, gridIn)])),
            // + = Laden: Energie fließt von der Mitte in den Akku — aus PV und Netz.
            FlowEdge(node: .battery, towardHub: bat < 0, watts: abs(bat), sources: bat > 0 ? shares([(.pv, pv), (.grid, gridIn)]) : nil),
            // Einspeisung kommt aus PV und Akku.
            FlowEdge(node: .grid, towardHub: net >= 0, watts: abs(net), sources: net >= 0 ? nil : shares([(.pv, pv), (.battery, batOut)])),
        ]
    }
}
