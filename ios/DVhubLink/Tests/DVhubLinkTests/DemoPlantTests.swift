// DemoPlantTests.swift — die Beispielanlage der Demo: plausible Werte rund um
// die Uhr, Energie bleibt erhalten, jede Ansicht rechnet denselben Tag gleich,
// Bedienen ändert den Zustand — und die Antworten liest derselbe Code, der die
// echte Box liest.

import XCTest
@testable import DVhubLink

func demoCalendar(_ zone: String = "Europe/Berlin") -> Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: zone)!
    return c
}

func demoDate(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 12, _ min: Int = 0, zone: String = "Europe/Berlin") -> Date {
    demoCalendar(zone).date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
}

final class DemoPlantTests: XCTestCase {
    /// Demo, gestartet an einem Dienstag im November.
    let start = demoDate(2026, 11, 24, 10)

    func plant(startedAt: Date? = nil, zone: String = "Europe/Berlin") -> DemoPlant {
        DemoPlant(state: .init(startedAt: startedAt ?? start), calendar: demoCalendar(zone))
    }

    // MARK: Plausible Werte

    func testLiveValuesArePlausibleAroundTheClock() throws {
        // Winter und Sommer, je zwei Tage in Schritten von 20 Minuten.
        for begin in [start, demoDate(2026, 6, 20, 9)] {
            let p = plant(startedAt: begin)
            var sawSun = false, sawCharging = false, sawDischarging = false
            for step in 0..<(2 * 72) {
                let now = p.world.calendar.startOfDay(for: begin).addingTimeInterval(Double(step) * 1200 + 7)
                let l = p.live(at: now)
                let hour = p.world.day(containing: now).hour(of: now)
                XCTAssert((DemoPlant.minSocPct - 0.01...100).contains(l.soc), "Ladestand \(l.soc) um \(hour)")
                XCTAssert((0...DemoPlant.kwp * 1000).contains(l.pvW), "PV \(l.pvW)")
                XCTAssertGreaterThan(l.loadW, 100, "Das Haus verbraucht immer etwas")
                XCTAssertLessThan(l.loadW, 16_000)
                if hour < 3 || hour > 23 { XCTAssertEqual(l.pvW, 0, "nachts keine Sonne (\(hour))") }
                // Mittags scheint die Sonne — es sei denn, der Negativpreis-Schutz regelt gerade ab.
                if hour > 12, hour < 13 { XCTAssert(l.pvW > 1500 || l.negativePriceActive, "mittags scheint die Sonne: \(l.pvW)"); sawSun = sawSun || l.pvW > 1500 }
                // Was hineingeht, kommt heraus.
                let inW = l.pvW + l.gridImportW + max(0, -l.batteryW), outW = l.loadW + l.gridExportW + max(0, l.batteryW)
                XCTAssertEqual(inW, outW, accuracy: 1, "Bilanz um \(hour)")
                XCTAssertLessThanOrEqual(l.gridExportW, DemoPlant.feedInLimitW + 1, "Einspeisegrenze")
                XCTAssertFalse(l.gridImportW > 30 && l.gridExportW > 30, "nicht zugleich beziehen und einspeisen")
                if l.batteryW > 200 { sawCharging = true }
                if l.batteryW < -200 { sawDischarging = true }
                // Die App liest den Kompakt-Status mit demselben Code wie von der Box.
                let s = try XCTUnwrap(LiveStatus.from(p.compactStatus(at: now)))
                XCTAssertEqual(s.soc ?? -1, l.soc, accuracy: 0.06)
                XCTAssertEqual(s.pvTotalW ?? -1, l.pvW, accuracy: 0.6)
                XCTAssertNotNil(s.todayNetEur)
                XCTAssertEqual(s.emergencyStop, false)
                XCTAssertEqual(s.alarmsActive, 0)
                XCTAssertNotNil(s.controls?.negativePrice?.protection)
            }
            XCTAssert(sawSun && sawCharging && sawDischarging, "Tag und Nacht, Laden und Entladen kommen vor")
        }
    }

    func testLiveMovesGentlyBetweenTicks() {
        let p = plant()
        let noon = demoDate(2026, 11, 24, 12, 20)
        let a = p.live(at: noon), b = p.live(at: noon.addingTimeInterval(2))
        XCTAssertNotEqual(a.pvW, b.pvW, "Werte bewegen sich")
        XCTAssertLessThan(abs(a.pvW - b.pvW), a.pvW * 0.03, "… aber leicht")
        XCTAssertLessThan(abs(a.loadW - b.loadW), max(150, a.loadW * 0.08))
    }

    func testEveryQuarterHourConservesEnergy() {
        let p = plant()
        for offset in [-200, -30, -1, 0, 1, 2, 170, 215] {
            let day = p.world.day(after: p.world.day(containing: start), by: offset)
            let run = p.run(day)
            XCTAssertEqual(run.slots.count, day.slotCount)
            var soc = run.slots[0].socStart
            for s in run.slots {
                XCTAssertEqual(s.pvKwh, s.solarToHomeKwh + s.solarToBatteryKwh + s.solarToGridKwh, accuracy: 1e-9, "Solar wird verteilt")
                XCTAssertEqual(s.loadKwh, s.solarToHomeKwh + s.batteryToHomeKwh + s.gridToHomeKwh, accuracy: 1e-9, "Verbrauch ist gedeckt")
                XCTAssertEqual(s.socStart, soc, accuracy: 1e-9, "Ladestand läuft durch")
                XCTAssert((DemoPlant.minSocPct - 0.01...100.0001).contains(s.socEnd))
                for v in [s.pvKwh, s.loadKwh, s.solarToGridKwh, s.batteryToHomeKwh, s.batteryToGridKwh, s.gridToHomeKwh, s.gridToBatteryKwh, s.curtailedKwh] {
                    XCTAssertGreaterThanOrEqual(v, 0)
                }
                if s.spotCt < 0 { XCTAssertEqual(s.exportKwh, 0, "bei negativem Preis wird nicht eingespeist") }
                XCTAssertEqual(s.importCt, DemoWorld.importCt(spot: s.spotCt), accuracy: 0.005)
                soc = s.socEnd
            }
        }
    }

    func testYearIsTypicalForTwentyKilowattPeak() {
        // 2025: lange vor dem Start der Demo — das übliche Wetter der Jahreszeiten.
        let p = plant()
        var months: [DemoPlant.Totals] = []
        for m in 1...12 {
            var t = DemoPlant.Totals()
            var day = p.world.day(containing: demoDate(2025, m, 1))
            while p.world.calendar.component(.month, from: day.start) == m {
                t.add(p.totals(p.run(day), until: .distantFuture))
                day = p.world.day(after: day)
            }
            months.append(t)
        }
        var year = DemoPlant.Totals()
        months.forEach { year.add($0) }
        XCTAssert((13_000...21_000).contains(year.pvKwh), "Jahresertrag \(year.pvKwh) kWh")
        XCTAssert((5000...10_000).contains(year.loadKwh), "Jahresverbrauch \(year.loadKwh) kWh")
        XCTAssertLessThan(year.importKwh, year.loadKwh * 0.35, "mit Akku meist aus eigener Erzeugung")
        XCTAssertGreaterThan(months[5].pvKwh, months[11].pvKwh * 2.5, "Juni bringt ein Vielfaches vom Dezember")
        XCTAssertGreaterThan(months[6].netEur, 0, "im Sommer verdient die Anlage")
        XCTAssertLessThan(months[0].netEur, 0, "im Januar kostet sie")
        let mean = year.meanSpotCt ?? 0
        XCTAssert((5...14).contains(mean), "Börsenpreis im Jahresmittel \(mean) ct")
        XCTAssert((100...900).contains(year.negativeSlots / 4), "Stunden mit negativem Preis: \(year.negativeSlots / 4)")
    }

