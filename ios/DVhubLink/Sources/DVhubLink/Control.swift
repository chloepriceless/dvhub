// Control.swift — Bedienen aus der App: Zeitplan-Regeln, E-Auto, Tarif-Spanne
// und Tagesenergie. Reine Auswertung und der Aufbau der Anfragen — hier im
// Paket, damit `swift test` alles ohne Simulator prüft.
//
// Quellen (Node-Code ist die Referenz):
//   GET/POST /api/schedule…  → dvhub/routes-api.js, schedule-runtime.js
//   GET/POST /api/ev         → dvhub/routes-api.js, services/optimizer/ev-departure.js
//   userEnergyPricing.slots  → dvhub/user-energy-pricing.js slotComparison()

import Foundation

// MARK: - Zeitplan

/// Eine Regel des Zeitplans, wie `/api/schedule` sie liefert.
public struct ScheduleRule: Equatable, Sendable, Identifiable {
    /// Die Regel, wie die Box sie hält — unbekannte Felder bleiben beim Speichern erhalten.
    public let raw: JSONValue
    public let index: Int
    public let ruleId: String?
    public let enabled: Bool
    public let target: String
    public let start: String
    public let end: String
    public let value: Double?
    public let stopSocPct: Double?
    public let source: String?
    /// Vom Optimierer oder der Börsenautomatik erzeugt: Die Box verwaltet sie selbst.
    public let isAutomation: Bool

    public var id: String { ruleId.map { "\($0)#\(index)" } ?? "#\(index)" }

    /// In der App anleg- und änderbar: Netz-Sollwert und Ladestrom, von Hand angelegt.
    public var isEditable: Bool { !isAutomation && ScheduleEdit.editableTargets.contains(target) }
    /// Umschalten geht für jede Regel mit Kennung (auch Plan-Regeln, wie in der Weboberfläche).
    public var canToggle: Bool { ruleId != nil }
}

public enum ScheduleEdit {
    public static let editableTargets = ["gridSetpointW", "chargeCurrentA"]
    /// Grenzen wie auf der Box (server-utils.js controlWriteBoundsError).
    public static let maxGridSetpointW = 100_000.0
    public static let maxChargeCurrentA = 1000.0

    /// Wie die Box: Quelle oder Kennungs-Vorsatz (market-automation-builder.js, schedule-builder.js).
    public static func isAutomation(_ rule: JSONValue) -> Bool {
        let source = rule["source"]?.string
        let id = rule["id"]?.string ?? ""
        return source == "small_market_automation" || source == "forecast_optimizer" || id.hasPrefix("sma-") || id.hasPrefix("opt-")
    }

    public static func rules(from schedule: JSONValue) -> [ScheduleRule] {
        (schedule["rules"]?.array ?? []).enumerated().compactMap { i, r in
            guard r.object != nil, let target = r["target"]?.string else { return nil }
            return ScheduleRule(raw: r, index: i, ruleId: r["id"]?.string.flatMap { $0.isEmpty ? nil : $0 },
                                enabled: r["enabled"]?.bool != false, target: target,
                                start: r["start"]?.string ?? "", end: r["end"]?.string ?? "",
                                value: r["value"]?.number, stopSocPct: r["stopSocPct"]?.number,
                                source: r["source"]?.string, isAutomation: isAutomation(r))
        }
    }

    /// Eingaben einer Regel, bevor sie zur Box gehen.
    public struct Draft: Equatable, Sendable {
        public var target: String
        public var start: String
        public var end: String
        public var value: Double
        /// Nur beim Netz-Sollwert: Die Regel endet, sobald der Akku diesen Stand erreicht.
        public var stopSocPct: Double?
        public var enabled: Bool

        public init(target: String, start: String, end: String, value: Double, stopSocPct: Double? = nil, enabled: Bool = true) {
            self.target = target; self.start = start; self.end = end; self.value = value
            self.stopSocPct = stopSocPct; self.enabled = enabled
        }
    }

    public enum Problem: Error, Equatable, Sendable {
        case badTime, sameTime, badTarget, valueOutOfRange(max: Double), badStopSoc
        /// Die Regel steht auf der Box inzwischen anders (oder ist weg).
        case changedMeanwhile
        case notEditable

