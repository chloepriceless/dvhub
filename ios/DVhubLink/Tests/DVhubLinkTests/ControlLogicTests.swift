// ControlLogicTests.swift — Bedienen aus der App: Zeitplan-Regeln, E-Auto,
// Tarif-Spanne, Tagesenergie. Antwortformen wie in dvhub/routes-api.js.

import XCTest
@testable import DVhubLink

final class ControlLogicTests: XCTestCase {
    private func date(_ iso: String) -> Date { parseISODate(iso)! }

    // MARK: Zeitplan

    private let schedule: JSONValue = [
        "rules": [
            ["id": "opt-1763110800000-0", "enabled": true, "target": "gridSetpointW", "start": "11:00", "end": "11:15", "value": -3000,
             "source": "forecast_optimizer", "slotTs": 1_763_110_800_000, "closedLoopExport": true],
            ["id": "grid_1", "enabled": true, "target": "gridSetpointW", "start": "00:00", "end": "05:00", "value": 2000,
             "stopSocPct": 80, "activeDate": "2026-11-15", "_wasActive": true],
            ["id": "sma-3", "enabled": true, "target": "gridSetpointW", "start": "18:00", "end": "18:15", "value": -4000, "source": "small_market_automation"],
            ["id": "charge_1", "enabled": false, "target": "chargeCurrentA", "start": "00:00", "end": "05:00", "value": 70],
            ["id": "dc_1", "enabled": true, "target": "feedExcessDcPv", "start": "10:00", "end": "16:00", "value": 1],
        ],
    ]

    func testRulesAreClassifiedLikeOnTheBox() {
        let rules = ScheduleEdit.rules(from: schedule)
        XCTAssertEqual(rules.count, 5)
        XCTAssertEqual(rules.map(\.isAutomation), [true, false, true, false, false])
        // Von Hand, Netz-Sollwert oder Ladestrom: in der App änderbar. Alles andere nur umschaltbar.
        XCTAssertEqual(rules.map(\.isEditable), [false, true, false, true, false])
        XCTAssertTrue(rules.allSatisfy(\.canToggle))
        XCTAssertEqual(rules[1].stopSocPct, 80)
        XCTAssertFalse(rules[3].enabled)
        XCTAssertEqual(Set(rules.map(\.id)).count, 5)
    }

    func testUpdateSendsAllManualRulesAndKeepsUnknownFields() throws {
        let rules = ScheduleEdit.rules(from: schedule)
        let draft = ScheduleEdit.Draft(target: "gridSetpointW", start: "1:30", end: "05:00", value: 2500, stopSocPct: nil, enabled: true)
        let body = try ScheduleEdit.payload(schedule: schedule, change: .update(rules[1], draft)).get()
        let sent = try XCTUnwrap(body["rules"]?.array)
        // Plan-Regeln (Optimierer, Börsenautomatik) verwaltet die Box selbst: Sie gehen nicht mit.
        XCTAssertEqual(sent.compactMap { $0["id"]?.string }, ["grid_1", "charge_1", "dc_1"])
        XCTAssertEqual(sent[0]["start"]?.string, "01:30")
        XCTAssertEqual(sent[0]["value"]?.number, 2500)
        // Felder, die die App nicht kennt, bleiben; die Laufzeit-Markierung und das entfernte Stopp-Ziel nicht.
        XCTAssertEqual(sent[0]["activeDate"]?.string, "2026-11-15")
        XCTAssertNil(sent[0]["stopSocPct"])
        XCTAssertNil(sent[0]["_wasActive"])
        // Die anderen Regeln gehen unverändert zurück.
        XCTAssertEqual(sent[1], rules[3].raw)
        XCTAssertEqual(sent[2], rules[4].raw)
    }

    func testAddAndRemove() throws {
        let rules = ScheduleEdit.rules(from: schedule)
        let draft = ScheduleEdit.Draft(target: "chargeCurrentA", start: "22:00", end: "06:00", value: 40)
        let added = try ScheduleEdit.payload(schedule: schedule, change: .add(draft), newId: { "app-test" }).get()
        let list = try XCTUnwrap(added["rules"]?.array)
        XCTAssertEqual(list.count, 4)
        XCTAssertEqual(list[3], ["id": "app-test", "source": "manual", "target": "chargeCurrentA", "start": "22:00", "end": "06:00", "value": 40.0, "enabled": true])
        // Die neue Regel zählt auf der Box als Regel von Hand.
        XCTAssertFalse(ScheduleEdit.isAutomation(list[3]))

        let removed = try ScheduleEdit.payload(schedule: schedule, change: .remove(rules[3])).get()
        XCTAssertEqual(removed["rules"]?.array?.compactMap { $0["id"]?.string }, ["grid_1", "dc_1"])
    }

