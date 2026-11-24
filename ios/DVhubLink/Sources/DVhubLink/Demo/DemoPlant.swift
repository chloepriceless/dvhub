// DemoPlant.swift — die Beispielanlage der Demo: Victron mit 20 kWp
// Photovoltaik, 20 kWh Akku, Wallbox und dynamischem Tarif.
//
// Zwei Teile:
//   • der Lauf der Anlage — je Tag in Viertelstunden gerechnet, allein aus der
//     Zeit (DemoWorld). Er ist für Leitstand, Historie, Fahrplan und Widgets
//     derselbe; ein vergangener Tag ändert sich nie mehr,
//   • der Zustand, den man in der Demo bedient (`State`): Not-Halt, Zeitplan,
//     Börsenautomatik, E-Auto. Er wirkt auf die Anzeige von jetzt an.
// Die Antworten im Format der Box stehen in DemoPlant+API.swift.
//
// Hier gibt es keine Netzverbindung und keinen Zufall.

import Foundation

public struct DemoPlant: Sendable {
    /// Kennung der Demo-Anlage. Echte Kennungen sind 22 Zeichen lang (keyId) — eine Verwechslung ist ausgeschlossen.
    public static let boxId = "demo"
    /// DVhub-Stand, den die Demo-Anlage meldet.
    public static let version = "1.0.10"
    public static let kwp = 20.0
    public static let batteryKwh = 20.0
    public static let minSocPct = 10.0
    /// Einspeisegrenze: 60 % der Anlagenleistung.
    public static let feedInLimitW = 12_000.0
    static let batteryMaxKw = 9.0
    /// Spannung des Akkus (48-V-System): rechnet den Ladestrom in Leistung um.
    static let batteryVolts = 52.0
    static let chargeEfficiency = 0.96
    static let dischargeEfficiency = 0.96
    /// Ladestand, mit dem die Kette der Tagesläufe beginnt.
    static let warmupSoc = 35.0

    public internal(set) var state: State
    public let world: DemoWorld
    private let cache = RunCache()

    public init(state: State, calendar: Calendar = .current) {
        self.state = state
        self.world = DemoWorld(calendar: calendar, startedAt: state.startedAt)
    }

    // MARK: - Zustand, den man in der Demo bedient

    public struct State: Codable, Equatable, Sendable {
        public struct Event: Codable, Equatable, Sendable {
            public var at: Date
            public var emergencyStop: Bool
            public var alarms: Int
            public var severity: Int
        }

        /// „Sofort laden“ (`charge`) bzw. „Laden stoppen“ (`stop`).
        public struct Override: Codable, Equatable, Sendable {
            public var kind: String
            public var powerW: Double
            public var requestedW: Double
            public var startedAt: Date
            public var until: Date?
            /// Was „Sofort laden“ bis `accountedAt` wirklich geladen hat (% des Auto-Akkus).
            /// Zeit im Not-Halt und unterwegs zählt nicht.
            public var chargedPct = 0.0
            public var accountedAt: Date

            public init(kind: String, powerW: Double, requestedW: Double, startedAt: Date, until: Date?) {
                self.kind = kind
                self.powerW = powerW
                self.requestedW = requestedW
                self.startedAt = startedAt
                self.until = until
                self.accountedAt = startedAt
            }
        }

        /// Sollwert am Netzpunkt ab Werk: Eigenverbrauch (der Akku gleicht aus, das Netz bleibt nahe null).
        public static let factoryGridSetpointW = -50.0

        public var startedAt: Date
        public var emergencyStop = false
        public var emergencyStopSince: Date?
        // Zeitplan
        public var manualRules: [JSONValue]
        public var disabledPlanRules: [String] = []
        public var defaultGridSetpointW = State.factoryGridSetpointW
        /// Ab Werk so viel, wie der Akku annimmt (175 A ≈ 9 kW).
        public var defaultChargeCurrentA = 175.0
        public var defaultFeedExcessDcPv = 1.0
        // Börsenautomatik
        public var automationEnabled = false
        public var automationWindowStart = "14:00"
        public var automationWindowEnd = "09:00"
        public var automationMinSocPct = 20.0
        public var automationMaxDischargeW = -9000.0
        public var automationRules: [JSONValue] = []
        public var automationLastRun: Date?
        // E-Auto
        public var evOptimize = true
        public var evOnlyWhenPlugged = true
        public var evDepartures = true
        public var evMinSocPct = 80.0
        public var evMaxSocPct: Double? = 90
        public var evOnce: Date?
        public var evOnceMinSocPct: Double?
        public var evWeek: [JSONValue]
        public var evOverride: Override?
        /// Was ein beendetes „Sofort laden“ über den Plan hinaus geladen hat — gilt bis zur nächsten Fahrt.
        public var evExtraPct = 0.0
        public var evExtraUntil: Date?
        /// Meldungen (Briefkasten): Alarme und Not-Halt, wie die Box sie hinterlegt.
        public var events: [Event]

        /// Frische Demo: eine Regel von Hand, Wochenplan mit Abfahrt an Werktagen, zwei ältere Meldungen.
        public init(startedAt: Date) {
            self.startedAt = startedAt
            manualRules = [[
                "id": "demo-nachtruhe", "enabled": true, "target": "chargeCurrentA",
                "start": "22:00", "end": "06:00", "value": 60, "source": "manual",
            ]]
            evWeek = (1...7).map { day in
                day <= 5
                    ? ["day": .int(Int64(day)), "departure": "07:00", "homeFrom": "08:30", "homeFromPrevDay": true, "minSocPct": day == 5 ? 90 : .null,
                       "tripSocPct": .double(DemoWorld.evTripPct)]
                    : Self.emptyDeparture(day)
            }
            events = [
                Event(at: startedAt.addingTimeInterval(-26.2 * 3600), emergencyStop: false, alarms: 1, severity: 1),
                Event(at: startedAt.addingTimeInterval(-25.8 * 3600), emergencyStop: false, alarms: 0, severity: 0),
            ]
        }