    func testPricesHaveEveningPeakAndNegativeNoonOnDemoDays() {
        let p = plant()
        var negativeDays = 0
        for offset in 0..<6 {
            let day = p.world.day(after: p.world.day(containing: start), by: offset)
            let spots = p.run(day).slots.map(\.spotCt)
            let evening = spots[72..<80].max() ?? 0, night = spots[8..<16].max() ?? 0, noon = spots[48..<56].min() ?? 0
            XCTAssertGreaterThan(evening, night + 3, "Abendspitze")
            XCTAssertLessThan(noon, night, "Mittagstief")
            if noon < 0 { negativeDays += 1 }
            XCTAssertGreaterThan(spots.min() ?? 0, -13.01)
            XCTAssertLessThan(spots.max() ?? 0, 45)
        }
        XCTAssertGreaterThanOrEqual(negativeDays, 2, "negative Mittagspreise kommen vor")
        // Heute oder morgen ist einer dabei.
        let today = p.run(containing: start), tomorrow = p.run(p.world.day(after: today.day))
        XCTAssert((today.slots + tomorrow.slots).contains { $0.spotCt < 0 })
    }

    func testDemoDaysAreFriendlyAndHistoryIsNot() {
        let p = plant()
        let today = p.world.day(containing: start)
        for offset in -2...10 { XCTAssertGreaterThanOrEqual(p.world.day(after: today, by: offset).weather, 0.74) }
        let before = (3...60).map { p.world.day(after: today, by: -$0).weather }
        XCTAssertLessThan(before.min() ?? 1, 0.3, "vor der Demo gibt es auch graue Tage")
        XCTAssertGreaterThan(p.totals(p.run(today), until: .distantFuture).pvKwh, 20)
    }

    // MARK: Fest und überall gleich

    func testSameMomentGivesSameValuesEverywhere() {
        let a = plant(), b = plant()
        // b rechnet vorher ganz andere Tage (Historie) — das Ergebnis darf davon nicht abhängen.
        var warm = b
        _ = warm.respond("GET", "/api/history/summary?view=year&date=2026-11-24&lean=1", now: start)
        _ = warm.respond("GET", "/api/history/summary?view=month&date=2026-03-15&lean=1", now: start)
        for minutes in stride(from: 0, to: 48 * 60, by: 37) {
            let now = start.addingTimeInterval(Double(minutes) * 60)
            XCTAssertEqual(a.compactStatus(at: now), warm.compactStatus(at: now))
        }
        // Nach Speichern und Laden des Zustands ebenso.
        let data = try! JSONEncoder().encode(a.state)
        let restored = DemoPlant(state: try! JSONDecoder().decode(DemoPlant.State.self, from: data), calendar: demoCalendar())
        XCTAssertEqual(restored.compactStatus(at: start), a.compactStatus(at: start))
    }

    func testClockOfTheDeviceDrivesTheSun() {
        // In Kalifornien steht die Sonne der Demo nach der dortigen Uhr.
        let zone = "America/Los_Angeles"
        let p = plant(startedAt: demoDate(2026, 11, 24, 10, zone: zone), zone: zone)
        XCTAssertGreaterThan(p.live(at: demoDate(2026, 11, 24, 12, 30, zone: zone)).pvW, 1500)
        XCTAssertEqual(p.live(at: demoDate(2026, 11, 24, 23, 0, zone: zone)).pvW, 0)
    }

    // MARK: Die App liest die Antworten wie von der Box

    func get(_ p: inout DemoPlant, _ path: String, now: Date? = nil) -> JSONValue {
        let r = p.respond("GET", path, now: now ?? start)
        XCTAssertEqual(r.status, 200, path)
        return r.body
    }

    func testStatusReadsLikeTheBox() throws {
        var p = plant()
        let now = demoDate(2026, 11, 24, 12, 40)
        let status = get(&p, "/api/status", now: now)
        let d = try XCTUnwrap(StatusDetail.from(status: status))
        let l = p.live(at: now)
        XCTAssertEqual(d.pvTotalW ?? -1, l.pvW, accuracy: 0.6)
        XCTAssertEqual((d.pvDcW ?? 0) + (d.pvAcW ?? 0), d.pvTotalW ?? -1, accuracy: 1.1)
        XCTAssertEqual(d.pvAcPhasesW.count, 3)
        XCTAssertEqual(d.gridPhasesW.count, 3)
        XCTAssertEqual(d.gridPositiveMeans, "grid_import")
        XCTAssertEqual(d.gridVoltagesV.count, 3)
        XCTAssertEqual(d.timeZone, "Europe/Berlin")
        XCTAssertEqual(d.emergencyStop, false)
        XCTAssertNotNil(d.activeSetpointW)
        XCTAssertNotNil(d.spotNowCtKwh)
        XCTAssertEqual(d.importPriceNowCtKwh ?? -1, DemoWorld.importCt(spot: d.spotNowCtKwh ?? 0), accuracy: 0.011)
        XCTAssertEqual((d.solarDirectUseW ?? 0) + (d.solarToBatteryW ?? 0) + (d.solarToGridW ?? 0), d.pvTotalW ?? -1, accuracy: 2)
        // Preise für heute und morgen, je Viertelstunde mit eigenem Bezugspreis.
        XCTAssertEqual(d.prices.count, 192)
        XCTAssert(d.prices.allSatisfy { $0.importCtKwh != nil && $0.end.timeIntervalSince($0.start) == 900 })
        XCTAssertNotNil(PriceSeries.current(d.prices, at: now)?.importCtKwh)
        XCTAssertEqual(status["userEnergyPricing"]?["mode"]?.string, "dynamic")
        XCTAssertEqual(status["epex"]?["ok"]?.bool, true)
    }