    func testNothingIsSentWhenTheRuleChangedMeanwhile() {
        let rules = ScheduleEdit.rules(from: schedule)
        // Inzwischen hat jemand in der Weboberfläche den Wert geändert.
        let newer: JSONValue = ["rules": [["id": "grid_1", "enabled": true, "target": "gridSetpointW", "start": "00:00", "end": "05:00", "value": 9999]]]
        let draft = ScheduleEdit.Draft(target: "gridSetpointW", start: "00:00", end: "05:00", value: 1000)
        XCTAssertEqual(ScheduleEdit.payload(schedule: newer, change: .update(rules[1], draft)), .failure(.changedMeanwhile))
        XCTAssertEqual(ScheduleEdit.payload(schedule: newer, change: .remove(rules[1])), .failure(.changedMeanwhile))
        // Nur die Laufzeit-Markierung ist anders: gilt als dieselbe Regel.
        let sameButLive: JSONValue = ["rules": [["id": "grid_1", "enabled": true, "target": "gridSetpointW", "start": "00:00", "end": "05:00", "value": 2000,
                                                 "stopSocPct": 80, "activeDate": "2026-11-15"]]]
        XCTAssertNoThrow(try ScheduleEdit.payload(schedule: sameButLive, change: .remove(rules[1])).get())
    }

    func testAutomationAndForeignTargetsAreNeverRewritten() {
        let rules = ScheduleEdit.rules(from: schedule)
        let draft = ScheduleEdit.Draft(target: "gridSetpointW", start: "11:00", end: "11:15", value: 0)
        XCTAssertEqual(ScheduleEdit.payload(schedule: schedule, change: .update(rules[0], draft)), .failure(.notEditable))
        XCTAssertEqual(ScheduleEdit.payload(schedule: schedule, change: .remove(rules[2])), .failure(.notEditable))
        XCTAssertEqual(ScheduleEdit.payload(schedule: schedule, change: .remove(rules[4])), .failure(.notEditable))
    }

    func testValidation() {
        func d(_ target: String = "gridSetpointW", _ start: String = "10:00", _ end: String = "11:00", _ value: Double = 0, stop: Double? = nil) -> ScheduleEdit.Draft {
            .init(target: target, start: start, end: end, value: value, stopSocPct: stop)
        }
        XCTAssertNil(ScheduleEdit.validate(d()))
        XCTAssertNil(ScheduleEdit.validate(d("gridSetpointW", "22:00", "06:00", -100_000, stop: 20)))
        XCTAssertEqual(ScheduleEdit.validate(d("minSocPct")), .badTarget)
        XCTAssertEqual(ScheduleEdit.validate(d("gridSetpointW", "24:00")), .badTime)
        XCTAssertEqual(ScheduleEdit.validate(d("gridSetpointW", "10:00", "10:0")), .sameTime)
        XCTAssertEqual(ScheduleEdit.validate(d("gridSetpointW", "10:00", "11:00", 100_001)), .valueOutOfRange(max: 100_000))
        XCTAssertEqual(ScheduleEdit.validate(d("gridSetpointW", "10:00", "11:00", .nan)), .valueOutOfRange(max: 100_000))
        XCTAssertEqual(ScheduleEdit.validate(d("chargeCurrentA", "10:00", "11:00", -1)), .valueOutOfRange(max: 1000))
        XCTAssertEqual(ScheduleEdit.validate(d("chargeCurrentA", "10:00", "11:00", 10, stop: 50)), .badStopSoc)
        XCTAssertEqual(ScheduleEdit.validate(d("gridSetpointW", "10:00", "11:00", 0, stop: 101)), .badStopSoc)
        XCTAssertEqual(ScheduleEdit.normalizeTime(" 7:5 "), "07:05")
        for bad in ["", "7", "7:60", "-1:00", "07:05:00", "a:b", "007:05", "7:"] { XCTAssertNil(ScheduleEdit.normalizeTime(bad), bad) }
    }