        static func emptyDeparture(_ day: Int) -> JSONValue {
            ["day": .int(Int64(day)), "departure": "", "homeFrom": "", "homeFromPrevDay": false, "minSocPct": .null, "tripSocPct": .null]
        }
    }

    /// Zustand ändern (Antworten auf Schreibanfragen, Tests).
    mutating func update(_ change: (inout State) -> Void) { change(&state) }

    // MARK: - Lauf eines Tages

    enum Mode: Equatable, Sendable {
        /// Eigenverbrauch: Überschuss in den Akku, Bedarf aus dem Akku.
        case own
        /// Akku mit dieser Leistung aus dem Netz laden (kW); das Haus läuft am Netz.
        case gridCharge(Double)
        /// Mit dieser Leistung aus dem Akku einspeisen (kW).
        case feedIn(Double)
        /// Überschuss einspeisen statt laden: Der Akku lädt später, wenn die Einspeisung weniger bringt.
        case sell
    }

    /// Leistungen zwischen PV, Akku, Netz und Haus (kW) und die Änderung des Ladestands.
    struct Flow: Equatable, Sendable {
        var solarToHome = 0.0, solarToBattery = 0.0, solarToGrid = 0.0
        var batteryToHome = 0.0, batteryToGrid = 0.0
        var gridToHome = 0.0, gridToBattery = 0.0
        /// Abgeregelt: negative Preise oder Einspeisegrenze.
        var curtailed = 0.0
        var socDelta = 0.0

        var batteryKw: Double { solarToBattery + gridToBattery - batteryToHome - batteryToGrid }
        var importKw: Double { gridToHome + gridToBattery }
        var exportKw: Double { solarToGrid + batteryToGrid }
    }

    /// Verteilt Erzeugung und Verbrauch für `hours` Stunden. `exportBlocked`:
    /// Negativpreis-Schutz — es wird nichts eingespeist, der Rest abgeregelt.
    /// `chargeLimitKw`: höchste Ladeleistung aus dem geltenden Ladestrom.
    static func split(pv: Double, load: Double, soc: Double, mode: Mode, exportBlocked: Bool, hours: Double,
                      chargeLimitKw: Double = batteryMaxKw) -> Flow {
        let room = max(0, (100 - soc) / 100 * batteryKwh / chargeEfficiency / hours)
        let avail = max(0, (soc - minSocPct) / 100 * batteryKwh * dischargeEfficiency / hours)
        let maxCharge = min(batteryMaxKw, max(0, chargeLimitKw), room), maxDischarge = min(batteryMaxKw, avail)
        var f = Flow()
        f.solarToHome = min(pv, load)
        let surplus = pv - f.solarToHome, deficit = load - f.solarToHome
        f.solarToBattery = mode == .sell && !exportBlocked ? 0 : min(surplus, maxCharge)
        var rest = surplus - f.solarToBattery
        switch mode {
        case .own, .sell:
            f.batteryToHome = min(deficit, maxDischarge)
        case .gridCharge(let kw):
            f.gridToBattery = max(0, min(kw, maxCharge - f.solarToBattery))
        case .feedIn(let kw):
            f.batteryToHome = min(deficit, maxDischarge)
            if !exportBlocked {
                // Sollwert am Netzpunkt: Der Solar-Überschuss zählt mit, der Akku legt den Rest dazu
                // (und lädt nur, was über den Sollwert hinausgeht).
                f.solarToBattery = min(max(0, surplus - kw), maxCharge)
                rest = surplus - f.solarToBattery
                f.batteryToGrid = max(0, min(kw - rest, maxDischarge - f.batteryToHome))
            }
        }
        f.gridToHome = deficit - f.batteryToHome
        if exportBlocked {
            f.curtailed = rest
            rest = 0
        }
        let allowed = max(0, feedInLimitW / 1000 - f.batteryToGrid)
        if rest > allowed {
            f.curtailed += rest - allowed
            rest = allowed
        }
        f.solarToGrid = rest
        f.socDelta = ((f.solarToBattery + f.gridToBattery) * chargeEfficiency - (f.batteryToHome + f.batteryToGrid) / dischargeEfficiency)
            * hours / batteryKwh * 100
        return f
    }

    /// Eine Viertelstunde der Anlage. Energien in kWh, Leistungen als Mittel in kW.
    public struct Slot: Sendable, Equatable {
        public let start: Date
        public let end: Date
        public let index: Int
        /// Erzeugung nach Abregelung.
        public let pvKw: Double
        /// Verbrauch mit Wallbox.
        public let loadKw: Double
        public let evKw: Double
        public let spotCt: Double
        public let importCt: Double
        public let socStart: Double
        public let socEnd: Double
        let mode: Mode
        public let exportBlocked: Bool
        let flow: Flow