        public var message: String {
            switch self {
            case .badTime: return L("Bitte Beginn und Ende als Uhrzeit angeben.")
            case .sameTime: return L("Beginn und Ende dürfen nicht gleich sein.")
            case .badTarget: return L("Diese Art von Regel lässt sich in der App nicht anlegen.")
            case .valueOutOfRange(let max): return L("Der Wert liegt außerhalb des erlaubten Bereichs (höchstens \(Int(max))).")
            case .badStopSoc: return L("Der Ladestand muss zwischen 0 und 100 % liegen.")
            case .changedMeanwhile: return L("Der Zeitplan hat sich inzwischen geändert. Bitte neu laden und noch einmal versuchen.")
            case .notEditable: return L("Diese Regel verwaltet DVhub selbst. In der App lässt sie sich nur ein- und ausschalten.")
            }
        }
    }

    /// „7:5“ → „07:05“; alles andere nil. Wie parseHHMM auf der Box (00:00 … 23:59).
    public static func normalizeTime(_ s: String) -> String? {
        let parts = s.trimmingCharacters(in: .whitespaces).split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts.allSatisfy({ !$0.isEmpty && $0.count <= 2 && $0.allSatisfy(\.isNumber) }),
              let h = Int(parts[0]), let m = Int(parts[1]), (0...23).contains(h), (0...59).contains(m) else { return nil }
        return String(format: "%02d:%02d", h, m)
    }

    public static func validate(_ d: Draft) -> Problem? {
        guard editableTargets.contains(d.target) else { return .badTarget }
        guard let s = normalizeTime(d.start), let e = normalizeTime(d.end) else { return .badTime }
        if s == e { return .sameTime }
        guard d.value.isFinite else { return .valueOutOfRange(max: d.target == "gridSetpointW" ? maxGridSetpointW : maxChargeCurrentA) }
        if d.target == "gridSetpointW", abs(d.value) > maxGridSetpointW { return .valueOutOfRange(max: maxGridSetpointW) }
        if d.target == "chargeCurrentA", d.value < 0 || d.value > maxChargeCurrentA { return .valueOutOfRange(max: maxChargeCurrentA) }
        if let stop = d.stopSocPct {
            guard d.target == "gridSetpointW", stop.isFinite, (0...100).contains(stop) else { return .badStopSoc }
        }
        return nil
    }

    /// Der Stopp-Stand ist auf der Box eine Untergrenze: Die Regel schaltet ab,
    /// sobald der Akku UNTER ihn fällt (schedule-runtime.js). Sinnvoll ist er
    /// beim Einspeisen und bei 0 W (der Akku deckt das Haus) — dort bietet die
    /// App ihn an. Beim Beziehen nicht: Er würde das Laden beenden, solange der
    /// Akku leer ist. Trägt eine Regel dort trotzdem einen (aus der
    /// Weboberfläche, oder weil man eine Einspeise-Regel umstellt), bleibt der
    /// Schalter sichtbar — mit Warnung und abschaltbar. Gespeichert wird immer
    /// genau, was der Schalter zeigt: kein Stopp-Stand geht unsichtbar mit.
    public static func offersStop(signedValue: Double, hasStop: Bool) -> Bool { signedValue <= 0 || hasStop }

    /// Der gewählte Stopp-Stand passt nicht zur Richtung (Beziehen): warnen.
    public static func stopNeedsWarning(signedValue: Double, hasStop: Bool) -> Bool { signedValue > 0 && hasStop }

    public enum Change: Equatable, Sendable {
        case add(Draft)
        case update(ScheduleRule, Draft)
        case remove(ScheduleRule)
    }

    /// Laufzeit-Markierungen der Box (`_wasActive` …) gehen nicht zurück — die Weboberfläche schickt sie auch nicht.
    static func clean(_ rule: JSONValue) -> JSONValue {
        guard let o = rule.object else { return rule }
        return .object(o.filter { !$0.key.hasPrefix("_") })
    }

