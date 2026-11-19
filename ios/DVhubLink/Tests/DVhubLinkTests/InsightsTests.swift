// InsightsTests.swift — Börsenpreise, Detailwerte, Historie und Energiefluss
// aus den Antwortformen der Box (Form wie in server.js / history-runtime.js).

import XCTest
@testable import DVhubLink

final class InsightsTests: XCTestCase {
    private func ms(_ iso: String) -> JSONValue { .int(Int64(parseISODate(iso)!.timeIntervalSince1970 * 1000)) }

    // MARK: Börsenpreise

    func testPricesFromStatusWithImportTariff() throws {
        let status: JSONValue = [
            "epex": ["data": [
                ["ts": ms("2026-11-13T10:15:00Z"), "ct_kwh": 9.5, "eur_mwh": 95],
                ["ts": ms("2026-11-13T10:00:00Z"), "ct_kwh": 8.25, "eur_mwh": 82.5],
                ["ts": ms("2026-11-13T10:30:00Z"), "ct_kwh": -1.2, "eur_mwh": -12],
                ["ts": ms("2026-11-13T10:30:00Z"), "ct_kwh": -1.2, "eur_mwh": -12], // doppelt
            ]],
            "userEnergyPricing": ["slots": [["ts": ms("2026-11-13T10:00:00Z"), "importPriceCtKwh": 31.4]]],
        ]
        let p = PriceSeries.from(status: status)
        XCTAssertEqual(p.count, 3)
        XCTAssertEqual(p[0].ctKwh, 8.25)
        XCTAssertEqual(p[0].importCtKwh, 31.4)
        XCTAssertNil(p[1].importCtKwh)
        XCTAssertEqual(p[0].end.timeIntervalSince(p[0].start), 900)
        // Letzter Slot bekommt die übliche Länge.
        XCTAssertEqual(p[2].end.timeIntervalSince(p[2].start), 900)
        let st = try XCTUnwrap(PriceSeries.stats(p))
        XCTAssertEqual(st.min.ctKwh, -1.2)
        XCTAssertEqual(st.max.ctKwh, 9.5)
        XCTAssertEqual(st.negativeSlots, 1)
        XCTAssertEqual(st.average, (8.25 + 9.5 - 1.2) / 3, accuracy: 1e-9)
        XCTAssertEqual(PriceSeries.current(p, at: parseISODate("2026-11-13T10:20:00Z")!)?.ctKwh, 9.5)
    }

    func testHourlyPricesAndGapsDoNotStretch() {
        let status: JSONValue = ["epex": ["data": [
            ["ts": ms("2026-11-13T00:00:00Z"), "ct_kwh": 5],
            ["ts": ms("2026-11-13T01:00:00Z"), "ct_kwh": 6],
            ["ts": ms("2026-11-13T02:00:00Z"), "ct_kwh": 7],
            ["ts": ms("2026-11-13T09:00:00Z"), "ct_kwh": 8], // Lücke
        ]]]
        let p = PriceSeries.from(status: status)
        XCTAssertEqual(p.map { $0.end.timeIntervalSince($0.start) }, [3600, 3600, 3600, 3600])
    }

    func testPricesToleratesMissingOrBrokenData() {
        XCTAssertTrue(PriceSeries.from(status: ["epex": ["data": [["ts": "kaputt", "ct_kwh": 3]]]]).isEmpty)
        XCTAssertTrue(PriceSeries.from(status: [:]).isEmpty)
        XCTAssertNil(PriceSeries.stats([]))
        // eur_mwh als Rückfall, ISO-Text als Zeitstempel.
        let p = PriceSeries.from(status: ["epex": ["data": [["ts": "2026-11-13T10:00:00.000Z", "eur_mwh": 120]]]])
        XCTAssertEqual(p.first?.ctKwh, 12)
    }

    // MARK: Detailwerte