        var hours: Double { end.timeIntervalSince(start) / 3600 }
        public var solarToHomeKwh: Double { flow.solarToHome * hours }
        public var solarToBatteryKwh: Double { flow.solarToBattery * hours }
        public var solarToGridKwh: Double { flow.solarToGrid * hours }
        public var batteryToHomeKwh: Double { flow.batteryToHome * hours }
        public var batteryToGridKwh: Double { flow.batteryToGrid * hours }
        public var gridToHomeKwh: Double { flow.gridToHome * hours }
        public var gridToBatteryKwh: Double { flow.gridToBattery * hours }
        public var curtailedKwh: Double { flow.curtailed * hours }
        public var pvKwh: Double { pvKw * hours }
        public var loadKwh: Double { loadKw * hours }
        public var importKwh: Double { gridToHomeKwh + gridToBatteryKwh }
        public var exportKwh: Double { solarToGridKwh + batteryToGridKwh }
        /// DVhub rechnet die Einspeisung zum Börsenpreis, den Bezug zum eigenen Tarif.
        public var revenueEur: Double { exportKwh * spotCt / 100 }
        public var costEur: Double { importKwh * importCt / 100 }
        public var avoidedEur: Double { (solarToHomeKwh + batteryToHomeKwh) * importCt / 100 }
    }

    /// Vorgabe des Optimierers für ein Zeitfenster des Tages.
    public struct PlanRule: Sendable, Equatable {
        public let id: String
        public let firstSlot: Int
        public let slotCount: Int
        /// Sollwert am Netzpunkt in W: + beziehen, − einspeisen.
        public let gridSetpointW: Double
        /// Beginn und Ende als „HH:MM“ nach der Uhr der Anlage.
        public let start: String
        public let end: String
    }

    public struct DayRun: Sendable, Equatable {
        public let day: DemoWorld.Day
        public let slots: [Slot]
        public let rules: [PlanRule]
        public var endSoc: Double { slots.last?.socEnd ?? DemoPlant.warmupSoc }
    }

    /// Lauf eines Tages vom Ladestand `startSoc` aus — mit den Vorgaben, die ein
    /// Optimierer für diesen Tag fände:
    ///   • wird der Akku vor dem Morgen leer, lädt er vorher zum Nachtpreis nach,
    ///   • reicht er abends über die Nacht hinaus, speist er den Rest zur teuersten Zeit ein,
    ///   • bei negativen Preisen speist die Anlage nicht ein.
    func run(_ day: DemoWorld.Day, startSoc: Double) -> DayRun {
        let previous = world.day(after: day, by: -1)
        let n = day.slotCount
        var pv: [Double] = [], house: [Double] = [], ev: [Double] = [], spot: [Double] = [], hours: [Double] = []
        pv.reserveCapacity(n); house.reserveCapacity(n); ev.reserveCapacity(n); spot.reserveCapacity(n); hours.reserveCapacity(n)
        for i in 0..<n {
            // Uhrzeit nach der Wand: An Tagen mit Zeitumstellung springt sie mit.
            let begin = day.start.addingTimeInterval(Double(i) * 900)
            let h = day.hour(of: begin.addingTimeInterval(450))
            hours.append(day.hour(of: begin))
            pv.append(world.pvKw(day, hour: h))
            house.append(world.houseKw(day, hour: h))
            ev.append(world.evPlanKw(day, hour: h, previous: previous))
            spot.append(world.spotCt(day, hour: h))
        }
        /// Erste Viertelstunde, die zur Uhrzeit `hour` oder danach beginnt.
        func index(_ hour: Double) -> Int { hours.firstIndex { $0 >= hour - 1e-6 } ?? n }
        func clock(_ i: Int) -> String { day.clock(of: day.start.addingTimeInterval(Double(i) * 900)) }
        /// In der Nacht lädt das Auto aus dem Netz, nicht aus dem Hausakku.
        func evFromGrid(_ i: Int) -> Double { hours[i] < 6 ? ev[i] : 0 }
        func flow(_ i: Int, soc: Double, mode: Mode) -> Flow {
            var f = Self.split(pv: pv[i], load: house[i] + ev[i] - evFromGrid(i), soc: soc, mode: mode, exportBlocked: spot[i] < 0, hours: 0.25)
            f.gridToHome += evFromGrid(i)
            return f
        }

        var modes = [Mode](repeating: .own, count: n)
        var rules: [PlanRule] = []

        // 1. Wird der Akku vor dem Morgen leer? Dann bis 04:30 zum Nachtpreis nachladen,
        //    was das Haus danach bis 08:00 sonst aus dem Netz zöge.
        let nightEnd = index(4.5), morningEnd = index(8)
        var soc = startSoc
        var importAfter = 0.0
        for i in 0..<morningEnd {
            let f = flow(i, soc: soc, mode: .own)
            soc += f.socDelta
            if i >= nightEnd { importAfter += (f.gridToHome - evFromGrid(i)) * 0.25 }
        }
        if importAfter > 0.5 {
            let kw = 3.0
            let need = min(6, importAfter / (Self.chargeEfficiency * Self.dischargeEfficiency))
            let count = min(8, max(1, Int((need / (kw * 0.25)).rounded(.up))))
            let first = max(0, nightEnd - count)
            for i in first..<nightEnd { modes[i] = .gridCharge(kw) }
            rules.append(PlanRule(id: "opt-\(day.number)-0", firstSlot: first, slotCount: nightEnd - first, gridSetpointW: kw * 1000,
                                  start: clock(first), end: clock(nightEnd)))
        }

        // 2. Den Akku dann laden, wenn die Einspeisung am wenigsten bringt (mittags, bei negativen
        //    Preisen zuerst) — den übrigen Überschuss davor und danach zum besseren Preis einspeisen.
        soc = startSoc
        var room: Double?
        var surplus: [(slot: Int, kwh: Double)] = []
        for i in 0..<n {
            let f = flow(i, soc: soc, mode: modes[i])
            let over = pv[i] - (house[i] + ev[i] - evFromGrid(i))
            if over > 0.05 {
                if room == nil { room = (100 - soc) / 100 * Self.batteryKwh / Self.chargeEfficiency }
                surplus.append((i, min(over, Self.batteryMaxKw) * 0.25))
            }
            soc += f.socDelta
        }
        if let room {
            var left = room * 1.12 + 0.5
            for s in surplus.sorted(by: { spot[$0.slot] < spot[$1.slot] }) {
                if left > 0 { left -= s.kwh } else if spot[s.slot] > 0 { modes[s.slot] = .sell }
            }
        }

        // 3. Der Tag bis zum frühen Abend.
        var slots: [Slot] = []
        slots.reserveCapacity(n)
        soc = startSoc
        func step(_ i: Int) {
            let f = flow(i, soc: soc, mode: modes[i])
            let start = day.start.addingTimeInterval(Double(i) * 900)
            let end = min(day.end, start.addingTimeInterval(900))
            let next = max(Self.minSocPct - 0.001, min(100, soc + f.socDelta))
            slots.append(Slot(start: start, end: end, index: i, pvKw: pv[i] - f.curtailed, loadKw: house[i] + ev[i], evKw: ev[i], spotCt: spot[i],
                              importCt: DemoWorld.importCt(spot: spot[i]), socStart: soc, socEnd: next, mode: modes[i],
                              exportBlocked: spot[i] < 0, flow: f))
            soc = next
        }
        let eveningStart = index(17.5)
        for i in 0..<eveningStart { step(i) }

        // 4. Reicht der Akku über die Nacht hinaus? Dann den Überschuss im teuersten
        //    Fenster zwischen 17:30 und 21:30 einspeisen.
        if eveningStart < n {
            let next = world.day(after: day)
            var need = 0.0
            for i in eveningStart..<n { need += max(0, house[i] + ev[i] - evFromGrid(i) - pv[i]) * 0.25 }
            for j in 0..<32 {
                let h = (Double(j) + 0.5) / 4
                need += max(0, world.houseKw(next, hour: h) - world.pvKw(next, hour: h)) * 0.25
            }
            let usable = max(0, (soc - Self.minSocPct) / 100 * Self.batteryKwh * Self.dischargeEfficiency)
            let spare = usable - need - 1.5
            let last = index(21.5)
            if spare > 2, last > eveningStart {
                let kw = 5.0
                let count = min(last - eveningStart, min(8, max(1, Int((min(spare, 8) / (kw * 0.25)).rounded(.down)))))
                var best = eveningStart, bestSum = -Double.infinity
                for s in eveningStart...(last - count) {
                    let sum = spot[s..<(s + count)].reduce(0, +)
                    if sum > bestSum { bestSum = sum; best = s }
                }
                if bestSum > 0 {
                    for i in best..<(best + count) { modes[i] = .feedIn(kw) }
                    rules.append(PlanRule(id: "opt-\(day.number)-1", firstSlot: best, slotCount: count, gridSetpointW: -kw * 1000,
                                          start: clock(best), end: clock(best + count)))
                }
            }
            for i in eveningStart..<n { step(i) }
        }
        return DayRun(day: day, slots: slots, rules: rules)
    }