    /// Körper für `POST /api/schedule/rules`. Der Endpunkt ersetzt ALLE Regeln
    /// von Hand — deshalb: frisch geladenen Stand (`schedule`) nehmen, genau
    /// eine Regel ändern, alle anderen unverändert zurückschicken. Plan-Regeln
    /// behält die Box selbst. Steht die zu ändernde Regel dort inzwischen
    /// anders, wird nichts geschickt (`changedMeanwhile`).
    public static func payload(schedule: JSONValue, change: Change, newId: () -> String = { "app-" + UUID().uuidString.prefix(8).lowercased() }) -> Result<JSONValue, Problem> {
        var manual = (schedule["rules"]?.array ?? []).filter { $0.object != nil && !isAutomation($0) }.map(clean)

        func locate(_ rule: ScheduleRule) -> Result<Int, Problem> {
            guard !rule.isAutomation else { return .failure(.notEditable) }
            guard let i = manual.firstIndex(of: clean(rule.raw)) else { return .failure(.changedMeanwhile) }
            return .success(i)
        }
        func fields(_ d: Draft, into base: [String: JSONValue]) -> Result<JSONValue, Problem> {
            if let p = validate(d) { return .failure(p) }
            var o = base
            o["target"] = .string(d.target)
            o["start"] = .string(normalizeTime(d.start) ?? d.start)
            o["end"] = .string(normalizeTime(d.end) ?? d.end)
            o["value"] = .double(d.value)
            o["enabled"] = .bool(d.enabled)
            if let stop = d.stopSocPct { o["stopSocPct"] = .double(stop) } else { o.removeValue(forKey: "stopSocPct") }
            return .success(.object(o))
        }

        switch change {
        case .add(let d):
            switch fields(d, into: ["id": .string(newId()), "source": .string("manual")]) {
            case .failure(let p): return .failure(p)
            case .success(let r): manual.append(r)
            }
        case .update(let rule, let d):
            guard rule.isEditable else { return .failure(.notEditable) }
            switch locate(rule) {
            case .failure(let p): return .failure(p)
            case .success(let i):
                switch fields(d, into: manual[i].object ?? [:]) {
                case .failure(let p): return .failure(p)
                case .success(let r): manual[i] = r
                }
            }
        case .remove(let rule):
            guard rule.isEditable else { return .failure(.notEditable) }
            switch locate(rule) {
            case .failure(let p): return .failure(p)
            case .success(let i): manual.remove(at: i)
            }
        }
        return .success(["rules": .array(manual)])
    }
}

/// Antwort der Box auf eine Schreibanfrage (Zeitplan, E-Auto) in Worten.
public enum WriteOutcome: Equatable, Sendable {
    case done
    case proRequired
    case notAllowed
    case busy
    case invalid(String?)
    case failed(status: Int, error: String?)

    public static func from(_ r: LinkResponse) -> WriteOutcome {
        let error = r.body["error"]?.string
        switch r.status {
        case 200...299: return r.body["ok"]?.bool == false ? .failed(status: r.status, error: error) : .done
        case 400: return .invalid(error)
        case 403: return error == "pro_required" ? .proRequired : .notAllowed
        case 429: return .busy
        default: return .failed(status: r.status, error: error)
        }
    }

    public var ok: Bool { self == .done }

    public var message: String {
        switch self {
        case .done: return L("Gespeichert.")
        case .proRequired: return L("Dafür braucht DVhub eine Pro-Lizenz.")
        case .notAllowed: return L("Dieses Gerät darf das nicht. Die Freigabe „Steuern“ vergibst du in DVhub unter „Handy-App“.")
        case .busy: return L("Gerade zu viele Anfragen. Bitte gleich noch einmal.")
        case .invalid(let e):
            let text = e ?? L("unbekannt")
            return L("Die Anlage nimmt die Eingabe nicht an: \(text).")
        case .failed(let status, let e):
            let text = e ?? "HTTP \(status)"
            return L("Die Anlage meldet einen Fehler: \(text).")
        }
    }
}

// MARK: - E-Auto

/// Stand der E-Auto-Planung aus `GET /api/ev` — nur die Felder, die die App zeigt oder ändert.
public struct EVState: Equatable, Sendable {
    public struct Vehicle: Equatable, Sendable {
        public var title: String?
        public var socPct: Double?
        public var rangeKm: Double?
        public var connected: Bool?
        public var charging: Bool?
        public var chargePowerW: Double?
        public var plugged: Bool?
    }