    func testStatusDetailReadsSourcesPhasesAndFlows() throws {
        let status: JSONValue = [
            "now": ms("2026-11-13T12:00:00Z"),
            "victron": ["pvTotalW": 5200, "pvPowerW": 3100, "pvAcW": 2100, "acPvL1W": 700, "acPvL2W": 700, "acPvL3W": 700,
                        "soc": 61.5, "batteryPowerW": -800, "minSocPct": 10, "maxDischargeW": -1,
                        "gridImportW": 0, "gridExportW": 2400, "gridSetpointW": -50, "selfConsumptionW": 3600,
                        "solarDirectUseW": 2800, "solarToGridW": 2400, "batteryDirectUseW": 800,
                        "secondBatterySocPct": .null],
            "meter": ["grid_l1_w": -800, "grid_l2_w": -800, "grid_l3_w": -800, "grid_total_w": -2400,
                      "semantics": ["positiveMeans": "grid_import"]],
            "schedule": ["active": ["gridSetpointW": ["value": -50, "source": "eos"]]],
            "costs": ["importKwh": 1.2, "exportKwh": 9.8, "costEur": 0.36, "revenueEur": 0.88, "netEur": 0.52, "priceNowCtKwh": 9.1],
            "userEnergyPricing": ["current": ["importPriceCtKwh": 30.2]],
        ]
        let d = try XCTUnwrap(StatusDetail.from(status: status))
        XCTAssertEqual(d.pvDcW, 3100)
        XCTAssertEqual(d.pvAcPhasesW, [700, 700, 700])
        XCTAssertTrue(d.pvAc2PhasesW.isEmpty)
        XCTAssertEqual(d.batteryPowerW, -800)
        XCTAssertNil(d.secondSocPct)
        XCTAssertEqual(d.gridPhasesW, [-800, -800, -800])
        XCTAssertEqual(d.gridPhaseAsImport(-800), -800)
        XCTAssertEqual(d.activeSetpointSource, "eos")
        XCTAssertEqual(d.netEur, 0.52)
        XCTAssertEqual(d.importPriceNowCtKwh, 30.2)
        XCTAssertEqual(d.loadW, 3600)
        XCTAssertNotNil(d.at)
        // Standard in DVhub ist „feed_in“ (positiv = Einspeisung) — auch wenn die Angabe fehlt.
        var feedIn = d
        feedIn.gridPositiveMeans = "feed_in"
        XCTAssertEqual(feedIn.gridPhaseAsImport(3000), -3000)
        feedIn.gridPositiveMeans = nil
        XCTAssertEqual(feedIn.gridPhaseAsImport(3000), -3000)
        XCTAssertNil(StatusDetail.from(status: .array([])))
    }

    // MARK: Historie

    func testHistoryDaySummaryMergesEnergyAndMoneyPerSlot() throws {
        let body: JSONValue = [
            "kpis": ["pvKwh": 20, "loadKwh": 10, "importKwh": 2, "exportKwh": 12, "gridShareKwh": 2, "solarToGridKwh": 10,
                     "exportRevenueEur": 1.2, "gridCostEur": 0.6, "netEur": 0.4, "estimated": false],
            "charts": [
                "dayEnergyLines": [["ts": "2026-11-13T10:00:00.000Z", "label": "11:00", "pvKwh": 1.5, "loadKwh": 0.3, "estimated": false]],
                "dayFinancialLines": [["ts": "2026-11-13T10:00:00.000Z", "exportRevenueEur": 0.1, "netEur": 0.08]],
                "dayPriceLines": [["ts": "2026-11-13T10:00:00.000Z", "marketPriceCtKwh": 9.1, "userImportPriceCtKwh": .null]],
            ],
            "rows": [],
        ]
        let s = try XCTUnwrap(HistorySummary.from(body, view: .day, date: "2026-11-13"))
        XCTAssertEqual(s.rows.count, 1)
        XCTAssertEqual(s.rows[0].value("pvKwh"), 1.5)
        XCTAssertEqual(s.rows[0].value("exportRevenueEur"), 0.1)
        XCTAssertNil(s.rows[0].values["estimated"], "Wahrheitswerte sind keine Zahlen")
        XCTAssertEqual(s.dayPrices.first?.values["marketPriceCtKwh"], 9.1)
        XCTAssertNil(s.dayPrices.first?.values["userImportPriceCtKwh"])
        XCTAssertEqual(s.importCostEur, 0.6)
        XCTAssertEqual(s.netEur, 0.4)
        XCTAssertEqual(try XCTUnwrap(s.autarkyPct), 80, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(s.selfUsePct), 50, accuracy: 1e-9)
    }