    /// Ladestand am Beginn eines Tages: der, mit dem der Vortag endete. Die Läufe
    /// hängen vom ersten Tag der Kette an (`DemoWorld.origin`) lückenlos
    /// aneinander — kein Sprung über Mitternacht, in keiner Ansicht. Die Kette
    /// hängt nur von der Zeit ab: Derselbe Tag ergibt überall dieselben Werte,
    /// gleich in welcher Reihenfolge und in welchem Programm er gerechnet wird.
    func startSoc(_ day: DemoWorld.Day) -> Double {
        guard day.number > world.origin else { return Self.warmupSoc }
        if let soc = cache.end(day.number - 1) { return soc }
        // Zum letzten schon gerechneten Tag davor zurückgehen, sonst zum Anfang der Kette.
        var from = day.number - 1
        while from > world.origin, cache.end(from) == nil { from -= 1 }
        var soc = Self.warmupSoc
        var next = world.day(after: day, by: from - day.number)
        if let known = cache.end(from) {
            soc = known
            next = world.day(after: next)
        }
        while next.number < day.number {
            let r = run(next, startSoc: soc)
            cache.set(r)
            soc = r.endSoc
            next = world.day(after: next)
        }
        return soc
    }

    /// Lauf eines Tages — schließt an den Vortag an (`startSoc`).
    public func run(_ day: DemoWorld.Day) -> DayRun {
        if let hit = cache.run(day.number) { return hit }
        let r = run(day, startSoc: startSoc(day))
        cache.set(r)
        return r
    }

    public func run(containing date: Date) -> DayRun { run(world.day(containing: date)) }

    /// Läufe ab `first` für `count` Tage (Fahrplan über Mitternacht).
    func runs(from first: DemoWorld.Day, count: Int) -> [DayRun] {
        var out = [run(first)]
        while out.count < count, let last = out.last { out.append(run(world.day(after: last.day))) }
        return out
    }

    // MARK: - Summen