    /// Eine Zeile des Wochenplans (Zeile = Abfahrtstag, 1 = Montag … 7 = Sonntag).
    public struct WeekRow: Equatable, Sendable, Identifiable {
        public let raw: JSONValue
        public let index: Int
        public let day: Int
        /// „HH:MM“ oder leer (an dem Tag keine Abfahrt).
        public var departure: String
        public var minSocPct: Double?
        /// Verbrauch der Fahrt ab dieser Abfahrt in % des Akkus.
        public var tripSocPct: Double? = nil
        /// „Zuhause ab“: ab wann das Auto vor dieser Abfahrt wieder da ist („HH:MM“ oder leer).
        public var homeFrom: String = ""
        /// „Zuhause ab“ liegt am Vortag der Abfahrt.
        public var homeFromPrevDay: Bool = false
        public var id: Int { index }
    }

    /// „Sofort laden“ bzw. „Laden stoppen“ läuft.
    public struct Override: Equatable, Sendable {
        public let stop: Bool
        public let powerW: Double?
        public let until: Date?
    }

    /// Leistung, die „Sofort laden“ annehmen kann (die Box begrenzt selbst darauf).
    public struct OverrideLimits: Equatable, Sendable {
        public let minPowerW: Double
        public let maxPowerW: Double
    }

    public var optimizeEv = false
    public var onlyWhenPlugged = true
    public var chargerConfigured = false
    public var vehicle = Vehicle()
    public var departureEnabled = false
    /// Allgemeiner Mindest-Ladestand bis zur Abfahrt in %.
    public var defaultMinSocPct: Double?
    /// Ladestand „wenn günstig“; nil = aus.
    public var maxSocPct: Double?
    public var once: Date?
    public var onceMinSocPct: Double?
    public var nextDeparture: Date?
    public var nextTargetSocPct: Double?
    /// „once“ oder „weekly“.
    public var nextSource: String?
    public var week: [WeekRow] = []
    public var planEnergyKwh: Double?
    public var planSocAtDeparture: Double?
    public var planError: String?
    public var override: Override?
    public var overrideLimits: OverrideLimits?
    public var lastCommandError: String?

    public init() {}

    public static func from(_ v: JSONValue) -> EVState? {
        guard v.object != nil, v["ok"]?.bool != false else { return nil }
        var s = EVState()
        s.optimizeEv = v["optimizeEv"]?.bool == true
        s.onlyWhenPlugged = v["onlyWhenPlugged"]?.bool != false
        s.chargerConfigured = v["chargerConfigured"]?.bool == true
        let veh = v["vehicle"] ?? .null
        s.vehicle = Vehicle(title: veh["title"]?.string, socPct: veh["socPct"]?.number, rangeKm: veh["rangeKm"]?.number,
                            connected: veh["connected"]?.bool, charging: veh["charging"]?.bool,
                            chargePowerW: veh["chargePowerW"]?.number, plugged: veh["plugged"]?.bool)
        let dep = v["departure"] ?? .null
        s.departureEnabled = dep["enabled"]?.bool == true
        s.defaultMinSocPct = dep["defaultMinSocPct"]?.number
        s.maxSocPct = dep["maxSocPct"]?.number
        s.once = dep["once"]?.string.flatMap { $0.isEmpty ? nil : parseISODate($0) }
        s.onceMinSocPct = dep["onceMinSocPct"]?.number
        let resolved = dep["resolved"] ?? .null
        s.nextDeparture = resolved["departureAt"]?.string.flatMap(parseISODate)
        s.nextTargetSocPct = resolved["targetSocPct"]?.number
        s.nextSource = resolved["source"]?.string
        s.week = (dep["weeklyDepartures"]?.array ?? []).enumerated().compactMap { i, r in
            guard let day = r["day"]?.number, (1...7).contains(Int(day)) else { return nil }
            return WeekRow(raw: r, index: i, day: Int(day), departure: r["departure"]?.string ?? "", minSocPct: r["minSocPct"]?.number,
                           tripSocPct: r["tripSocPct"]?.number, homeFrom: r["homeFrom"]?.string ?? "", homeFromPrevDay: r["homeFromPrevDay"]?.bool == true)
        }
        let plan = v["plan"] ?? .null
        if plan["hasEv"]?.bool == true {
            s.planEnergyKwh = plan["energyKwh"]?.number
            s.planSocAtDeparture = plan["socAtDeparture"]?.number
        }
        s.planError = v["planError"]?.string
        if let o = v["override"], o.object != nil {
            s.override = Override(stop: o["kind"]?.string == "stop", powerW: o["powerW"]?.number, until: o["until"]?.string.flatMap(parseISODate))
        }
        if let lo = v["overrideLimits"]?["minPowerW"]?.number, let hi = v["overrideLimits"]?["maxPowerW"]?.number, lo > 0, hi >= lo {
            s.overrideLimits = OverrideLimits(minPowerW: lo, maxPowerW: hi)
        }
        s.lastCommandError = v["lastCommandError"]?.string
        return s
    }
}