    func testSeriesFeedsTheDashboardCards() throws {
        var p = plant()
        let now = demoDate(2026, 11, 24, 15, 5)
        let dayStart = demoDate(2026, 11, 24, 0), dayEnd = demoDate(2026, 11, 25, 0)
        let iso = ISO8601DateFormatter()
        let path = "/api/telemetry/series?keys=pv_total_w,load_power_w,grid_import_w,grid_export_w,battery_power_w,battery_soc_pct"
            + "&start=\(iso.string(from: dayStart))&end=\(iso.string(from: dayEnd))&maxResolution=300"
        let body = get(&p, path.replacingOccurrences(of: ":", with: "%3A"), now: now)
        let rows = try XCTUnwrap(body["data"]?.array)
        XCTAssertEqual(body["ok"]?.bool, true)
        // Bis jetzt: 61 Viertelstunden mal sechs Reihen.
        XCTAssertEqual(rows.count, 61 * 6)
        let pv = rows.filter { $0["key"]?.string == "pv_total_w" }.compactMap { r in
            parseISODate(r["ts"]?.string).flatMap { d in r["value"]?.number.map { (date: d, watts: $0) } }
        }
        XCTAssertEqual(pv.count, 61)
        XCTAssert(pv.allSatisfy { $0.date >= dayStart && $0.date <= now })
        let energy = try XCTUnwrap(DayEnergy.from(pv))
        XCTAssert((10...60).contains(energy.kwh), "Erzeugung bis 15 Uhr: \(energy.kwh) kWh")
        // Passt zur Tages-Historie (dieselben Viertelstunden).
        let kpi = try XCTUnwrap(get(&p, "/api/history/summary?view=day&date=2026-11-24&lean=1", now: now)["kpis"]?["pvKwh"]?.number)
        XCTAssertEqual(energy.kwh, kpi, accuracy: kpi * 0.05)
        let soc = rows.filter { $0["key"]?.string == "battery_soc_pct" }.compactMap { $0["value"]?.number }
        XCTAssert(soc.allSatisfy { (9.9...100).contains($0) })
    }

    func testHistoryViewsAgreeWithEachOtherAndWithNow() throws {
        var p = plant()
        let now = demoDate(2026, 11, 24, 16, 20)
        func summary(_ view: HistoryPeriod, _ date: String) throws -> HistorySummary {
            let body = get(&p, "/api/history/summary?view=\(view.rawValue)&date=\(date)&lean=1", now: now)
            return try XCTUnwrap(HistorySummary.from(body, view: view, date: date))
        }
        let keys = ["pvKwh", "loadKwh", "importKwh", "exportKwh", "netEur", "batteryChargeKwh", "batteryDischargeKwh", "exportRevenueEur", "gridCostEur"]

        // Heute: Summe der Viertelstunden = Kennzahl = Live-Stand.
        let today = try summary(.day, "2026-11-24")
        XCTAssertEqual(today.rows.count, 66, "bis 16:20 sind 66 Viertelstunden begonnen")
        XCTAssertEqual(today.rows.reduce(0) { $0 + $1.value("pvKwh") }, today.kpi("pvKwh") ?? -1, accuracy: 0.01)
        XCTAssertEqual(today.dayPrices.count, 66)
        XCTAssert(today.dayPrices.allSatisfy { $0.values["marketPriceCtKwh"] != nil && $0.values["userImportPriceCtKwh"] != nil })
        let live = p.live(at: now)
        XCTAssertEqual(today.netEur, live.today.netEur, accuracy: 0.001)
        XCTAssertEqual(today.kpi("pvKwh") ?? -1, live.today.pvKwh, accuracy: 0.001)
        let status = try XCTUnwrap(StatusDetail.from(status: get(&p, "/api/status", now: now)))
        XCTAssertEqual(status.netEur ?? -99, today.netEur, accuracy: 0.006)
        XCTAssert((0...100).contains(today.autarkyPct ?? -1))
        XCTAssert((0...100).contains(today.selfUsePct ?? -1))
        // Energieflüsse je Viertelstunde für den Markt.
        let slots = EnergyDay.slots(today, from: demoDate(2026, 11, 24, 0), to: demoDate(2026, 11, 25, 0), now: now)
        XCTAssertEqual(slots.count, 66)
        XCTAssert(EnergyDay.hasFlows(slots))
        XCTAssertEqual(EnergyDay.totals(slots).solarKwh, today.kpi("pvKwh") ?? -1, accuracy: 0.02)

        // Woche: Zeile eines Tages = Tagesansicht dieses Tages; Summe der Zeilen = Kennzahl.
        let week = try summary(.week, "2026-11-24")
        XCTAssertEqual(week.rows.map(\.key), ["2026-11-23", "2026-11-24"], "Montag bis heute")
        let monday = try summary(.day, "2026-11-23")
        XCTAssertEqual(monday.rows.count, 96)
        for k in keys {
            XCTAssertEqual(week.rows[0].value(k), monday.kpi(k) ?? -99, accuracy: 0.002, k)
            XCTAssertEqual(week.rows.reduce(0) { $0 + $1.value(k) }, week.kpi(k) ?? -99, accuracy: 0.01, k)
        }
        // Vergangene Woche: sieben volle Tage.
        XCTAssertEqual(try summary(.week, "2026-11-18").rows.count, 7)

        // Monat und Jahr.
        let month = try summary(.month, "2026-11-24")
        XCTAssertEqual(month.rows.count, 24)
        XCTAssertEqual(month.rows.last?.key, "2026-11-24")
        XCTAssertEqual(month.rows[22].value("pvKwh"), monday.kpi("pvKwh") ?? -1, accuracy: 0.002)
        let year = try summary(.year, "2026-11-24")
        XCTAssertEqual(year.rows.map(\.key), (1...11).map { String(format: "2026-%02d", $0) })
        XCTAssertEqual(year.rows[10].value("pvKwh"), month.kpi("pvKwh") ?? -1, accuracy: 0.02)
        XCTAssertNotNil(HistorySummary.localDate(year.rows[0].key))
        XCTAssertEqual(try summary(.year, "2025-06-01").rows.count, 12)
        XCTAssertGreaterThan(year.kpi("pvKwh") ?? 0, 10_000)
    }