    /// Summen über Viertelstunden; die laufende zählt anteilig.
    public struct Totals: Sendable, Equatable {
        public var pvKwh = 0.0, loadKwh = 0.0, importKwh = 0.0, exportKwh = 0.0
        public var solarToHomeKwh = 0.0, solarToBatteryKwh = 0.0, solarToGridKwh = 0.0
        public var batteryToHomeKwh = 0.0, batteryToGridKwh = 0.0
        public var gridToHomeKwh = 0.0, gridToBatteryKwh = 0.0
        public var curtailedKwh = 0.0
        public var revenueEur = 0.0, costEur = 0.0, avoidedEur = 0.0
        public var batteryRevenueEur = 0.0
        public var negativeSlots = 0.0
        /// Summe aus Börsenpreis mal Stunden — für das zeitgewichtete Mittel.
        var spotHours = 0.0, hours = 0.0

        public var netEur: Double { revenueEur - costEur }
        public var batteryChargeKwh: Double { solarToBatteryKwh + gridToBatteryKwh }
        public var batteryDischargeKwh: Double { batteryToHomeKwh + batteryToGridKwh }
        public var meanSpotCt: Double? { hours > 0 ? spotHours / hours : nil }

        public mutating func add(_ s: Slot, share: Double = 1) {
            pvKwh += s.pvKwh * share; loadKwh += s.loadKwh * share
            importKwh += s.importKwh * share; exportKwh += s.exportKwh * share
            solarToHomeKwh += s.solarToHomeKwh * share; solarToBatteryKwh += s.solarToBatteryKwh * share; solarToGridKwh += s.solarToGridKwh * share
            batteryToHomeKwh += s.batteryToHomeKwh * share; batteryToGridKwh += s.batteryToGridKwh * share
            gridToHomeKwh += s.gridToHomeKwh * share; gridToBatteryKwh += s.gridToBatteryKwh * share
            curtailedKwh += s.curtailedKwh * share
            revenueEur += s.revenueEur * share; costEur += s.costEur * share; avoidedEur += s.avoidedEur * share
            batteryRevenueEur += s.batteryToGridKwh * s.spotCt / 100 * share
            if s.spotCt < 0 { negativeSlots += share }
            spotHours += s.spotCt * s.hours * share
            hours += s.hours * share
        }

        public mutating func add(_ t: Totals) {
            pvKwh += t.pvKwh; loadKwh += t.loadKwh; importKwh += t.importKwh; exportKwh += t.exportKwh
            solarToHomeKwh += t.solarToHomeKwh; solarToBatteryKwh += t.solarToBatteryKwh; solarToGridKwh += t.solarToGridKwh
            batteryToHomeKwh += t.batteryToHomeKwh; batteryToGridKwh += t.batteryToGridKwh
            gridToHomeKwh += t.gridToHomeKwh; gridToBatteryKwh += t.gridToBatteryKwh
            curtailedKwh += t.curtailedKwh
            revenueEur += t.revenueEur; costEur += t.costEur; avoidedEur += t.avoidedEur
            batteryRevenueEur += t.batteryRevenueEur
            negativeSlots += t.negativeSlots
            spotHours += t.spotHours; hours += t.hours
        }
    }

    /// Was ein Tag bis `now` zusammengebracht hat (ein vergangener Tag: alles; ein künftiger: nichts).
    public func totals(_ run: DayRun, until now: Date) -> Totals {
        var t = Totals()
        for s in run.slots where s.start < now {
            t.add(s, share: s.end <= now ? 1 : now.timeIntervalSince(s.start) / s.end.timeIntervalSince(s.start))
        }
        return t
    }

    // MARK: - Jetzt

    /// Der Augenblick: Leistungen in W, wie der Leitstand sie zeigt. Vorzeichen wie in DVhub (Akku + = Laden).
    public struct Live: Sendable, Equatable {
        public var at: Date
        public var soc = 0.0
        public var pvW = 0.0
        public var loadW = 0.0
        public var evW = 0.0
        public var batteryW = 0.0
        public var gridImportW = 0.0
        public var gridExportW = 0.0
        public var gridSetpointW = 0.0
        /// Woher der Sollwert stammt: `default`, `manual`, `forecast_optimizer`, `small_market_automation`.
        public var setpointSource = "default"
        public var solarToHomeW = 0.0, solarToBatteryW = 0.0, solarToGridW = 0.0
        public var batteryToHomeW = 0.0, batteryToGridW = 0.0
        public var gridToHomeW = 0.0, gridToBatteryW = 0.0
        public var spotCt = 0.0
        public var importCt = 0.0
        /// Negativpreis-Schutz greift gerade.
        public var negativePriceActive = false
        public var heatPumpW = 0.0
        public var today = Totals()
    }

    /// Fahrzeug jetzt.
    public struct Vehicle: Sendable, Equatable {
        public var socPct: Double
        public var plugged: Bool
        public var charging: Bool
        public var chargePowerW: Double
        /// Was bis zur nächsten Abfahrt noch zu laden ist (kWh).
        public var planEnergyKwh: Double
    }

    /// „Sofort laden“ bzw. „Laden stoppen“, solange es gilt.
    public func override(at now: Date) -> State.Override? {
        guard let o = state.evOverride else { return nil }
        if let until = o.until, until <= now { return nil }
        return o
    }