/// Körper für `POST /api/ev`. Die Box übernimmt nur die Felder, die im Körper stehen.
public enum EVEdit {
    public static func optimize(_ on: Bool) -> JSONValue { ["optimizeEv": .bool(on)] }
    public static func onlyWhenPlugged(_ on: Bool) -> JSONValue { ["onlyWhenPlugged": .bool(on)] }
    public static func departurePlanning(_ on: Bool) -> JSONValue { ["departure": ["enabled": .bool(on)]] }

    /// Allgemeiner Mindest-Ladestand in % (10 … 100).
    public static func minSoc(_ pct: Double) -> JSONValue? {
        guard pct.isFinite, (10...100).contains(pct) else { return nil }
        return ["departure": ["targetMode": "percent", "targetValue": .double(pct.rounded())]]
    }

    /// Ladestand „wenn günstig“ (10 … 100), nil schaltet ihn aus.
    public static func maxSoc(_ pct: Double?) -> JSONValue? {
        guard let pct else { return ["departure": ["maxSocPct": .null]] }
        guard pct.isFinite, (10...100).contains(pct) else { return nil }
        return ["departure": ["maxSocPct": .double(pct.rounded())]]
    }

    /// Einmal-Ziel „y % bis x Uhr“. Die Box verlangt den Termin mehr als ihren
    /// Vorlauf in der Zukunft; hier nur die grobe Prüfung (Zukunft, 0 … 100 %).
    public static func once(at date: Date, minSocPct: Double, now: Date = Date()) -> JSONValue? {
        guard date > now, minSocPct.isFinite, (0...100).contains(minSocPct) else { return nil }
        return ["departure": ["once": .string(isoString(date)), "onceMinSocPct": .double(minSocPct.rounded())]]
    }

    public static func clearOnce() -> JSONValue { ["departure": ["once": "", "onceMinSocPct": .null]] }

    // MARK: Wochenplan

    /// Höchstzahl der Abfahrten in der Woche (ev-departure.js MAX_WEEKLY_DEPARTURES).
    public static let maxWeeklyDepartures = 14

    /// Eingaben einer Abfahrt im Wochenplan.
    public struct WeekDraft: Equatable, Sendable {
        /// 1 = Montag … 7 = Sonntag (zählt beim Anlegen; eine bestehende Zeile behält ihren Tag).
        public var day: Int
        public var departure: String
        /// Eigenes Mindestziel für diese Abfahrt; nil = das allgemeine.
        public var minSocPct: Double?
        /// Verbrauch der Fahrt in % des Akkus; nil = keine Angabe.
        public var tripSocPct: Double?
        /// „Zuhause ab“ („HH:MM“) oder leer.
        public var homeFrom: String
        /// nil = die Box entscheidet nach der Uhrzeit (nicht vor der Abfahrt → Vortag).
        public var homeFromPrevDay: Bool?