    func testHistoryPeriodRowsUseLocalDates() throws {
        let body: JSONValue = [
            "kpis": ["pvKwh": 300, "importCostEur": 12.5, "exportRevenueEur": 20],
            "rows": [["key": "2026-11", "label": "2026-11", "pvKwh": 120], ["key": "2026-10", "label": "2026-10", "pvKwh": 180]],
        ]
        let s = try XCTUnwrap(HistorySummary.from(body, view: .year, date: "2026-11-13"))
        XCTAssertEqual(s.rows.map(\.key), ["2026-11", "2026-10"])
        let cal = Calendar.current
        XCTAssertEqual(cal.component(.month, from: try XCTUnwrap(s.rows[0].date)), 11)
        XCTAssertEqual(s.importCostEur, 12.5, "ohne gridCostEur gilt importCostEur")
        XCTAssertEqual(s.netEur, 7.5, "ohne netEur: Erlös minus Bezugskosten")
        XCTAssertNil(s.autarkyPct)
        XCTAssertNil(HistorySummary.from(["ok": false], view: .week, date: "2026-11-13"))
    }

    func testHistoryHelpers() {
        XCTAssertTrue(HistorySummary.isProRequired(status: 403, body: ["error": "pro_required", "feature": "history-multiperiod"]))
        XCTAssertFalse(HistorySummary.isProRequired(status: 403, body: ["error": "forbidden"]))
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let d = cal.date(from: DateComponents(year: 2026, month: 1, day: 31))!
        XCTAssertEqual(HistorySummary.dateParam(d, calendar: cal), "2026-01-31")
        XCTAssertEqual(HistorySummary.dateParam(HistorySummary.shift(d, view: .month, by: 1, calendar: cal), calendar: cal), "2026-02-28")
        XCTAssertEqual(HistorySummary.dateParam(HistorySummary.shift(d, view: .week, by: -1, calendar: cal), calendar: cal), "2026-01-24")
        XCTAssertNil(HistorySummary.localDate("kein-datum"))
    }

    // MARK: Energiemengen je Viertelstunde

    private func energyDay() throws -> (HistorySummary, Date, Date) {
        let body: JSONValue = [
            "kpis": ["pvKwh": 3],
            "charts": [
                "dayEnergyLines": [
                    // Reihenfolge durcheinander, ein doppelter Zeitstempel, ein Slot nach „jetzt“, einer vom Vortag.
                    ["ts": "2026-11-19T11:15:00.000Z", "solarDirectUseKwh": 0.25, "solarToBatteryKwh": 0.5, "solarToGridKwh": 0.75,
                     "batteryDirectUseKwh": 0, "batteryToGridKwh": 0, "gridDirectUseKwh": 0, "gridToBatteryKwh": 0, "incomplete": false],
                    ["ts": "2026-11-19T11:00:00.000Z", "solarDirectUseKwh": 0.1, "solarToBatteryKwh": 0, "solarToGridKwh": 0,
                     "batteryDirectUseKwh": 0.2, "batteryToGridKwh": 0.3, "gridDirectUseKwh": 0.4, "gridToBatteryKwh": 0.5],
                    ["ts": "2026-11-19T11:00:00.000Z", "solarDirectUseKwh": 9],
                    ["ts": "2026-11-19T11:30:00.000Z", "solarDirectUseKwh": -1, "gridDirectUseKwh": .null],
                    ["ts": "2026-11-19T11:45:00.000Z", "solarDirectUseKwh": 5],
                    ["ts": "2026-11-18T22:45:00.000Z", "solarDirectUseKwh": 7],
                    ["label": "ohne Zeit", "solarDirectUseKwh": 1],
                ],
            ],
        ]
        let s = try XCTUnwrap(HistorySummary.from(body, view: .day, date: "2026-11-19"))
        let from = try XCTUnwrap(parseISODate("2026-11-18T23:00:00.000Z"))
        return (s, from, from.addingTimeInterval(86400))
    }