    /// Die Box schaltet eine Regel ab, sobald der Akku unter den Stopp-Stand fällt.
    func testStopLevelIsOnlyCarriedWhereItMakesSense() {
        let rules = ScheduleEdit.rules(from: [
            "rules": [
                ["id": "feed", "target": "gridSetpointW", "start": "10:00", "end": "11:00", "value": -3000, "stopSocPct": 20],
                ["id": "draw", "target": "gridSetpointW", "start": "00:00", "end": "05:00", "value": 2000, "stopSocPct": 80],
            ],
        ])
        // Einspeisen und 0 W: Die Wahl in der App gilt.
        XCTAssertTrue(ScheduleEdit.offersStop(signedValue: -3000))
        XCTAssertTrue(ScheduleEdit.offersStop(signedValue: 0))
        XCTAssertFalse(ScheduleEdit.offersStop(signedValue: 2000))
        XCTAssertEqual(ScheduleEdit.stopLevel(signedValue: -3000, chosen: 25, opened: rules[0]), 25)
        XCTAssertNil(ScheduleEdit.stopLevel(signedValue: -3000, chosen: nil, opened: rules[0]))
        XCTAssertEqual(ScheduleEdit.stopLevel(signedValue: 0, chosen: 30, opened: nil), 30)
        // Einspeise-Regel auf Beziehen umgestellt: Ihr Stopp-Stand geht NICHT unsichtbar mit.
        XCTAssertNil(ScheduleEdit.stopLevel(signedValue: 3000, chosen: 20, opened: rules[0]))
        // Neue Bezugs-Regel: nie ein Stopp-Stand.
        XCTAssertNil(ScheduleEdit.stopLevel(signedValue: 3000, chosen: 50, opened: nil))
        // Bestehende Bezugs-Regel mit Stopp-Stand (aus der Weboberfläche): bleibt, wie sie ist.
        XCTAssertEqual(ScheduleEdit.stopLevel(signedValue: 2500, chosen: nil, opened: rules[1]), 80)
    }

    func testWriteOutcome() {
        XCTAssertEqual(WriteOutcome.from(LinkResponse(status: 200, body: ["ok": true])), .done)
        XCTAssertEqual(WriteOutcome.from(LinkResponse(status: 200, body: ["ok": false, "error": "x"])), .failed(status: 200, error: "x"))
        XCTAssertEqual(WriteOutcome.from(LinkResponse(status: 400, body: ["ok": false, "error": "departure.once must be more than 30 min in the future"])),
                       .invalid("departure.once must be more than 30 min in the future"))
        XCTAssertEqual(WriteOutcome.from(LinkResponse(status: 403, body: ["ok": false, "error": "pro_required"])), .proRequired)
        XCTAssertEqual(WriteOutcome.from(LinkResponse(status: 403, body: ["error": "control_not_allowed"])), .notAllowed)
        XCTAssertEqual(WriteOutcome.from(LinkResponse(status: 429, body: ["error": "too_many_requests"])), .busy)
        XCTAssertEqual(WriteOutcome.from(LinkResponse(status: 500, body: ["ok": false, "error": "save failed"])), .failed(status: 500, error: "save failed"))
        XCTAssertTrue(WriteOutcome.done.ok)
        XCTAssertFalse(WriteOutcome.proRequired.ok)
    }

    // MARK: E-Auto

    private let ev: JSONValue = [
        "ok": true, "optimizeEv": true, "onlyWhenPlugged": false, "chargerConfigured": true,
        "departure": [
            "enabled": true, "once": "2026-11-15T06:30:00.000Z", "onceMinSocPct": 90, "maxSocPct": 80, "defaultMinSocPct": 60,
            "weeklyDepartures": [
                ["day": 1, "departure": "07:00", "homeFrom": "18:00", "homeFromPrevDay": true, "minSocPct": 70, "tripSocPct": 25],
                ["day": 2, "departure": "", "homeFrom": "", "homeFromPrevDay": false, "minSocPct": nil, "tripSocPct": nil],
            ],
            "resolved": ["enabled": true, "departureAt": "2026-11-15T06:30:00.000Z", "source": "once", "targetSocPct": 90],
        ],
        "vehicle": ["title": "Model Y", "socPct": 64, "rangeKm": 268, "connected": true, "charging": false, "chargePowerW": 0, "plugged": true],
        "plan": ["hasEv": true, "energyKwh": 12.4, "socAtDeparture": 91],
        "planError": nil,
        "override": ["kind": "charge", "powerW": 11000, "until": "2026-11-14T20:00:00.000Z"],
        "lastCommandError": nil,
    ]