        public init(day: Int, departure: String, minSocPct: Double? = nil, tripSocPct: Double? = nil, homeFrom: String = "", homeFromPrevDay: Bool? = nil) {
            self.day = day; self.departure = departure; self.minSocPct = minSocPct; self.tripSocPct = tripSocPct
            self.homeFrom = homeFrom; self.homeFromPrevDay = homeFromPrevDay
        }
    }

    public enum WeekChange: Equatable, Sendable {
        case add(WeekDraft)
        case update(index: Int, WeekDraft)
        /// Abfahrt löschen; die letzte eines Tages hinterlässt den Tag ohne Abfahrt.
        case remove(index: Int)
    }

    public enum WeekProblem: Error, Equatable, Sendable {
        case badDay, badTime, homeNotBeforeDeparture, badPercent, tooMany, unknownRow

        public var message: String {
            switch self {
            case .badDay: return L("Bitte einen Wochentag wählen.")
            case .badTime: return L("Bitte die Uhrzeiten vollständig angeben.")
            case .homeNotBeforeDeparture: return L("„Zuhause ab“ muss vor der Abfahrt liegen – oder am Vortag.")
            case .badPercent: return L("Der Ladestand muss zwischen 0 und 100 % liegen.")
            case .tooMany: return L("Mehr als \(EVEdit.maxWeeklyDepartures) Abfahrten in der Woche gehen nicht.")
            case .unknownRow: return L("Der Wochenplan hat sich inzwischen geändert. Bitte noch einmal ansehen und dann speichern.")
            }
        }
    }

    static func minutes(_ hhmm: String) -> Int? {
        guard let t = ScheduleEdit.normalizeTime(hhmm) else { return nil }
        let p = t.split(separator: ":").compactMap { Int($0) }
        return p[0] * 60 + p[1]
    }

    /// Wie die Box (defaultHomeFromPrevDay): „Zuhause ab“ nicht vor der Abfahrt → am Vortag.
    public static func defaultHomeFromPrevDay(homeFrom: String, departure: String) -> Bool {
        guard let h = minutes(homeFrom) else { return false }
        guard let d = minutes(departure) else { return true }
        return h >= d
    }

    /// Körper für `POST /api/ev` mit dem ganzen Wochenplan und genau einer
    /// Änderung. `rows` ist der frisch von der Box gelesene Plan; alle anderen
    /// Zeilen gehen unverändert zurück, unveränderte Zahlen der geänderten Zeile
    /// auch (kein Runden nebenbei). Geprüft wird wie auf der Box
    /// (ev-departure.js parseWeeklyDepartures) — sie prüft trotzdem selbst.
    public static func weekPlan(_ rows: [EVState.WeekRow], change: WeekChange) -> Result<JSONValue, WeekProblem> {
        func pctOK(_ v: Double?) -> Bool { v.map { $0.isFinite && (0...100).contains($0) } ?? true }
        func empty(_ day: Int) -> JSONValue {
            ["day": .int(Int64(day)), "departure": "", "homeFrom": "", "homeFromPrevDay": false, "minSocPct": .null, "tripSocPct": .null]
        }
        /// Felder des Entwurfs in eine Zeile schreiben (`base` trägt, was die Box sonst noch hält).
        func fill(_ d: WeekDraft, day: Int, base: [String: JSONValue], old: EVState.WeekRow?) -> Result<JSONValue, WeekProblem> {
            guard (1...7).contains(day) else { return .failure(.badDay) }
            guard let dep = ScheduleEdit.normalizeTime(d.departure) else { return .failure(.badTime) }
            let home = d.homeFrom.trimmingCharacters(in: .whitespaces)
            var homeTime = ""
            var prevDay = false
            if !home.isEmpty {
                guard let h = ScheduleEdit.normalizeTime(home) else { return .failure(.badTime) }
                homeTime = h
                prevDay = d.homeFromPrevDay ?? defaultHomeFromPrevDay(homeFrom: h, departure: dep)
                if !prevDay, (minutes(h) ?? 0) >= (minutes(dep) ?? 0) { return .failure(.homeNotBeforeDeparture) }
            }
            guard pctOK(d.minSocPct), pctOK(d.tripSocPct) else { return .failure(.badPercent) }
            var o = base
            o["day"] = .int(Int64(day))
            o["departure"] = .string(dep)
            o["homeFrom"] = .string(homeTime)
            o["homeFromPrevDay"] = .bool(prevDay)
            if old == nil || d.minSocPct != old?.minSocPct { o["minSocPct"] = d.minSocPct.map { .double($0.rounded()) } ?? .null }
            if old == nil || d.tripSocPct != old?.tripSocPct { o["tripSocPct"] = d.tripSocPct.map { .double($0.rounded()) } ?? .null }
            return .success(.object(o))
        }

        var list = rows.map(\.raw)
        switch change {
        case .add(let d):
            guard rows.filter({ !$0.departure.isEmpty }).count < maxWeeklyDepartures else { return .failure(.tooMany) }
            switch fill(d, day: d.day, base: [:], old: nil) {
            case .failure(let p): return .failure(p)
            case .success(let row):
                // Die leere Zeile des Tages ersetzen, sonst anhängen (die Box ordnet nach Tag und Uhrzeit).
                if let i = rows.firstIndex(where: { $0.day == d.day && $0.departure.isEmpty }) { list[i] = row } else { list.append(row) }
            }
        case .update(let index, let d):
            guard let i = rows.firstIndex(where: { $0.index == index }) else { return .failure(.unknownRow) }
            if rows[i].departure.isEmpty, rows.filter({ !$0.departure.isEmpty }).count >= maxWeeklyDepartures { return .failure(.tooMany) }
            switch fill(d, day: rows[i].day, base: rows[i].raw.object ?? [:], old: rows[i]) {
            case .failure(let p): return .failure(p)
            case .success(let row): list[i] = row
            }
        case .remove(let index):
            guard let i = rows.firstIndex(where: { $0.index == index }) else { return .failure(.unknownRow) }
            let day = rows[i].day
            if rows.contains(where: { $0.day == day && $0.index != index }) { list.remove(at: i) } else { list[i] = empty(day) }
        }
        return .success(["departure": ["weeklyDepartures": .array(list)]])
    }