    func testEnergySlotsKeepOnlyPastSlotsOfTheDayInOrder() throws {
        let (s, from, to) = try energyDay()
        let now = try XCTUnwrap(parseISODate("2026-11-19T11:40:00.000Z"))
        let slots = EnergyDay.slots(s, from: from, to: to, now: now)
        XCTAssertEqual(slots.map(\.start), ["2026-11-19T11:00:00.000Z", "2026-11-19T11:15:00.000Z", "2026-11-19T11:30:00.000Z"].compactMap { parseISODate($0) })
        XCTAssertEqual(slots[0].end.timeIntervalSince(slots[0].start), 900)
        XCTAssertEqual(slots[0].solarToHomeKwh, 0.1, "bei doppeltem Zeitstempel gilt die erste Zeile")
        XCTAssertEqual(slots[2].solarToHomeKwh, 0, "negative Anteile zählen als null")
        XCTAssertTrue(slots[2].bars.isEmpty)
        XCTAssertTrue(EnergyDay.hasFlows(slots))
        XCTAssertFalse(EnergyDay.hasFlows([slots[2]]))
        XCTAssertTrue(EnergyDay.slots(s, from: from, to: to, now: from).isEmpty, "vor Tagesbeginn ist nichts vergangen")
        let week = HistorySummary(view: .week, date: "2026-11-19", kpis: [:], rows: s.rows, dayPrices: [])
        XCTAssertTrue(EnergyDay.slots(week, from: from, to: to, now: now).isEmpty, "nur die Tagesansicht hat Slots")
    }

    func testEnergySlotStacksSourcesUpAndSinksDownInKw() throws {
        let (s, from, to) = try energyDay()
        let slots = EnergyDay.slots(s, from: from, to: to, now: to)
        let a = slots[0]
        // Quellen: Solar 0,1 · Akku 0,5 · Netz 0,9 kWh; Ziele: Haus 0,7 · Akku 0,5 · Netz 0,3 kWh.
        XCTAssertEqual(a.sourceKwh(.solar), 0.1, accuracy: 1e-9)
        XCTAssertEqual(a.sourceKwh(.battery), 0.5, accuracy: 1e-9)
        XCTAssertEqual(a.sourceKwh(.grid), 0.9, accuracy: 1e-9)
        XCTAssertEqual(a.sinkKwh(.home), 0.7, accuracy: 1e-9)
        XCTAssertEqual(a.sinkKwh(.battery), 0.5, accuracy: 1e-9)
        XCTAssertEqual(a.sinkKwh(.grid), 0.3, accuracy: 1e-9)
        XCTAssertEqual(a.sourceKwh(.home), 0)
        XCTAssertEqual(a.sinkKwh(.solar), 0)
        XCTAssertEqual(a.batteryNetKw, 0, accuracy: 1e-9)
        XCTAssertEqual(a.gridNetKw, 2.4, accuracy: 1e-9, "0,6 kWh Bezug netto in 15 min = 2,4 kW")
        let bars = a.bars
        XCTAssertEqual(bars.map(\.party), [.solar, .battery, .grid, .home, .battery, .grid])
        XCTAssertEqual(bars.map(\.isSource), [true, true, true, false, false, false])
        let edges = bars.map { [$0.fromKw, $0.toKw] }
        let want: [[Double]] = [[0, 0.4], [0.4, 2.4], [2.4, 6.0], [0, -2.8], [-2.8, -4.8], [-4.8, -6.0]]
        for (got, exp) in zip(edges, want) {
            XCTAssertEqual(got[0], exp[0], accuracy: 1e-9)
            XCTAssertEqual(got[1], exp[1], accuracy: 1e-9)
        }
        XCTAssertEqual(Set(bars.map(\.id)).count, bars.count)
        // Reiner Solar-Slot: nur, was da ist.
        XCTAssertEqual(slots[1].bars.map(\.party), [.solar, .home, .battery, .grid])
        XCTAssertEqual(slots[1].batteryNetKw, 2, accuracy: 1e-9)
        XCTAssertEqual(slots[1].gridNetKw, -3, accuracy: 1e-9)

        let t = EnergyDay.totals(Array(slots.prefix(2)))
        XCTAssertEqual(t.solarKwh, 1.6, accuracy: 1e-9)
        XCTAssertEqual(t.homeKwh, 0.95, accuracy: 1e-9)
        XCTAssertEqual(t.importKwh, 0.9, accuracy: 1e-9)
        XCTAssertEqual(t.exportKwh, 1.05, accuracy: 1e-9)
        XCTAssertEqual(t.batteryChargeKwh, 1.0, accuracy: 1e-9)
        XCTAssertEqual(t.batteryDischargeKwh, 0.5, accuracy: 1e-9)
        let e = EnergyDay.extentKw(Array(slots.prefix(2)))
        XCTAssertEqual(e.up, 6, accuracy: 1e-9)
        XCTAssertEqual(e.down, 6, accuracy: 1e-9)
    }