    /// Was „Sofort laden“ bis `now` wirklich geladen hat (% des Auto-Akkus):
    /// Nur wirksame Zeit zählt — nicht im Not-Halt und nicht, solange das Auto
    /// unterwegs ist. Der Not-Halt gilt seit `accountedAt` (bei jedem Wechsel
    /// wird dort neu angesetzt, `checkpointOverride`).
    func overrideCharged(_ o: State.Override, until now: Date) -> Double {
        guard o.kind == "charge", !state.emergencyStop else { return o.chargedPct }
        let hours = pluggedSeconds(from: o.accountedAt, to: min(now, o.until ?? now)) / 3600
        return o.chargedPct + o.powerW / 1000 * hours / DemoWorld.evBatteryKwh * 100
    }

    /// Zeit zwischen `a` und `b`, in der das Auto an der Wallbox steht: alles außer den Fahrten
    /// (Werktag 07:00–08:30), auf die Sekunde an Abfahrt und Rückkehr geteilt — so wächst das
    /// Geladene nur und hängt nicht davon ab, wann gefragt wird.
    func pluggedSeconds(from a: Date, to b: Date) -> TimeInterval {
        guard b > a else { return 0 }
        var total = b.timeIntervalSince(a)
        var day = world.day(containing: a)
        while day.start < b {
            if day.isWorkday {
                let from = max(a, day.date(atHour: DemoWorld.evAwayFrom)), to = min(b, day.date(atHour: DemoWorld.evAwayUntil))
                if to > from { total -= to.timeIntervalSince(from) }
            }
            day = world.day(after: day)
        }
        return max(0, total)
    }

    /// Stand des „Sofort laden“ festhalten, bevor sich ändert, ob es wirkt (Not-Halt).
    mutating func checkpointOverride(at now: Date) {
        guard var o = state.evOverride else { return }
        o.chargedPct = overrideCharged(o, until: now)
        o.accountedAt = max(o.accountedAt, min(now, o.until ?? now))
        state.evOverride = o
    }

    /// „Sofort laden“ endet: Was es geladen hat, bleibt im Auto — bis zur nächsten Fahrt.
    mutating func finishOverride(at now: Date) {
        guard let o = state.evOverride else { return }
        let end = min(now, o.until ?? now)
        let charged = overrideCharged(o, until: end)
        state.evOverride = nil
        guard o.kind == "charge", charged > 0 else { return }
        state.evExtraPct = min(100, extraPct(at: end) + charged)
        state.evExtraUntil = nextTrip(after: end)
    }

    /// Über den Plan hinaus Geladenes, solange es gilt.
    func extraPct(at now: Date) -> Double {
        guard let until = state.evExtraUntil, now < until else { return 0 }
        return state.evExtraPct
    }

    /// Beginn der nächsten Fahrt (Werktag, 07:00).
    func nextTrip(after now: Date) -> Date {
        var day = world.day(containing: now)
        for _ in 0..<8 {
            let start = day.date(atHour: DemoWorld.evAwayFrom)
            if day.isWorkday, start > now { return start }
            day = world.day(after: day)
        }
        return now.addingTimeInterval(86_400)
    }

    public func vehicle(at now: Date) -> Vehicle {
        let day = world.day(containing: now), previous = world.day(after: day, by: -1)
        let hour = day.hour(of: now)
        let away = world.evAway(day, hour: hour)
        let plan = world.evPlanKw(day, hour: hour, previous: previous)
        var soc = world.evSocPct(day, hour: hour, previous: previous, target: state.evMinSocPct) + extraPct(at: now)
        var charging = plan > 0 && !away, power = away ? 0 : plan * 1000
        if let o = override(at: now) {
            soc += overrideCharged(o, until: now)
            // Im Not-Halt steuert DVhub die Wallbox nicht: Die Vorgabe wirkt erst nach dem Aufheben.
            if !away, !state.emergencyStop {
                charging = o.kind == "charge" && soc < 100
                power = charging ? o.powerW : 0
            }
        }
        soc = min(100, soc)
        if soc >= 100 { charging = false; power = 0 }
        return Vehicle(socPct: soc, plugged: !away, charging: charging, chargePowerW: power,
                       planEnergyKwh: max(0, state.evMinSocPct - soc) / 100 * DemoWorld.evBatteryKwh)
    }

    /// Minuten seit Mitternacht aus „HH:MM“.
    static func minutes(_ hhmm: String?) -> Int? {
        guard let t = hhmm.flatMap(ScheduleEdit.normalizeTime) else { return nil }
        let p = t.split(separator: ":").compactMap { Int($0) }
        return p[0] * 60 + p[1]
    }

    /// Liegt `minute` im Fenster? Ein Fenster über Mitternacht (22:00–06:00) zählt durch.
    static func inWindow(_ minute: Int, start: Int, end: Int) -> Bool {
        start <= end ? (minute >= start && minute < end) : (minute >= start || minute < end)
    }

    /// Regel von Hand oder aus der Börsenautomatik, die jetzt für `target` gilt.
    func activeRule(_ target: String, at now: Date, soc: Double) -> (value: Double, source: String)? {
        let minute = world.minuteOfDay(now)
        for (rules, fallback) in [(state.manualRules, "manual"), (state.automationRules, "small_market_automation")] {
            for r in rules where r["enabled"]?.bool != false && r["target"]?.string == target {
                guard let a = Self.minutes(r["start"]?.string), let b = Self.minutes(r["end"]?.string), let v = r["value"]?.number,
                      Self.inWindow(minute, start: a, end: b) else { continue }
                // Stopp-Stand: Unter ihm schaltet die Box die Regel ab.
                if let stop = r["stopSocPct"]?.number, soc < stop { continue }
                return (v, r["source"]?.string ?? fallback)
            }
        }
        return nil
    }