    // MARK: Sofort laden

    /// Körper für `POST /api/ev/override`: jetzt mit `powerW` laden, egal was
    /// EOS plant. `durationMin` nil = bis zum Abstecken oder Beenden; sonst
    /// höchstens 48 h (wie die Box). Die Leistung begrenzt die Box selbst auf
    /// das, was die Wallbox kann.
    public static func chargeNow(powerW: Double, durationMin: Int?) -> JSONValue? {
        guard powerW.isFinite, powerW > 0, powerW <= 100_000 else { return nil }
        var body: [String: JSONValue] = ["kind": "charge", "powerW": .int(Int64(powerW.rounded()))]
        if let durationMin {
            guard (1...(48 * 60)).contains(durationMin) else { return nil }
            body["durationMin"] = .int(Int64(durationMin))
        }
        return .object(body)
    }

    /// „Laden stoppen“: Die Wallbox lädt nicht, egal was EOS plant.
    public static func stopCharging(durationMin: Int?) -> JSONValue? {
        var body: [String: JSONValue] = ["kind": "stop"]
        if let durationMin {
            guard (1...(48 * 60)).contains(durationMin) else { return nil }
            body["durationMin"] = .int(Int64(durationMin))
        }
        return .object(body)
    }

    /// Mehrere Änderungen in einem Körper (eine Anfrage, eine Bestätigung):
    /// oberste Ebene und `departure` werden zusammengelegt, spätere Werte gewinnen.
    public static func merge(_ bodies: [JSONValue]) -> JSONValue {
        var top: [String: JSONValue] = [:]
        var departure: [String: JSONValue] = [:]
        for b in bodies {
            for (k, v) in b.object ?? [:] {
                if k == "departure" { departure.merge(v.object ?? [:]) { _, new in new } } else { top[k] = v }
            }
        }
        if !departure.isEmpty { top["departure"] = .object(departure) }
        return .object(top)
    }

    static func isoString(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: d)
    }
}

// MARK: - Tarif: Einspeisung gegen Bezug