    func testEVStateReadsNamedFields() throws {
        let s = try XCTUnwrap(EVState.from(ev))
        XCTAssertTrue(s.optimizeEv)
        XCTAssertFalse(s.onlyWhenPlugged)
        XCTAssertTrue(s.departureEnabled)
        XCTAssertEqual(s.defaultMinSocPct, 60)
        XCTAssertEqual(s.maxSocPct, 80)
        XCTAssertEqual(s.once, date("2026-11-15T06:30:00Z"))
        XCTAssertEqual(s.onceMinSocPct, 90)
        XCTAssertEqual(s.nextDeparture, date("2026-11-15T06:30:00Z"))
        XCTAssertEqual(s.nextSource, "once")
        XCTAssertEqual(s.week.map(\.day), [1, 2])
        XCTAssertEqual(s.week[1].departure, "")
        XCTAssertEqual(s.vehicle.socPct, 64)
        XCTAssertEqual(s.planEnergyKwh, 12.4)
        XCTAssertEqual(s.override, EVState.Override(stop: false, powerW: 11000, until: date("2026-11-14T20:00:00Z")))
        // Fehlende Blöcke: sichere Vorgaben, kein Absturz.
        let bare = try XCTUnwrap(EVState.from(["ok": true]))
        XCTAssertFalse(bare.optimizeEv)
        XCTAssertTrue(bare.onlyWhenPlugged)
        XCTAssertNil(bare.maxSocPct)
        XCTAssertNil(bare.override)
        XCTAssertNil(EVState.from(["ok": false, "error": "x"]))
        XCTAssertNil(EVState.from("kaputt"))
    }

    func testEVEditBodiesCarryOnlyTheChangedFields() {
        XCTAssertEqual(EVEdit.optimize(false), ["optimizeEv": false])
        XCTAssertEqual(EVEdit.onlyWhenPlugged(true), ["onlyWhenPlugged": true])
        XCTAssertEqual(EVEdit.departurePlanning(true), ["departure": ["enabled": true]])
        XCTAssertEqual(EVEdit.minSoc(64.6), ["departure": ["targetMode": "percent", "targetValue": 65.0]])
        XCTAssertNil(EVEdit.minSoc(5))
        XCTAssertNil(EVEdit.minSoc(.nan))
        XCTAssertEqual(EVEdit.maxSoc(80), ["departure": ["maxSocPct": 80.0]])
        XCTAssertEqual(EVEdit.maxSoc(nil), ["departure": ["maxSocPct": nil]])
        XCTAssertNil(EVEdit.maxSoc(101))
        let now = date("2026-11-14T18:00:00Z")
        XCTAssertEqual(EVEdit.once(at: date("2026-11-15T06:30:00Z"), minSocPct: 90, now: now),
                       ["departure": ["once": "2026-11-15T06:30:00Z", "onceMinSocPct": 90.0]])
        XCTAssertNil(EVEdit.once(at: date("2026-11-14T17:00:00Z"), minSocPct: 90, now: now))
        XCTAssertNil(EVEdit.once(at: date("2026-11-15T06:30:00Z"), minSocPct: 120, now: now))
        XCTAssertEqual(EVEdit.clearOnce(), ["departure": ["once": "", "onceMinSocPct": nil]])
        // Mehrere Änderungen gehen als eine Anfrage.
        let parts: [JSONValue] = [EVEdit.optimize(true), EVEdit.departurePlanning(false), EVEdit.maxSoc(nil)!, EVEdit.minSoc(70)!]
        XCTAssertEqual(EVEdit.merge(parts),
                       ["optimizeEv": true, "departure": ["enabled": false, "maxSocPct": nil, "targetMode": "percent", "targetValue": 70.0]])
        XCTAssertEqual(EVEdit.merge([]), [:])
    }