    func testEnergySlotLengthFollowsTheRowSpacing() throws {
        let body: JSONValue = ["kpis": ["pvKwh": 1], "charts": ["dayEnergyLines": [
            ["ts": "2026-11-19T08:00:00.000Z", "solarDirectUseKwh": 2],
            ["ts": "2026-11-19T09:00:00.000Z", "solarDirectUseKwh": 1],
            ["ts": "2026-11-19T10:00:00.000Z", "solarDirectUseKwh": 1],
        ]]]
        let s = try XCTUnwrap(HistorySummary.from(body, view: .day, date: "2026-11-19"))
        let from = try XCTUnwrap(parseISODate("2026-11-18T23:00:00.000Z"))
        let slots = EnergyDay.slots(s, from: from, to: from.addingTimeInterval(86400), now: from.addingTimeInterval(86400))
        XCTAssertEqual(slots.first?.end.timeIntervalSince(slots[0].start), 3600)
        XCTAssertEqual(try XCTUnwrap(slots.first).kw(2), 2, accuracy: 1e-9, "2 kWh in einer Stunde = 2 kW")
        XCTAssertTrue(slots[0].contains(slots[0].start) && !slots[0].contains(slots[0].end))
    }

    // MARK: Energiefluss

    func testFlowDirectionsFollowDVhubSigns() {
        var s = LiveStatus()
        s.pvTotalW = 5000; s.loadW = 900; s.batteryPowerW = 1500; s.gridImportW = 0; s.gridExportW = 2600
        let e = Dictionary(uniqueKeysWithValues: FlowEdge.edges(from: s).map { ($0.node, $0) })
        XCTAssertEqual(e[.pv]?.towardHub, true)
        XCTAssertEqual(e[.home]?.towardHub, false)
        XCTAssertEqual(e[.battery]?.towardHub, false, "+ = Laden: von der Mitte in den Akku")
        XCTAssertEqual(e[.grid]?.towardHub, false, "Einspeisung: von der Mitte ins Netz")
        s.batteryPowerW = -800; s.gridImportW = 400; s.gridExportW = 0
        let e2 = Dictionary(uniqueKeysWithValues: FlowEdge.edges(from: s).map { ($0.node, $0) })
        XCTAssertEqual(e2[.battery]?.towardHub, true)
        XCTAssertEqual(e2[.grid]?.towardHub, true)
        XCTAssertEqual(e2[.battery]?.watts, 800)
    }

