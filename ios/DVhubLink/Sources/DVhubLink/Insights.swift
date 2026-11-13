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

    /// Unter dieser Leistung ruht ein Fluss (Messrauschen).
    public static let idleW: Double = 20

    public var active: Bool { watts >= Self.idleW }

    /// Weg pro Sekunde als Anteil der Strecke: wächst logarithmisch mit der
    /// Leistung (50 W kriecht, 10 kW eilt), damit kleine Flüsse sichtbar bleiben.
    public var speed: Double {
        guard active else { return 0 }
        return min(1.6, 0.18 + 0.32 * log10(1 + watts / 100))
    }

    /// Anzahl Partikel auf der Strecke (Dichte), 2 … 14.
    public var particleCount: Int {
        guard active else { return 0 }
        return max(2, min(14, Int((2 + 3 * log2(1 + watts / 500)).rounded())))
    }

    /// Lage des i-ten Partikels (0 … 1, 0 = am Knoten) zur Zeit t.
    public func position(particle i: Int, time t: Double) -> Double {
        let n = max(1, particleCount)
        let p = (t * speed + Double(i) / Double(n)).truncatingRemainder(dividingBy: 1)
        let along = p < 0 ? p + 1 : p
        return towardHub ? along : 1 - along
    }

    public static func edges(from s: LiveStatus) -> [FlowEdge] {
        let pv = max(0, s.pvTotalW ?? 0)
        let load = max(0, s.loadW ?? 0)
        let bat = s.batteryPowerW ?? 0
        let imp = max(0, s.gridImportW ?? 0), exp = max(0, s.gridExportW ?? 0)
        return [
            FlowEdge(node: .pv, towardHub: true, watts: pv),
            FlowEdge(node: .home, towardHub: false, watts: load),
            // + = Laden: Energie fließt von der Mitte in den Akku.
            FlowEdge(node: .battery, towardHub: bat < 0, watts: abs(bat)),
            FlowEdge(node: .grid, towardHub: imp >= exp, watts: max(imp, exp)),
        ]
    }
}