    func testPlanScheduleAndIntegrationsHaveContent() throws {
        var p = plant()
        let now = demoDate(2026, 11, 24, 10, 0)
        let plan = get(&p, "/api/eos/plan?rows=192", now: now)
        XCTAssertEqual(plan["available"]?.bool, true)
        let rows = try XCTUnwrap(plan["output"]?["rows"]?.array)
        XCTAssertEqual(rows.count, 192)
        XCTAssertEqual(parseISODate(rows[0]["ts_utc"]?.string), now, "der Plan beginnt mit der laufenden Viertelstunde")
        XCTAssert(rows.allSatisfy { r in (0...100).contains(r["socPct"]?.number ?? -1) && r["priceCtKwh"]?.number != nil })
        XCTAssert(rows.contains { $0["zeitplanLabel"]?.string != nil }, "der Plan gibt etwas vor")
        // Über Mitternacht läuft der Ladestand ohne Sprung weiter.
        let soc = rows.compactMap { $0["socPct"]?.number }
        for (a, b) in zip(soc, soc.dropFirst()) { XCTAssertLessThan(abs(a - b), 14, "Sprung im geplanten Ladestand") }
        XCTAssertNotNil(parseISODate(plan["plan"]?["fetchedAt"]?.string))

        let schedule = get(&p, "/api/schedule", now: now)
        let rules = ScheduleEdit.rules(from: schedule)
        XCTAssert(rules.contains { !$0.isAutomation && $0.isEditable }, "eine Regel von Hand")
        XCTAssert(rules.contains { $0.isAutomation && $0.canToggle }, "eine Regel aus dem Plan")
        XCTAssertNotNil(schedule["active"]?["gridSetpointW"]?["value"]?.number)
        XCTAssertNotNil(schedule["config"]?["defaultGridSetpointW"]?.number)
        XCTAssertEqual(get(&p, "/api/schedule/automation/config", now: now)["config"]?["enabled"]?.bool, false)

        for path in ["/api/integrations/health", "/api/integrations/dataflow", "/api/eos/status", "/api/vpn/status", "/api/devices",
                     "/api/victron/devices", "/api/feed-in-cap/status", "/api/storage/status", "/api/mobile-link/integrations", "/api/costs"] {
            let body = get(&p, path, now: now)
            XCTAssert(body.object?.isEmpty == false || body.array?.isEmpty == false, path)
            // Nichts, was nach einer Adresse im Heimnetz aussieht.
            let text = String(data: try body.encoded(), encoding: .utf8) ?? ""
            XCTAssertNil(text.range(of: #"\b\d{1,3}(\.\d{1,3}){3}\b|://"#, options: .regularExpression), "\(path): \(text.prefix(200))")
        }
        XCTAssertEqual(p.respond("GET", "/api/config", now: now).status, 404, "was die Box der App nicht gibt, gibt die Demo auch nicht")
    }

    // MARK: Bedienen

    func post(_ p: inout DemoPlant, _ path: String, _ body: JSONValue, now: Date? = nil) -> LinkResponse {
        p.respond("POST", path, body: body, now: now ?? start)
    }

    func testEmergencyStopChangesStateAndLeavesAMessage() throws {
        var p = plant()
        let before = p.mailbox().count
        XCTAssertEqual(ControlOutcome.from(post(&p, "/api/control/stop", [:])), .done)
        XCTAssertEqual(LiveStatus.from(p.compactStatus(at: start))?.emergencyStop, true)
        XCTAssertEqual(StatusDetail.from(status: get(&p, "/api/status"))?.emergencyStop, true)
        XCTAssertEqual(get(&p, "/api/integrations/dataflow")["out"]?["control"]?["paused"]?.bool, true)
        // Zweimal auslösen: kein zweiter Eintrag.
        _ = post(&p, "/api/control/stop", [:])
        XCTAssertEqual(p.mailbox().count, before + 1)
        var box = MailboxState()
        _ = box.merge(p.mailbox())
        XCTAssertEqual(box.events.first?.emergencyStop, true, "die jüngste Meldung ist der Not-Halt")
        XCTAssertEqual(ControlOutcome.from(post(&p, "/api/control/resume", [:], now: start.addingTimeInterval(30))), .done)
        XCTAssertEqual(LiveStatus.from(p.compactStatus(at: start))?.emergencyStop, false)
        _ = box.merge(p.mailbox())
        XCTAssertEqual(box.events.first?.emergencyStop, false)
        XCTAssertEqual(box.events.count, before + 2)
    }

    func testScheduleRulesCanBeAddedChangedAndRemovedLikeOnTheBox() throws {
        var p = plant()
        let now = demoDate(2026, 11, 24, 16, 30)
        // Anlegen — mit demselben Aufbau, den die App für die Box nutzt.
        let draft = ScheduleEdit.Draft(target: "gridSetpointW", start: "16:00", end: "18:00", value: -3000)
        let add = try ScheduleEdit.payload(schedule: get(&p, "/api/schedule", now: now), change: .add(draft), newId: { "app-test" }).get()
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/schedule/rules", add, now: now)), .done)
        var rules = ScheduleEdit.rules(from: get(&p, "/api/schedule", now: now))
        let mine = try XCTUnwrap(rules.first { $0.ruleId == "app-test" })
        XCTAssertEqual(mine.value, -3000)
        XCTAssertEqual(rules.filter { !$0.isAutomation }.count, 2, "die vorhandene Regel bleibt")

        // Die Regel gilt jetzt: DVhub regelt auf 3 kW Einspeisung, der Akku gleicht aus.
        let l = p.live(at: now)
        XCTAssertEqual(l.gridSetpointW, -3000)
        XCTAssertEqual(l.setpointSource, "manual")
        XCTAssertEqual(l.gridExportW - l.gridImportW, 3000, accuracy: 5)
        XCTAssertEqual(get(&p, "/api/schedule", now: now)["active"]?["gridSetpointW"]?["value"]?.number, -3000)

        // Ändern und ausschalten.
        var changed = draft
        changed.value = -1500
        let update = try ScheduleEdit.payload(schedule: get(&p, "/api/schedule", now: now), change: .update(mine, changed)).get()
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/schedule/rules", update, now: now)), .done)
        XCTAssertEqual(p.live(at: now).gridSetpointW, -1500)
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/schedule/rules/toggle", ["ids": ["app-test"], "enabled": false], now: now)), .done)
        XCTAssertEqual(p.live(at: now).setpointSource, "default")

        // Regel aus dem Plan umschalten.
        let planned = try XCTUnwrap(ScheduleEdit.rules(from: get(&p, "/api/schedule", now: now)).first { $0.isAutomation })
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/schedule/rules/toggle", ["ids": [.string(planned.ruleId ?? "")], "enabled": false], now: now)), .done)
        rules = ScheduleEdit.rules(from: get(&p, "/api/schedule", now: now))
        XCTAssertEqual(rules.first { $0.ruleId == planned.ruleId }?.enabled, false)
        XCTAssertEqual(post(&p, "/api/schedule/rules/toggle", ["ids": ["gibt-es-nicht"], "enabled": true], now: now).status, 404)

        // Löschen.
        let current = try XCTUnwrap(rules.first { $0.ruleId == "app-test" })
        let remove = try ScheduleEdit.payload(schedule: get(&p, "/api/schedule", now: now), change: .remove(current)).get()
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/schedule/rules", remove, now: now)), .done)
        XCTAssertNil(ScheduleEdit.rules(from: get(&p, "/api/schedule", now: now)).first { $0.ruleId == "app-test" })
        // Unbrauchbares lehnt die Demo ab wie die Box.
        XCTAssertEqual(post(&p, "/api/schedule/rules", ["rules": [["value": 1]]], now: now).status, 400)
    }

    func testDefaultsAndMarketAutomation() throws {
        var p = plant()
        let now = demoDate(2026, 11, 24, 13, 0)
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/schedule/config", ["defaultGridSetpointW": -120, "defaultChargeCurrentA": 50], now: now)), .done)
        let cfg = get(&p, "/api/schedule", now: now)["config"]
        XCTAssertEqual(cfg?["defaultGridSetpointW"]?.number, -120)
        XCTAssertEqual(cfg?["defaultChargeCurrentA"]?.number, 50)
        XCTAssertEqual(post(&p, "/api/schedule/config", ["defaultGridSetpointW": "viel"], now: now).status, 400)

        // Ausgeschaltet plant die Automatik nichts.
        XCTAssertEqual(post(&p, "/api/schedule/automation/replan", [:], now: now).body["generatedRuleCount"]?.number, 0)
        XCTAssertEqual(post(&p, "/api/schedule/automation/config", ["location": ["latitude": 1]], now: now).status, 400, "nur benannte Felder")
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/schedule/automation/config", ["enabled": true, "minSocPct": 30], now: now)), .done)
        let view = get(&p, "/api/schedule/automation/config", now: now)
        XCTAssertEqual(view["config"]?["enabled"]?.bool, true)
        XCTAssertEqual(view["config"]?["minSocPct"]?.number, 30)
        let replan = post(&p, "/api/schedule/automation/replan", [:], now: now)
        let n = Int(replan.body["generatedRuleCount"]?.number ?? 0)
        XCTAssertGreaterThan(n, 0)
        let schedule = get(&p, "/api/schedule", now: now)
        let made = ScheduleEdit.rules(from: schedule).filter { $0.source == "small_market_automation" }
        XCTAssertEqual(made.count, n)
        XCTAssert(made.allSatisfy { $0.isAutomation && ($0.value ?? 0) < 0 && $0.stopSocPct == 30 })
        XCTAssertEqual(schedule["smallMarketAutomation"]?["generatedRuleCount"]?.number, Double(n))
        // Ausschalten räumt die Regeln ab.
        _ = post(&p, "/api/schedule/automation/config", ["enabled": false], now: now)
        XCTAssert(ScheduleEdit.rules(from: get(&p, "/api/schedule", now: now)).allSatisfy { $0.source != "small_market_automation" })
    }

    func testCarPlanningWeekPlanAndChargeNow() throws {
        var p = plant()
        // Dienstag 15 Uhr: Das Auto steht angesteckt zuhause.
        let now = demoDate(2026, 11, 24, 15, 0)
        var ev = try XCTUnwrap(EVState.from(get(&p, "/api/ev", now: now)))
        XCTAssertEqual(ev.vehicle.plugged, true)
        XCTAssertEqual(ev.vehicle.charging, false)
        XCTAssertEqual(ev.week.count, 7)
        XCTAssertEqual(ev.nextDeparture, demoDate(2026, 11, 25, 7, 0), "nächste Abfahrt: Mittwoch 07:00")
        XCTAssertEqual(ev.nextSource, "weekly")
        XCTAssertNotNil(ev.overrideLimits)
        XCTAssert((10...100).contains(ev.vehicle.socPct ?? 0))

        // Planung ändern (ein Körper, wie die App ihn zusammenlegt).
        let body = EVEdit.merge([EVEdit.optimize(false), try XCTUnwrap(EVEdit.minSoc(70)), try XCTUnwrap(EVEdit.maxSoc(nil))])
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/ev", body, now: now)), .done)
        ev = try XCTUnwrap(EVState.from(get(&p, "/api/ev", now: now)))
        XCTAssertEqual(ev.optimizeEv, false)
        XCTAssertEqual(ev.defaultMinSocPct, 70)
        XCTAssertNil(ev.maxSocPct)
        XCTAssertNil(ev.planEnergyKwh, "ohne Planung kein Plan")

        // Einmal-Ziel: zu knapp lehnt die Demo ab wie die Box; morgen früh geht.
        let soon = try XCTUnwrap(EVEdit.once(at: now.addingTimeInterval(600), minSocPct: 90, now: now))
        XCTAssertEqual(post(&p, "/api/ev", soon, now: now).status, 400)
        let once = demoDate(2026, 11, 25, 5, 30)
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/ev", try XCTUnwrap(EVEdit.once(at: once, minSocPct: 90, now: now)), now: now)), .done)
        ev = try XCTUnwrap(EVState.from(get(&p, "/api/ev", now: now)))
        XCTAssertEqual(ev.once, once)
        XCTAssertEqual(ev.nextSource, "once")
        XCTAssertEqual(ev.nextTargetSocPct, 90)
        // Ist der Termin vorbei, gilt wieder der Wochenplan.
        XCTAssertEqual(EVState.from(get(&p, "/api/ev", now: once.addingTimeInterval(60)))?.nextSource, "weekly")
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/ev", EVEdit.clearOnce(), now: now)), .done)

        // Wochenplan: Samstag 09:00 anlegen, ändern, löschen — mit dem Aufbau der App.
        ev = try XCTUnwrap(EVState.from(get(&p, "/api/ev", now: now)))
        let add = try EVEdit.weekPlan(ev.week, change: .add(.init(day: 6, departure: "9:00", minSocPct: 95, homeFrom: "20:00"))).get()
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/ev", add, now: now)), .done)
        ev = try XCTUnwrap(EVState.from(get(&p, "/api/ev", now: now)))
        XCTAssertEqual(ev.week.count, 7, "die leere Zeile des Samstags ist ersetzt")
        let saturday = try XCTUnwrap(ev.week.first { $0.day == 6 })
        XCTAssertEqual(saturday.departure, "09:00")
        XCTAssertEqual(saturday.minSocPct, 95)
        XCTAssertEqual(saturday.homeFromPrevDay, true, "20:00 liegt nicht vor 09:00 → am Vortag")
        let second = try EVEdit.weekPlan(ev.week, change: .add(.init(day: 6, departure: "18:30"))).get()
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/ev", second, now: now)), .done)
        ev = try XCTUnwrap(EVState.from(get(&p, "/api/ev", now: now)))
        XCTAssertEqual(ev.week.filter { $0.day == 6 }.map(\.departure), ["09:00", "18:30"], "nach Uhrzeit geordnet")
        let remove = try EVEdit.weekPlan(ev.week, change: .remove(index: try XCTUnwrap(ev.week.first { $0.departure == "18:30" }).index)).get()
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/ev", remove, now: now)), .done)
        XCTAssertEqual(EVState.from(get(&p, "/api/ev", now: now))?.week.filter { $0.day == 6 }.count, 1)
        XCTAssertEqual(post(&p, "/api/ev", ["departure": ["weeklyDepartures": [["day": 9, "departure": "07:00"]]]], now: now).status, 400)
        XCTAssertEqual(post(&p, "/api/ev", [:], now: now).status, 400)

        // Sofort laden: Die Wallbox lädt, das Haus zieht entsprechend mehr.
        let idle = p.live(at: now)
        let charge = post(&p, "/api/ev/override", try XCTUnwrap(EVEdit.chargeNow(powerW: 20_000, durationMin: 60)), now: now)
        XCTAssertEqual(OverrideOutcome.from(charge, action: .charge), .done(.charge, powerW: 11_000), "auf die Grenze der Wallbox begrenzt")
        ev = try XCTUnwrap(EVState.from(get(&p, "/api/ev", now: now.addingTimeInterval(600))))
        XCTAssertEqual(ev.override?.stop, false)
        XCTAssertEqual(ev.override?.until, now.addingTimeInterval(3600))
        XCTAssertEqual(ev.vehicle.charging, true)
        XCTAssertEqual(ev.vehicle.chargePowerW, 11_000)
        let busy = p.live(at: now)
        XCTAssertEqual(busy.loadW - idle.loadW, 11_000, accuracy: 1)
        XCTAssertEqual(busy.evW, 11_000)
        XCTAssertEqual(get(&p, "/api/victron/devices", now: now)["devices"]?.array?.first?["charging"]?.bool, true)
        // Nach einer Stunde endet es von selbst.
        XCTAssertNil(EVState.from(get(&p, "/api/ev", now: now.addingTimeInterval(3601)))?.override)

        // Laden stoppen und beenden.
        XCTAssertEqual(OverrideOutcome.from(post(&p, "/api/ev/override", try XCTUnwrap(EVEdit.stopCharging(durationMin: nil)), now: now), action: .stop), .done(.stop, powerW: nil))
        XCTAssertEqual(EVState.from(get(&p, "/api/ev", now: now))?.override?.stop, true)
        XCTAssertEqual(OverrideOutcome.from(p.respond("DELETE", "/api/ev/override", now: now), action: .end), .done(.end, powerW: nil))
        XCTAssertNil(EVState.from(get(&p, "/api/ev", now: now))?.override)
        XCTAssertEqual(post(&p, "/api/ev/override", ["kind": "charge", "powerW": 0], now: now).status, 400)

        // Im Not-Halt: gespeichert, wirkt aber nicht; „Laden stoppen“ bleibt stehen.
        _ = post(&p, "/api/control/stop", [:], now: now)
        let paused = post(&p, "/api/ev/override", try XCTUnwrap(EVEdit.chargeNow(powerW: 11_000, durationMin: nil)), now: now)
        XCTAssertEqual(OverrideOutcome.from(paused, action: .charge), .savedButPaused(.charge))
        XCTAssertEqual(p.vehicle(at: now.addingTimeInterval(60)).charging, false)
        _ = post(&p, "/api/ev/override", try XCTUnwrap(EVEdit.stopCharging(durationMin: nil)), now: now)
        XCTAssertEqual(OverrideOutcome.from(p.respond("DELETE", "/api/ev/override", now: now), action: .end), .keptByEmergencyStop)
    }

    func testCarFollowsItsWeek() {
        let p = plant()
        // Werktag 07:30: unterwegs. 12:00 an einem sonnigen Werktag: lädt aus der Sonne.
        XCTAssertEqual(p.vehicle(at: demoDate(2026, 11, 25, 7, 30)).plugged, false)
        let noon = p.vehicle(at: demoDate(2026, 11, 25, 12, 0))
        XCTAssertEqual(noon.charging, true)
        XCTAssertEqual(noon.chargePowerW, 4200)
        // Abends wieder beim Ziel; am Wochenende steht es.
        XCTAssertEqual(p.vehicle(at: demoDate(2026, 11, 25, 20, 0)).socPct, 80, accuracy: 0.01)
        let saturday = p.vehicle(at: demoDate(2026, 11, 28, 7, 30))
        XCTAssertEqual(saturday.plugged, true)
        XCTAssertEqual(saturday.charging, false)
    }

    // MARK: Gegenprüfung 664f3a2c — Bedienen wirkt, Zeiten stimmen, Tage schließen aneinander an

    func testChangedDefaultSetpointMovesTheFlow() {
        var p = plant()
        let now = demoDate(2026, 11, 24, 16, 30)
        XCTAssertEqual(p.live(at: now).gridImportW, 0, accuracy: 1, "ab Werk: Eigenverbrauch, der Akku deckt das Haus")
        XCTAssertEqual(WriteOutcome.from(post(&p, "/api/schedule/config", ["defaultGridSetpointW": 3000], now: now)), .done)
        let l = p.live(at: now)
        XCTAssertEqual(l.gridSetpointW, 3000)
        XCTAssertEqual(l.setpointSource, "default")
        XCTAssertEqual(l.gridImportW - l.gridExportW, 3000, accuracy: 5, "DVhub regelt auf den neuen Grundwert")
        XCTAssertGreaterThan(l.batteryW, 1000, "der Akku lädt dabei aus dem Netz")
        // Im Not-Halt schreibt DVhub nichts: wieder schlichter Eigenverbrauch.
        _ = post(&p, "/api/control/stop", [:], now: now)
        XCTAssertEqual(p.live(at: now).gridImportW, 0, accuracy: 1)
    }

    func testChargeCurrentLimitsHowFastTheBatteryCharges() throws {
        var p = plant()
        // 11:15: Die Sonne lädt den Akku kräftig, der Börsenpreis ist positiv.
        let now = demoDate(2026, 11, 24, 11, 15)
        let free = p.live(at: now)
        XCTAssertGreaterThan(free.batteryW, 3000)
        // Regel von Hand: 20 A ≈ 1 kW.
        let draft = ScheduleEdit.Draft(target: "chargeCurrentA", start: "10:00", end: "12:00", value: 20)
        _ = post(&p, "/api/schedule/rules", try ScheduleEdit.payload(schedule: get(&p, "/api/schedule", now: now), change: .add(draft)).get(), now: now)
        let limited = p.live(at: now)
        XCTAssertEqual(limited.batteryW, 20 * 52, accuracy: 2)
        XCTAssertEqual(limited.gridExportW, free.gridExportW + free.batteryW - limited.batteryW, accuracy: 2, "der Rest geht ins Netz")
        XCTAssertEqual(get(&p, "/api/schedule", now: now)["active"]?["chargeCurrentA"]?["value"]?.number, 20)
        // Außerhalb der Regel gilt der Grundwert — auf null gestellt, lädt der Akku gar nicht.
        let later = demoDate(2026, 11, 24, 12, 30)
        XCTAssertGreaterThan(p.live(at: later).batteryW, 1000)
        _ = post(&p, "/api/schedule/config", ["defaultChargeCurrentA": 0], now: later)
        XCTAssertLessThanOrEqual(p.live(at: later).batteryW, 0.5)
    }

    func testStopSocRuleStaysOffOnceTheBatteryFellBelow() throws {
        var p = plant()
        let morning = demoDate(2026, 11, 24, 9, 5)
        let draft = ScheduleEdit.Draft(target: "gridSetpointW", start: "09:00", end: "17:00", value: -2000, stopSocPct: 50)
        let add = try ScheduleEdit.payload(schedule: get(&p, "/api/schedule", now: demoDate(2026, 11, 24, 8, 0)), change: .add(draft), newId: { "app-stopp" }).get()
        _ = post(&p, "/api/schedule/rules", add, now: demoDate(2026, 11, 24, 8, 0))
        XCTAssertLessThan(p.live(at: morning).soc, 50)
        // Um 09:05 liegt der Akku unter dem Stopp-Stand: Die Regel schaltet sich ab …
        var rule = try XCTUnwrap(ScheduleEdit.rules(from: get(&p, "/api/schedule", now: morning)).first { $0.ruleId == "app-stopp" })
        XCTAssertFalse(rule.enabled)
        XCTAssertEqual(p.live(at: morning).setpointSource, "default")
        // … und bleibt aus, auch wenn er am Nachmittag wieder voll ist.
        let afternoon = demoDate(2026, 11, 24, 15, 30)
        XCTAssertGreaterThan(p.live(at: afternoon).soc, 50)
        rule = try XCTUnwrap(ScheduleEdit.rules(from: get(&p, "/api/schedule", now: afternoon)).first { $0.ruleId == "app-stopp" })
        XCTAssertFalse(rule.enabled)
        XCTAssertEqual(p.live(at: afternoon).setpointSource, "default")
        // Über dem Stopp-Stand angelegt, gilt eine solche Regel.
        var q = plant()
        _ = post(&q, "/api/schedule/rules", add, now: afternoon)
        XCTAssertEqual(q.live(at: afternoon).setpointSource, "manual")
        XCTAssertEqual(ScheduleEdit.rules(from: get(&q, "/api/schedule", now: afternoon)).first { $0.ruleId == "app-stopp" }?.enabled, true)
    }

    func testChargeNowCountsOnlyTimeItReallyCharged() throws {
        // Im Not-Halt gespeichert: Es lädt nichts — auch nicht rückwirkend nach dem Aufheben.
        var p = plant()
        let three = demoDate(2026, 11, 24, 15, 0), four = demoDate(2026, 11, 24, 16, 0)
        _ = post(&p, "/api/control/stop", [:], now: three)
        _ = post(&p, "/api/ev/override", try XCTUnwrap(EVEdit.chargeNow(powerW: 11_000, durationMin: nil)), now: three)
        XCTAssertEqual(p.vehicle(at: four).socPct, 80, accuracy: 0.01)
        _ = post(&p, "/api/control/resume", [:], now: four)
        XCTAssertEqual(p.vehicle(at: four).socPct, 80, accuracy: 0.01, "kein Sprung beim Aufheben")
        XCTAssertEqual(p.vehicle(at: four.addingTimeInterval(1800)).socPct, 80 + 11.0 * 0.5 / 60 * 100, accuracy: 0.05, "ab jetzt lädt es")

        // Unterwegs (Werktag 07:00–08:30) lädt es nicht.
        var q = plant()
        let early = demoDate(2026, 11, 25, 6, 30)
        _ = post(&q, "/api/ev/override", try XCTUnwrap(EVEdit.chargeNow(powerW: 11_000, durationMin: nil)), now: early)
        let halfHour = 11.0 * 0.5 / 60 * 100
        XCTAssertEqual(q.vehicle(at: demoDate(2026, 11, 25, 7, 0)).socPct, 80 + halfHour, accuracy: 0.05)
        let back = q.vehicle(at: demoDate(2026, 11, 25, 8, 30))
        XCTAssertEqual(back.socPct, 80 - DemoWorld.evTripPct + halfHour, accuracy: 0.05, "die Fahrt kostet, geladen wurde unterwegs nichts")
        // Beendet: Was geladen ist, bleibt im Auto — bis zur nächsten Fahrt.
        let nine = demoDate(2026, 11, 25, 9, 0)
        let before = q.vehicle(at: nine).socPct
        XCTAssertEqual(OverrideOutcome.from(q.respond("DELETE", "/api/ev/override", now: nine), action: .end), .done(.end, powerW: nil))
        XCTAssertEqual(q.vehicle(at: nine.addingTimeInterval(60)).socPct, before, accuracy: 0.01, "kein Rücksprung beim Beenden")
        XCTAssertFalse(q.vehicle(at: nine.addingTimeInterval(60)).charging)
        XCTAssertEqual(q.vehicle(at: demoDate(2026, 11, 26, 8, 30)).socPct, 80 - DemoWorld.evTripPct, accuracy: 0.01, "nach der nächsten Fahrt gilt wieder der Plan")
        // Voll ist voll.
        var r = plant()
        _ = post(&r, "/api/ev/override", try XCTUnwrap(EVEdit.chargeNow(powerW: 11_000, durationMin: nil)), now: three)
        let full = r.vehicle(at: three.addingTimeInterval(4 * 3600))
        XCTAssertEqual(full.socPct, 100)
        XCTAssertFalse(full.charging)
    }

    func testTimesFollowTheWallClockOnDaylightSavingDays() throws {
        // Sonntag, 29.03.2026: Um 02:00 springt die Uhr in Berlin auf 03:00 — der Tag hat 23 Stunden.
        var p = plant(startedAt: demoDate(2026, 3, 27, 10))
        let sunday = p.world.day(containing: demoDate(2026, 3, 29, 12))
        XCTAssertEqual(sunday.slotCount, 92)
        XCTAssertEqual(p.run(sunday).slots.count, 92)
        XCTAssertEqual(sunday.hour(of: demoDate(2026, 3, 29, 18, 30)), 18.5, accuracy: 1e-9)
        XCTAssertEqual(sunday.date(atHour: 7), demoDate(2026, 3, 29, 7, 0))
        XCTAssertEqual(sunday.clock(of: demoDate(2026, 3, 29, 18, 30)), "18:30")
        // Abfahrt am Sonntag um 07:00 ist 07:00 an der Wand.
        let saturday = demoDate(2026, 3, 28, 20, 0)
        let week = try XCTUnwrap(EVState.from(get(&p, "/api/ev", now: saturday))).week
        _ = post(&p, "/api/ev", try EVEdit.weekPlan(week, change: .add(.init(day: 7, departure: "07:00"))).get(), now: saturday)
        XCTAssertEqual(EVState.from(get(&p, "/api/ev", now: saturday))?.nextDeparture, demoDate(2026, 3, 29, 7, 0))
        // Eine Regel 18:00–19:00 gilt von 18:00 bis 19:00 an der Wand.
        let draft = ScheduleEdit.Draft(target: "gridSetpointW", start: "18:00", end: "19:00", value: -2000)
        _ = post(&p, "/api/schedule/rules", try ScheduleEdit.payload(schedule: get(&p, "/api/schedule", now: saturday), change: .add(draft)).get(), now: saturday)
        XCTAssertEqual(p.live(at: demoDate(2026, 3, 29, 18, 30)).setpointSource, "manual")
        XCTAssertNotEqual(p.live(at: demoDate(2026, 3, 29, 17, 30)).setpointSource, "manual")
        XCTAssertNotEqual(p.live(at: demoDate(2026, 3, 29, 19, 30)).setpointSource, "manual")
        // Die Sonne steht mittags am höchsten, nicht eine Stunde daneben.
        let pv = p.run(sunday).slots
        let peak = try XCTUnwrap(pv.max { $0.pvKw + $0.curtailedKwh * 4 < $1.pvKw + $1.curtailedKwh * 4 })
        XCTAssert((12.0...14.5).contains(sunday.hour(of: peak.start)), "Spitze um \(sunday.clock(of: peak.start))")
        // Herbst: 25 Stunden.
        XCTAssertEqual(p.run(containing: demoDate(2026, 10, 25, 12)).slots.count, 100)
        // Vorgaben des Plans tragen die Uhrzeit an der Wand.
        for rule in p.run(sunday).rules {
            XCTAssertEqual(rule.start, sunday.clock(of: sunday.start.addingTimeInterval(Double(rule.firstSlot) * 900)))
        }
    }

    func testDaysConnectWithoutAJumpInTheBattery() {
        let p = plant()
        var day = p.world.day(containing: demoDate(2025, 8, 20))
        for _ in 0..<120 {
            let next = p.world.day(after: day)
            XCTAssertEqual(p.run(next).slots[0].socStart, p.run(day).endSoc, accuracy: 1e-9, "Sprung über Mitternacht am \(next.start)")
            day = next
        }
        // Gleich, in welcher Reihenfolge gerechnet wird: Ein einzelner Tag allein ergibt dasselbe.
        let alone = plant()
        let target = alone.world.day(containing: demoDate(2025, 9, 27))
        XCTAssertEqual(alone.run(target), p.run(target))
        // Auch heute schließt an gestern an, und der Fahrplan läuft über Mitternacht ohne Sprung.
        let today = p.world.day(containing: start)
        XCTAssertEqual(p.run(today).slots[0].socStart, p.run(p.world.day(after: today, by: -1)).endSoc, accuracy: 1e-9)
    }

    // MARK: Gegenprüfung bb3d00cc

    func testOlderSavedStateKeepsItsEdits() throws {
        var p = plant()
        _ = post(&p, "/api/control/stop", [:])
        _ = post(&p, "/api/ev/override", try XCTUnwrap(EVEdit.stopCharging(durationMin: nil)))
        _ = post(&p, "/api/schedule/config", ["defaultGridSetpointW": -120])
        // „Weiter laden, wenn es günstig ist“ ausgeschaltet: Der Wert fehlt dann im gespeicherten Zustand.
        _ = post(&p, "/api/ev", try XCTUnwrap(EVEdit.maxSoc(nil)))
        XCTAssertNil(p.state.evMaxSocPct)
        // So hat ein früherer Stand gespeichert: ohne die Felder, die später dazukamen.
        var old = try XCTUnwrap(JSONValue.decode(JSONEncoder().encode(p.state)).object)
        old["evExtraPct"] = nil
        var override = try XCTUnwrap(old["evOverride"]?.object)
        override["chargedPct"] = nil
        override["accountedAt"] = nil
        old["evOverride"] = .object(override)
        XCTAssertThrowsError(try JSONDecoder().decode(DemoPlant.State.self, from: try JSONValue.object(old).encoded()), "ohne Hilfe unlesbar")
        // Vergleichswert: derselbe Zustand, einmal gespeichert und gelesen (ganze Zahlen kommen als solche zurück).
        let saved = try JSONDecoder().decode(DemoPlant.State.self, from: try JSONEncoder().encode(p.state))
        let restored = try XCTUnwrap(DemoPlant.State.restore(try JSONValue.object(old).encoded()))
        XCTAssertEqual(restored, saved, "was bedient wurde, bleibt; Fehlendes bekommt den Wert einer frischen Demo")
        XCTAssertEqual(restored.emergencyStop, true)
        XCTAssertEqual(restored.defaultGridSetpointW, -120)
        XCTAssertEqual(restored.evOverride?.kind, "stop")
        XCTAssertEqual(restored.evOverride?.accountedAt, restored.evOverride?.startedAt)
        XCTAssertEqual(restored.evExtraPct, 0)
        XCTAssertNil(restored.evMaxSocPct, "Ausgeschaltetes bleibt aus — ein fehlender Wert ist kein neues Feld")
        XCTAssertNil(restored.evOnce)
        // Der heutige Stand liest sich unverändert, Unlesbares gar nicht.
        XCTAssertEqual(DemoPlant.State.restore(try JSONEncoder().encode(p.state)), saved)
        XCTAssertNil(DemoPlant.State.restore(Data("kaputt".utf8)))
        XCTAssertNil(DemoPlant.State.restore(Data("{}".utf8)))
    }

    func testRejectedOverrideLeavesTheRunningOneAlone() throws {
        var p = plant()
        let now = demoDate(2026, 11, 24, 15, 0)
        _ = post(&p, "/api/ev/override", try XCTUnwrap(EVEdit.stopCharging(durationMin: nil)), now: now)
        let before = p.state
        XCTAssertEqual(post(&p, "/api/ev/override", ["kind": "charge", "powerW": 0], now: now.addingTimeInterval(60)).status, 400)
        XCTAssertEqual(post(&p, "/api/ev/override", ["kind": "charge", "powerW": 7000, "durationMin": 0], now: now.addingTimeInterval(60)).status, 400)
        XCTAssertEqual(p.state, before, "eine abgelehnte Anfrage ändert nichts")
        XCTAssertEqual(EVState.from(get(&p, "/api/ev", now: now.addingTimeInterval(120)))?.override?.stop, true)
    }

    func testTimesInTheDaylightSavingGapMoveForward() throws {
        var p = plant(startedAt: demoDate(2026, 3, 27, 10))
        // 29.03.2026: 02:30 gibt es nicht — es gilt der erste Augenblick danach (03:00).
        let spring = p.world.day(containing: demoDate(2026, 3, 29, 12))
        XCTAssertEqual(spring.date(atHour: 2.5), demoDate(2026, 3, 29, 3, 0))
        XCTAssertEqual(spring.date(atHour: 1.5), demoDate(2026, 3, 29, 1, 30))
        XCTAssertEqual(spring.date(atHour: 3.25), demoDate(2026, 3, 29, 3, 15))
        let saturday = demoDate(2026, 3, 28, 20, 0)
        let week = try XCTUnwrap(EVState.from(get(&p, "/api/ev", now: saturday))).week
        _ = post(&p, "/api/ev", try EVEdit.weekPlan(week, change: .add(.init(day: 7, departure: "02:30"))).get(), now: saturday)
        XCTAssertEqual(EVState.from(get(&p, "/api/ev", now: saturday))?.nextDeparture, demoDate(2026, 3, 29, 3, 0))
        XCTAssertEqual(EVState.from(get(&p, "/api/ev", now: demoDate(2026, 3, 29, 1, 45)))?.nextDeparture, demoDate(2026, 3, 29, 3, 0), "nicht übersprungen")
        // 25.10.2026: 02:30 gibt es zweimal — es gilt das erste Mal; danach stimmt die Uhr wieder.
        let autumn = p.world.day(containing: demoDate(2026, 10, 25, 12))
        XCTAssertEqual(autumn.date(atHour: 2.5), autumn.start.addingTimeInterval(2.5 * 3600))
        XCTAssertEqual(autumn.date(atHour: 7), demoDate(2026, 10, 25, 7, 0))
        XCTAssertEqual(autumn.hour(of: autumn.date(atHour: 7)), 7, accuracy: 1e-9)
    }

    func testChargedEnergyNeverShrinksWhenAskedLater() throws {
        var p = plant()
        // Mittwoch 06:58: zwei Minuten laden, dann fährt das Auto (07:00–08:30).
        let begin = demoDate(2026, 11, 25, 6, 58)
        _ = post(&p, "/api/ev/override", try XCTUnwrap(EVEdit.chargeNow(powerW: 11_000, durationMin: nil)), now: begin)
        let o = try XCTUnwrap(p.state.evOverride)
        let twoMinutes = 11.0 * (2.0 / 60) / 60 * 100
        XCTAssertEqual(p.overrideCharged(o, until: demoDate(2026, 11, 25, 7, 0)), twoMinutes, accuracy: 1e-6)
        var last = 0.0
        for minutes in stride(from: 0, through: 120, by: 1) {
            let charged = p.overrideCharged(o, until: begin.addingTimeInterval(Double(minutes) * 60))
            XCTAssertGreaterThanOrEqual(charged, last - 1e-9, "nach \(minutes) min")
            last = charged
        }
        XCTAssertEqual(p.overrideCharged(o, until: demoDate(2026, 11, 25, 7, 2)), twoMinutes, accuracy: 1e-6, "unterwegs kommt nichts dazu – und nichts weg")
        XCTAssertEqual(p.overrideCharged(o, until: demoDate(2026, 11, 25, 8, 32)), 2 * twoMinutes, accuracy: 1e-6, "ab 08:30 lädt es weiter")
    }

    func testUnknownRequestsAreRejected() {
        var p = plant()
        XCTAssertEqual(p.respond("GET", "/api/irgendwas").status, 404)
        XCTAssertEqual(p.respond("POST", "/api/status", body: [:]).status, 404)
        XCTAssertEqual(p.respond("GET", "/api/history/summary?view=quartal&date=2026-11-24").status, 400)
        XCTAssertEqual(p.respond("GET", "/api/history/summary?view=day&date=gestern").status, 400)
    }
}