/// Eine Viertelstunde (oder Stunde) mit beiden Preisen.
public struct TariffPoint: Equatable, Sendable, Identifiable {
    public let start: Date
    public let end: Date
    /// Was die Einspeisung bringt: der Börsenpreis (so rechnet DVhub die Erlöse).
    public let exportCt: Double
    /// Was der Bezug kostet: der eigene Tarif brutto, falls in DVhub eingerichtet.
    public let importCt: Double?
    public var id: Date { start }
    public var spreadCt: Double? { importCt.map { $0 - exportCt } }
    public func contains(_ d: Date) -> Bool { d >= start && d < end }
}

public struct TariffStats: Equatable, Sendable {
    public let meanExportCt: Double
    public let meanImportCt: Double
    public let meanSpreadCt: Double
    public let minSpread: TariffPoint
    public let maxSpread: TariffPoint
}

public enum Tariff {
    /// Börsenpreise eines Tages mit dem Bezugspreis der Box je Slot. Die Box
    /// kann in einem anderen Raster liefern (Stunden statt Viertelstunden):
    /// Es zählt der Box-Slot, in dem der Beginn liegt.
    public static func points(market: [PricePoint], box: [PricePoint]) -> [TariffPoint] {
        let withImport = box.filter { $0.importCtKwh != nil }.sorted { $0.start < $1.start }
        return market.map { m in
            let hit = withImport.last { $0.start <= m.start && m.start < $0.end }
            return TariffPoint(start: m.start, end: m.end, exportCt: m.ctKwh, importCt: hit?.importCtKwh ?? m.importCtKwh)
        }
    }

    /// Zeitgewichtete Mittel über die Slots mit Bezugspreis; ohne solche nil.
    public static func stats(_ points: [TariffPoint]) -> TariffStats? {
        let both = points.filter { $0.importCt != nil }
        guard let lo = both.min(by: { ($0.spreadCt ?? 0) < ($1.spreadCt ?? 0) }),
              let hi = both.max(by: { ($0.spreadCt ?? 0) < ($1.spreadCt ?? 0) }) else { return nil }
        let weight = both.reduce(0.0) { $0 + $1.end.timeIntervalSince($1.start) }
        guard weight > 0 else { return nil }
        let exp = both.reduce(0.0) { $0 + $1.exportCt * $1.end.timeIntervalSince($1.start) } / weight
        let imp = both.reduce(0.0) { $0 + ($1.importCt ?? 0) * $1.end.timeIntervalSince($1.start) } / weight
        return TariffStats(meanExportCt: exp, meanImportCt: imp, meanSpreadCt: imp - exp, minSpread: lo, maxSpread: hi)
    }
}

// MARK: - Tagesenergie aus Leistungsreihen

/// Energie und Spitze eines Tages aus einer Leistungsreihe (W, 5-Minuten-Mittel).
public struct DayEnergy: Equatable, Sendable {
    public let kwh: Double
    public let peakW: Double
    public let peakAt: Date

    /// Je Messpunkt gilt sein Wert bis zum nächsten — höchstens `maxGap`
    /// Sekunden (eine Lücke im Verlauf zählt nicht als durchgehende Leistung).
    /// Der letzte Punkt zählt mit dem typischen Abstand. Negative Werte zählen nicht.
    public static func from(_ samples: [(date: Date, watts: Double)], maxGap: TimeInterval = 1800) -> DayEnergy? {
        let pts = samples.filter { $0.watts.isFinite }.sorted { $0.date < $1.date }
        guard let first = pts.first else { return nil }
        var gaps: [TimeInterval] = []
        for i in 1..<max(1, pts.count) { gaps.append(pts[i].date.timeIntervalSince(pts[i - 1].date)) }
        let typical = gaps.filter { $0 > 0 }.sorted().first.map { min($0, maxGap) } ?? 300
        var wh = 0.0
        var peak = (w: max(0, first.watts), at: first.date)
        for (i, p) in pts.enumerated() {
            let w = max(0, p.watts)
            let dt = i + 1 < pts.count ? min(maxGap, pts[i + 1].date.timeIntervalSince(p.date)) : typical
            wh += w * max(0, dt) / 3600
            if w > peak.w { peak = (w, p.date) }
        }
        return DayEnergy(kwh: wh / 1000, peakW: peak.w, peakAt: peak.at)
    }
}