    func testWeekEditKeepsTheOtherRowsAndFields() throws {
        let s = try XCTUnwrap(EVState.from(ev))
        let body = try XCTUnwrap(EVEdit.week(s.week, changing: 0, departure: "6:45", minSocPct: 85))
        let rows = try XCTUnwrap(body["departure"]?["weeklyDepartures"]?.array)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0], ["day": 1, "departure": "06:45", "homeFrom": "18:00", "homeFromPrevDay": true, "minSocPct": 85.0, "tripSocPct": 25])
        XCTAssertEqual(rows[1], s.week[1].raw)
        // Nur die Zeit geändert: Ein krummes Ziel der Box bleibt, wie es ist.
        var odd = s.week
        odd[0] = EVState.WeekRow(raw: ["day": 1, "departure": "07:00", "minSocPct": 72.5], index: 0, day: 1, departure: "07:00", minSocPct: 72.5)
        let timeOnly = try XCTUnwrap(EVEdit.week(odd, changing: 0, departure: "08:00", minSocPct: 72.5))
        XCTAssertEqual(timeOnly["departure"]?["weeklyDepartures"]?.array?.first, ["day": 1, "departure": "08:00", "minSocPct": 72.5])
        // Tag leeren: ohne Abfahrt kein „zuhause ab“.
        let cleared = try XCTUnwrap(EVEdit.week(s.week, changing: 0, departure: "", minSocPct: nil))
        let first = try XCTUnwrap(cleared["departure"]?["weeklyDepartures"]?.array?.first)
        XCTAssertEqual(first["departure"]?.string, "")
        XCTAssertEqual(first["homeFrom"]?.string, "")
        XCTAssertNil(first["homeFromPrevDay"])
        XCTAssertEqual(first["minSocPct"], .null)
        XCTAssertNil(EVEdit.week(s.week, changing: 0, departure: "25:00", minSocPct: nil))
        XCTAssertNil(EVEdit.week(s.week, changing: 0, departure: "07:00", minSocPct: 140))
        XCTAssertNil(EVEdit.week(s.week, changing: 9, departure: "07:00", minSocPct: nil))
    }

    // MARK: Tarif

    private func price(_ iso: String, _ ct: Double, minutes: Double = 15, importCt: Double? = nil) -> PricePoint {
        PricePoint(start: date(iso), end: date(iso).addingTimeInterval(minutes * 60), ctKwh: ct, importCtKwh: importCt)
    }

    func testTariffJoinsBoxImportPriceAlsoAcrossDifferentGrids() throws {
        let market = [price("2026-11-14T10:00:00Z", 8), price("2026-11-14T10:15:00Z", 10), price("2026-11-14T11:00:00Z", -2), price("2026-11-14T12:00:00Z", 5)]
        // Die Box liefert hier Stunden; 12 Uhr fehlt ihr.
        let box = [price("2026-11-14T10:00:00Z", 9, minutes: 60, importCt: 30), price("2026-11-14T11:00:00Z", -2, minutes: 60, importCt: 22)]
        let pts = Tariff.points(market: market, box: box)
        XCTAssertEqual(pts.map(\.importCt), [30, 30, 22, nil])
        XCTAssertEqual(pts.map(\.exportCt), [8, 10, -2, 5])
        XCTAssertEqual(pts[2].spreadCt, 24)
        let st = try XCTUnwrap(Tariff.stats(pts))
        XCTAssertEqual(st.meanExportCt, (8 + 10 - 2) / 3.0, accuracy: 1e-9)
        XCTAssertEqual(st.meanImportCt, (30 + 30 + 22) / 3.0, accuracy: 1e-9)
        XCTAssertEqual(st.meanSpreadCt, st.meanImportCt - st.meanExportCt, accuracy: 1e-9)
        XCTAssertEqual(st.minSpread.start, date("2026-11-14T10:15:00Z"))
        XCTAssertEqual(st.maxSpread.start, date("2026-11-14T11:00:00Z"))
        // Ohne Bezugstarif keine Spanne — die Einspeisung bleibt.
        XCTAssertNil(Tariff.stats(Tariff.points(market: market, box: [])))
        XCTAssertEqual(Tariff.points(market: market, box: []).count, 4)
    }

    // MARK: Energiefluss: Richtung wie im Web-Leitstand

    /// dvhub/public/app.js updateFlowDiagram: grid = gridImportW − gridExportW (+ = Bezug),
    /// bat = −batteryPowerW (DVhub: + = Laden), house = selfConsumptionW.
    func testFlowDirectionsMatchTheWebControlRoom() throws {
        func edge(_ s: LiveStatus, _ n: FlowEdge.Node) -> FlowEdge { FlowEdge.edges(from: s).first { $0.node == n }! }
        func status(pv: Double, load: Double, bat: Double, imp: Double, exp: Double) -> LiveStatus {
            LiveStatus.from(["pvTotalW": .double(pv), "loadW": .double(load), "batteryPowerW": .double(bat), "gridImportW": .double(imp), "gridExportW": .double(exp)])!
        }
        // Mittags: PV 6 kW, Haus 1 kW, Akku lädt 2 kW, 3 kW gehen ins Netz.
        let noon = status(pv: 6000, load: 1000, bat: 2000, imp: 0, exp: 3000)
        XCTAssertTrue(edge(noon, .pv).towardHub)            // PV → Mitte
        XCTAssertFalse(edge(noon, .home).towardHub)         // Mitte → Haus (Verbrauch)
        XCTAssertEqual(edge(noon, .home).watts, 1000)
        XCTAssertFalse(edge(noon, .battery).towardHub)      // Mitte → Akku (lädt)
        XCTAssertFalse(edge(noon, .grid).towardHub)         // Mitte → Netz (Einspeisung)
        XCTAssertEqual(edge(noon, .grid).watts, 3000)
        XCTAssertEqual(edge(noon, .grid).sources, [.pv: 1])
        // Nachts: Haus 800 W, Akku entlädt 300 W, 500 W kommen aus dem Netz.
        let night = status(pv: 0, load: 800, bat: -300, imp: 500, exp: 0)
        XCTAssertTrue(edge(night, .grid).towardHub)         // Netz → Mitte (Bezug)
        XCTAssertEqual(edge(night, .grid).watts, 500)
        XCTAssertTrue(edge(night, .battery).towardHub)      // Akku → Mitte (entlädt)
        XCTAssertFalse(edge(night, .home).towardHub)
        XCTAssertEqual(edge(night, .home).sources[.grid] ?? 0, 500.0 / 800, accuracy: 1e-9)
        // Beide Zähler zugleich ungleich null: Es zählt netto, wie im Web.
        let both = status(pv: 4000, load: 1000, bat: 0, imp: 200, exp: 3200)
        XCTAssertFalse(edge(both, .grid).towardHub)
        XCTAssertEqual(edge(both, .grid).watts, 3000)
        XCTAssertNil(edge(both, .home).sources[.grid])      // kein Netzstrom im Haus, wenn netto eingespeist wird
    }

    // MARK: Tagesenergie

    func testDayEnergyIntegratesPowerAndFindsThePeak() throws {
        let t0 = date("2026-11-14T10:00:00Z")
        // Eine Stunde mit 1 kW in 5-Minuten-Werten, dann eine Spitze.
        var samples = (0..<12).map { (date: t0.addingTimeInterval(Double($0) * 300), watts: 1000.0) }
        samples.append((date: t0.addingTimeInterval(3600), watts: 6000))
        let e = try XCTUnwrap(DayEnergy.from(samples))
        XCTAssertEqual(e.kwh, 1.0 + 6.0 * 300 / 3600, accuracy: 1e-9)
        XCTAssertEqual(e.peakW, 6000)
        XCTAssertEqual(e.peakAt, t0.addingTimeInterval(3600))
        XCTAssertNil(DayEnergy.from([]))
    }

    func testDayEnergyDoesNotBridgeGapsOrCountNegativeValues() throws {
        let t0 = date("2026-11-14T10:00:00Z")
        // Zwei Stunden Lücke: der Wert davor zählt höchstens eine halbe Stunde.
        let gap = try XCTUnwrap(DayEnergy.from([(date: t0, watts: 2000), (date: t0.addingTimeInterval(7200), watts: 0)]))
        XCTAssertEqual(gap.kwh, 1.0, accuracy: 1e-9)
        let neg = try XCTUnwrap(DayEnergy.from([(date: t0, watts: -500), (date: t0.addingTimeInterval(300), watts: .nan), (date: t0.addingTimeInterval(600), watts: 1200)]))
        XCTAssertEqual(neg.kwh, 1200.0 * 600 / 3600 / 1000, accuracy: 1e-9)
        XCTAssertEqual(neg.peakW, 1200)
    }
}