    func testFlowSpeedAndDensityGrowWithPower() {
        let idle = FlowEdge(node: .pv, towardHub: true, watts: 10)
        XCTAssertFalse(idle.active)
        XCTAssertEqual(idle.particleCount, 0)
        XCTAssertEqual(idle.speed, 0)
        let small = FlowEdge(node: .pv, towardHub: true, watts: 150)
        let big = FlowEdge(node: .pv, towardHub: true, watts: 9000)
        XCTAssertGreaterThan(big.speed, small.speed)
        XCTAssertGreaterThan(big.particleCount, small.particleCount)
        XCTAssertLessThanOrEqual(FlowEdge(node: .pv, towardHub: true, watts: 1e9).particleCount, FlowEdge.maxParticles)
        XCTAssertLessThanOrEqual(FlowEdge(node: .pv, towardHub: true, watts: 1e9).speed, 0.6)
        // Dichte wie im Web-Leitstand proportional zur Leistung: 2 kW ≈ doppelt so dicht wie 1 kW.
        XCTAssertEqual(FlowEdge(node: .pv, towardHub: true, watts: 1000).particleCount, 18)
        XCTAssertEqual(FlowEdge(node: .pv, towardHub: true, watts: 2000).particleCount, 36)
        XCTAssertGreaterThanOrEqual(small.particleCount, 4)
        // Positionen bleiben in 0…1 und laufen in Flussrichtung.
        for t in stride(from: 0.0, to: 5, by: 0.37) {
            for i in 0..<big.particleCount {
                let p = big.position(particle: i, time: t)
                XCTAssertTrue((0...1).contains(p))
            }
        }
        let out = FlowEdge(node: .home, towardHub: false, watts: 2000)
        let a = out.position(particle: 0, time: 0.10), b = out.position(particle: 0, time: 0.12)
        XCTAssertLessThan(b, a, "vom Mittelpunkt weg: Position (0 = Knoten) nimmt ab")
    }

    /// Partikel tragen die Farbe ihrer Quelle: zum Haus gemischt aus PV, Akku und Netz.
    func testFlowSourcesMixLikeTheWebDashboard() {
        var s = LiveStatus()
        s.pvTotalW = 3000; s.loadW = 4000; s.batteryPowerW = -500; s.gridImportW = 500; s.gridExportW = 0
        var e = Dictionary(uniqueKeysWithValues: FlowEdge.edges(from: s).map { ($0.node, $0) })
        XCTAssertEqual(e[.pv]?.sources, [.pv: 1])
        XCTAssertEqual(e[.battery]?.sources, [.battery: 1], "Entladen: der Akku ist selbst die Quelle")
        XCTAssertEqual(e[.grid]?.sources, [.grid: 1])
        let home = e[.home]!
        XCTAssertEqual(home.sources[.pv] ?? 0, 0.75, accuracy: 1e-9)
        XCTAssertEqual(home.sources[.battery] ?? 0, 0.125, accuracy: 1e-9)
        XCTAssertEqual(home.sources[.grid] ?? 0, 0.125, accuracy: 1e-9)
        XCTAssertEqual(home.source(rank: 0.1), .pv)
        XCTAssertEqual(home.source(rank: 0.8), .battery)
        XCTAssertEqual(home.source(rank: 0.9), .grid)
        XCTAssertEqual(home.source(rank: 0.999999), .grid)

        // Überschuss: Akku lädt aus PV, Einspeisung aus PV; kein Bezug.
        s.pvTotalW = 6000; s.loadW = 1000; s.batteryPowerW = 2000; s.gridImportW = 0; s.gridExportW = 3000
        e = Dictionary(uniqueKeysWithValues: FlowEdge.edges(from: s).map { ($0.node, $0) })
        XCTAssertEqual(e[.home]?.sources, [.pv: 1])
        XCTAssertEqual(e[.battery]?.sources, [.pv: 1])
        XCTAssertEqual(e[.grid]?.sources, [.pv: 1])
        XCTAssertEqual(e[.grid]?.source(rank: 0.5), .pv)

        // Nachts: Akku lädt aus dem Netz, das Haus läuft am Netz.
        s.pvTotalW = 0; s.loadW = 500; s.batteryPowerW = 1500; s.gridImportW = 2000; s.gridExportW = 0
        e = Dictionary(uniqueKeysWithValues: FlowEdge.edges(from: s).map { ($0.node, $0) })
        XCTAssertEqual(e[.battery]?.sources, [.grid: 1])
        XCTAssertEqual(e[.home]?.source(rank: 0.3), .grid)

        // Keine Quelle gemessen (alles 0): Rückfall ohne Absturz.
        XCTAssertEqual(FlowEdge.edges(from: LiveStatus()).first { $0.node == .home }?.source(rank: 0.5), .grid)
    }
}