    /// Höchste Ladeleistung des Akkus jetzt (kW): aus dem geltenden Ladestrom — Regel oder Grundwert.
    func chargeLimitKw(at now: Date, soc: Double) -> Double {
        let amps = (state.emergencyStop ? nil : activeRule("chargeCurrentA", at: now, soc: soc)?.value) ?? state.defaultChargeCurrentA
        return max(0, amps) * Self.batteryVolts / 1000
    }

    /// Ladestand des Akkus jetzt.
    func soc(at now: Date) -> Double {
        let run = self.run(containing: now)
        guard let slot = run.slots.last(where: { $0.start <= now }) ?? run.slots.first else { return Self.warmupSoc }
        let share = max(0, min(1, now.timeIntervalSince(slot.start) / slot.end.timeIntervalSince(slot.start)))
        return slot.socStart + (slot.socEnd - slot.socStart) * share
    }

    /// Was die Zeit erledigt, bevor eine Anfrage beantwortet oder ein Live-Wert gemeldet wird:
    ///   • „Sofort laden“ mit Dauer läuft ab (das Geladene bleibt im Auto), ein verstrichenes Einmal-Ziel fällt weg,
    ///   • eine Netz-Regel mit Stopp-Stand schaltet sich ab, sobald der Akku darunter liegt — und bleibt aus,
    ///     auch wenn er wieder steigt (wie auf der Box: autoDisableStopSocScheduleRules).
    public mutating func settle(at now: Date) {
        if let until = state.evOverride?.until, until <= now { finishOverride(at: now) }
        if let once = state.evOnce, once <= now {
            state.evOnce = nil
            state.evOnceMinSocPct = nil
        }
        if let until = state.evExtraUntil, until <= now {
            state.evExtraPct = 0
            state.evExtraUntil = nil
        }
        guard !state.emergencyStop else { return }
        let minute = world.minuteOfDay(now)
        var level: Double?
        func latch(_ rules: [JSONValue]) -> [JSONValue] {
            rules.map { r in
                guard r["enabled"]?.bool != false, r["target"]?.string == "gridSetpointW", let stop = r["stopSocPct"]?.number,
                      let a = Self.minutes(r["start"]?.string), let b = Self.minutes(r["end"]?.string), Self.inWindow(minute, start: a, end: b),
                      var o = r.object else { return r }
                let now = level ?? soc(at: now)
                level = now
                guard now < stop else { return r }
                o["enabled"] = false
                return .object(o)
            }
        }
        let manual = latch(state.manualRules), auto = latch(state.automationRules)
        if manual != state.manualRules { state.manualRules = manual }
        if auto != state.automationRules { state.automationRules = auto }
    }

    public func live(at now: Date) -> Live {
        let day = world.day(containing: now)
        let run = self.run(day)
        let hour = day.hour(of: now)
        var out = Live(at: now)
        guard let slot = run.slots.last(where: { $0.start <= now }) ?? run.slots.first else { return out }
        let share = max(0, min(1, now.timeIntervalSince(slot.start) / slot.end.timeIntervalSince(slot.start)))
        out.soc = slot.socStart + (slot.socEnd - slot.socStart) * share
        out.spotCt = slot.spotCt
        out.importCt = slot.importCt
        out.today = totals(run, until: now)

        // Leichte Bewegung: Wolkenränder und Geräte im Sekundentakt.
        let t = now.timeIntervalSince1970
        let pv = world.pvKw(day, hour: hour) * (1 + 0.012 * sin(t / 7.3) + 0.008 * sin(t / 2.9))
        let house = world.houseKw(day, hour: hour) * (1 + 0.03 * sin(t / 5.1) + 0.02 * sin(t / 1.7))
        out.heatPumpW = world.heatPumpKw(day, hour: hour) * 1000

        let car = vehicle(at: now)
        let ev = car.chargePowerW / 1000
        // Nachts lädt das Auto nach Plan aus dem Netz, nicht aus dem Hausakku.
        let evFromGrid = hour < 6 && override(at: now) == nil ? ev : 0
        let stopped = state.emergencyStop

        // Vorgabe des Optimierers für diese Viertelstunde — sofern die Regel nicht ausgeschaltet ist.
        // Im Not-Halt schreibt DVhub nichts: Die Anlage läuft im schlichten Eigenverbrauch.
        var mode = Mode.own
        out.gridSetpointW = state.defaultGridSetpointW
        if !stopped {
            if let rule = run.rules.first(where: { slot.index >= $0.firstSlot && slot.index < $0.firstSlot + $0.slotCount }) {
                if !state.disabledPlanRules.contains(rule.id) {
                    mode = slot.mode
                    out.gridSetpointW = rule.gridSetpointW
                    out.setpointSource = "forecast_optimizer"
                }
            } else {
                mode = slot.mode
            }
        }
        let blocked = slot.spotCt < 0 && !stopped
        // Geltender Ladestrom (Regel oder Grundwert) begrenzt, wie schnell der Akku lädt.
        let chargeLimit = chargeLimitKw(at: now, soc: out.soc)
        var f = Self.split(pv: pv, load: house + ev - evFromGrid, soc: out.soc, mode: mode, exportBlocked: blocked, hours: 1.0 / 60,
                           chargeLimitKw: chargeLimit)
        f.gridToHome += evFromGrid

        if !stopped, let rule = activeRule("gridSetpointW", at: now, soc: out.soc) {
            // Regel von Hand (oder Börsenautomatik): DVhub regelt auf diesen Sollwert am Netzpunkt.
            out.gridSetpointW = rule.value
            out.setpointSource = rule.source
            f = Self.hold(gridKw: rule.value / 1000, pv: pv, load: house + ev, soc: out.soc, exportBlocked: blocked, chargeLimitKw: chargeLimit)
        } else if !stopped, out.setpointSource == "default", abs(state.defaultGridSetpointW - State.factoryGridSetpointW) > 0.5 {
            // Geänderter Grundwert: Ohne Regel regelt DVhub auf ihn (ab Werk: Eigenverbrauch).
            f = Self.hold(gridKw: state.defaultGridSetpointW / 1000, pv: pv, load: house + ev, soc: out.soc, exportBlocked: blocked,
                          chargeLimitKw: chargeLimit)
        }

        out.pvW = (pv - f.curtailed) * 1000
        out.loadW = (house + ev) * 1000
        out.evW = ev * 1000
        out.batteryW = f.batteryKw * 1000
        out.gridImportW = f.importKw * 1000
        out.gridExportW = f.exportKw * 1000
        out.solarToHomeW = f.solarToHome * 1000; out.solarToBatteryW = f.solarToBattery * 1000; out.solarToGridW = f.solarToGrid * 1000
        out.batteryToHomeW = f.batteryToHome * 1000; out.batteryToGridW = f.batteryToGrid * 1000
        out.gridToHomeW = f.gridToHome * 1000; out.gridToBatteryW = f.gridToBattery * 1000
        out.negativePriceActive = blocked && f.curtailed > 0.02
        return out
    }

    /// Auf einen Sollwert am Netzpunkt regeln (kW: + beziehen, − einspeisen): Der Akku gleicht aus, soweit er kann.
    static func hold(gridKw: Double, pv: Double, load: Double, soc: Double, exportBlocked: Bool, chargeLimitKw: Double = batteryMaxKw) -> Flow {
        let canCharge = soc < 99.9, canDischarge = soc > minSocPct + 0.1
        let target = exportBlocked ? max(0, gridKw) : gridKw
        var battery = pv - load + target
        battery = max(canDischarge ? -batteryMaxKw : 0, min(canCharge ? min(batteryMaxKw, max(0, chargeLimitKw)) : 0, battery))
        var f = Flow()
        f.solarToHome = min(pv, load)
        let surplus = pv - f.solarToHome, deficit = load - f.solarToHome
        var rest = surplus
        if battery >= 0 {
            f.solarToBattery = min(surplus, battery)
            f.gridToBattery = battery - f.solarToBattery
            rest = surplus - f.solarToBattery
            f.gridToHome = deficit
        } else {
            f.batteryToHome = min(deficit, -battery)
            f.batteryToGrid = exportBlocked ? 0 : -battery - f.batteryToHome
            f.gridToHome = deficit - f.batteryToHome
        }
        if exportBlocked {
            f.curtailed = rest
            rest = 0
        }
        let allowed = max(0, feedInLimitW / 1000 - f.batteryToGrid)
        if rest > allowed {
            f.curtailed += rest - allowed
            rest = allowed
        }
        f.solarToGrid = rest
        return f
    }
}

/// Fertige Läufe je Tagesnummer, dazu der Ladestand am Ende jedes Tages (die
/// Kette). Beides hängt nur von der Zeit ab, nie vom bedienten Zustand — es
/// gilt für jede Kopie der Anlage.
final class RunCache: @unchecked Sendable {
    private let lock = NSLock()
    private var runs: [Int: DemoPlant.DayRun] = [:]
    private var ends: [Int: Double] = [:]

    func run(_ day: Int) -> DemoPlant.DayRun? {
        lock.lock(); defer { lock.unlock() }
        return runs[day]
    }

    func end(_ day: Int) -> Double? {
        lock.lock(); defer { lock.unlock() }
        return ends[day]
    }

    func set(_ run: DemoPlant.DayRun) {
        lock.lock(); defer { lock.unlock() }
        if runs.count > 800 { runs.removeAll(keepingCapacity: true) }
        runs[run.day.number] = run
        ends[run.day.number] = run.endSoc
    }
}

extension DemoPlant.State {
    private struct Start: Decodable { let startedAt: Date }

    /// Gespeicherten Zustand lesen — auch einen, den ein älterer Stand der App geschrieben hat:
    /// Felder, die es damals noch nicht gab, bekommen den Wert einer frischen Demo; was bedient
    /// wurde, bleibt. nil nur, wenn die Daten gar kein Zustand der Demo sind.
    public static func restore(_ data: Data) -> DemoPlant.State? {
        if let state = try? JSONDecoder().decode(Self.self, from: data) { return state }
        guard var stored = (try? JSONValue.decode(data))?.object, let start = try? JSONDecoder().decode(Start.self, from: data),
              let fresh = (try? JSONEncoder().encode(DemoPlant.State(startedAt: start.startedAt))).flatMap({ try? JSONValue.decode($0) })?.object
        else { return nil }
        for (key, value) in fresh where stored[key] == nil { stored[key] = value }
        if var override = stored["evOverride"]?.object {
            if override["chargedPct"] == nil { override["chargedPct"] = 0 }
            if override["accountedAt"] == nil { override["accountedAt"] = override["startedAt"] ?? .null }
            stored["evOverride"] = .object(override)
        }
        guard let merged = try? JSONValue.object(stored).encoded() else { return nil }
        return try? JSONDecoder().decode(Self.self, from: merged)
    }
}
