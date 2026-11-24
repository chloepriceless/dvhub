// DemoPlant+API.swift — die Demo-Anlage antwortet wie eine DVhub-Box.
//
// Dieselben Pfade und dieselbe Form wie die Box (dvhub/routes-api.js; Vorbild
// der Antworten: ios/interop/harness.mjs). Die App merkt keinen Unterschied —
// sie fragt `GET /api/status`, `POST /api/ev` …, und statt der Box rechnet
// dieser Code. Schreibanfragen ändern nur den Zustand der Demo (`State`);
// prüfen tut er wie die Box, damit auch Ablehnungen zu sehen sind.

import Foundation

extension DemoPlant {
    // MARK: Helfer

    static func iso(_ d: Date) -> String { d.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)) }
    static func ms(_ d: Date) -> JSONValue { .int(Int64((d.timeIntervalSince1970 * 1000).rounded())) }

    /// Zahl mit `digits` Nachkommastellen (0 → ganze Zahl).
    static func num(_ v: Double, _ digits: Int = 0) -> JSONValue {
        guard v.isFinite else { return .null }
        if digits == 0 { return .int(Int64(v.rounded())) }
        let p = pow(10, Double(digits))
        return .double((v * p).rounded() / p)
    }

    static func ok(_ body: JSONValue) -> LinkResponse { LinkResponse(status: 200, body: body) }
    static func bad(_ error: String, status: Int = 400) -> LinkResponse {
        LinkResponse(status: status, body: ["ok": false, "error": .string(error)])
    }

    static func query(_ q: String) -> [String: String] {
        var out: [String: String] = [:]
        for item in URLComponents(string: "demo://box/?" + q)?.queryItems ?? [] where out[item.name] == nil { out[item.name] = item.value ?? "" }
        return out
    }

    func dayKey(_ d: Date) -> String {
        let c = world.calendar.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    /// „2026-11-24“ → Tag im Kalender der Anlage.
    func day(key: String?) -> DemoWorld.Day? {
        guard let key else { return nil }
        let p = key.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3, let d = world.calendar.date(from: DateComponents(year: p[0], month: p[1], day: p[2], hour: 12)) else { return nil }
        return world.day(containing: d)
    }

    // MARK: Einstieg

    /// Antwort auf eine Anfrage der App. Vorher erledigt sich, was die Zeit erledigt (`settle`).
    public mutating func respond(_ method: String, _ path: String, body: JSONValue? = nil, now: Date = Date()) -> LinkResponse {
        settle(at: now)
        let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let route = String(parts.first ?? "")
        let q = Self.query(parts.count > 1 ? String(parts[1]) : "")
        switch (method.uppercased(), route) {
        case ("GET", "/api/status"): return Self.ok(fullStatus(at: now))
        case ("GET", "/api/telemetry/series"): return Self.ok(series(q, now: now))
        case ("GET", "/api/history/summary"): return history(q, now: now)
        case ("GET", "/api/eos/plan"): return Self.ok(eosPlan(q, now: now))
        case ("GET", "/api/costs"): return Self.ok(["ok": true, "netEur": Self.num(live(at: now).today.netEur, 2)])
        case ("GET", "/api/schedule"): return Self.ok(schedule(at: now))
        case ("GET", "/api/schedule/automation/config"): return Self.ok(automationView())
        case ("GET", "/api/ev"): return Self.ok(ev(at: now))
        case ("GET", "/api/integrations/health"): return Self.ok(health(at: now))
        case ("GET", "/api/integrations/dataflow"): return Self.ok(dataflow(at: now))
        case ("GET", "/api/eos/status"): return Self.ok(eosStatus(at: now))
        case ("GET", "/api/vpn/status"): return Self.ok(vpnStatus(at: now))
        case ("GET", "/api/devices"): return Self.ok(devices(at: now))
        case ("GET", "/api/victron/devices"): return Self.ok(victronDevices(at: now))
        case ("GET", "/api/feed-in-cap/status"): return Self.ok(feedInCap())
        case ("GET", "/api/storage/status"): return Self.ok(storage(at: now))
        case ("GET", "/api/mobile-link/integrations"): return Self.ok(setup(at: now))
        case ("POST", "/api/control/stop"): return emergencyStop(true, now: now)
        case ("POST", "/api/control/resume"): return emergencyStop(false, now: now)
        case ("POST", "/api/schedule/rules"): return setRules(body ?? .null)
        case ("POST", "/api/schedule/rules/toggle"): return toggleRules(body ?? .null, now: now)
        case ("POST", "/api/schedule/config"): return setScheduleConfig(body ?? .null, now: now)
        case ("POST", "/api/schedule/automation/config"): return setAutomation(body ?? .null)
        case ("POST", "/api/schedule/automation/replan"): return replan(now: now)
        case ("POST", "/api/ev"): return patchEV(body ?? .null, now: now)
        case ("POST", "/api/ev/override"): return setOverride(body ?? .null, now: now)
        case ("DELETE", "/api/ev/override"): return clearOverride(now: now)
        default: return Self.bad("not_found", status: 404)
        }
    }

    // MARK: Kompakt-Status (live)

    public func compactStatus(at now: Date) -> JSONValue { compact(live(at: now)) }

    func compact(_ l: Live) -> JSONValue {
        [
            "ts": .string(Self.iso(l.at)),
            "soc": Self.num(l.soc, 1),
            "batteryPowerW": Self.num(l.batteryW),
            "pvTotalW": Self.num(l.pvW),
            "gridSetpointW": Self.num(l.gridSetpointW),
            "gridImportW": Self.num(l.gridImportW),
            "gridExportW": Self.num(l.gridExportW),
            "loadW": Self.num(l.loadW),
            "minSocPct": Self.num(Self.minSocPct),
            "alarmsActive": 0, "alarmsSeverity": 0, "alarmsStale": false,
            "emergencyStop": .bool(state.emergencyStop),
            "telemetryFrozen": false,
            "todayNetEur": Self.num(l.today.netEur, 2),
            "todayRevenueEur": Self.num(l.today.revenueEur, 2),
            "todayCostEur": Self.num(l.today.costEur, 2),
            "version": .string(Self.version),
            "controls": [
                "dv": ["curtailed": false, "limitPct": .null],
                "negativePrice": ["protection": true, "active": .bool(l.negativePriceActive)],
                "feedInLimit": ["limitW": Self.num(Self.feedInLimitW), "blocked": false],
                "p14a": ["active": false, "limitW": .null],
            ],
        ]
    }

    // MARK: Voller Status

    func fullStatus(at now: Date) -> JSONValue {
        let l = live(at: now)
        let today = world.day(containing: now), tomorrow = world.day(after: today)
        var epex: [JSONValue] = [], slots: [JSONValue] = []
        var current: JSONValue = .null
        // Tiefst- und Höchstpreis je Tag (heute, morgen).
        var low = [Double.infinity, .infinity], high = [-Double.infinity, -.infinity]
        var futureNegative = false
        for (n, day) in [today, tomorrow].enumerated() {
            for i in 0..<day.slotCount {
                let start = day.start.addingTimeInterval(Double(i) * 900)
                let ct = world.spotCt(day, hour: (Double(i) + 0.5) / 4)
                let slot: JSONValue = ["ts": Self.ms(start), "exportPriceCtKwh": Self.num(ct, 2), "importPriceCtKwh": Self.num(DemoWorld.importCt(spot: ct), 2)]
                epex.append(["ts": Self.ms(start), "day": .string(dayKey(start)), "eur_mwh": Self.num(ct * 10, 1), "ct_kwh": Self.num(ct, 2)])
                slots.append(slot)
                if start <= now, now < start.addingTimeInterval(900) { current = slot }
                low[n] = min(low[n], ct)
                high[n] = max(high[n], ct)
                if ct < 0, start.addingTimeInterval(900) > now { futureNegative = true }
            }
        }
        let third = (l.gridImportW - l.gridExportW) / 3
        let acPv = l.pvW * 0.4
        let t = now.timeIntervalSince1970
        return [
            "ok": true, "demo": true, "now": Self.ms(now), "timeZone": .string(world.calendar.timeZone.identifier),
            "victron": [
                "updatedAt": Self.ms(now), "connected": true, "soc": Self.num(l.soc, 1), "batteryPowerW": Self.num(l.batteryW),
                "pvPowerW": Self.num(l.pvW - acPv), "pvAcW": Self.num(acPv), "pvTotalW": Self.num(l.pvW),
                "acPvL1W": Self.num(acPv * 0.34), "acPvL2W": Self.num(acPv * 0.33), "acPvL3W": Self.num(acPv * 0.33),
                "gridSetpointW": Self.num(l.gridSetpointW), "maxDischargeW": -1, "minSocPct": Self.num(Self.minSocPct),
                "gridImportW": Self.num(l.gridImportW), "gridExportW": Self.num(l.gridExportW), "selfConsumptionW": Self.num(l.loadW),
                "batteryChargeW": Self.num(max(0, l.batteryW)), "batteryDischargeW": Self.num(max(0, -l.batteryW)),
                "solarDirectUseW": Self.num(l.solarToHomeW), "solarToBatteryW": Self.num(l.solarToBatteryW), "solarToGridW": Self.num(l.solarToGridW),
                "gridDirectUseW": Self.num(l.gridToHomeW), "gridToBatteryW": Self.num(l.gridToBatteryW),
                "batteryDirectUseW": Self.num(l.batteryToHomeW), "batteryToGridW": Self.num(l.batteryToGridW),
            ],
            "meter": [
                "ok": true, "updatedAt": Self.ms(now),
                "grid_l1_w": Self.num(third * 1.12), "grid_l2_w": Self.num(third * 0.94), "grid_l3_w": Self.num(third * 0.94),
                "grid_total_w": Self.num(l.gridImportW - l.gridExportW), "semantics": ["positiveMeans": "grid_import"],
            ],
            "gridVoltage": [
                "ok": true, "l1": Self.num(231.2 + 0.9 * sin(t / 41), 1), "l2": Self.num(229.9 + 0.8 * sin(t / 53 + 1), 1),
                "l3": Self.num(232.0 + 0.9 * sin(t / 47 + 2), 1), "frequencyHz": Self.num(50 + 0.015 * sin(t / 19), 2),
                "updatedAt": Self.ms(now), "source": "meter",
            ],
            "costs": [
                "day": .string(dayKey(now)), "importKwh": Self.num(l.today.importKwh, 2), "exportKwh": Self.num(l.today.exportKwh, 2),
                "costEur": Self.num(l.today.costEur, 2), "revenueEur": Self.num(l.today.revenueEur, 2), "netEur": Self.num(l.today.netEur, 2),
                "priceNowCtKwh": Self.num(l.spotCt, 2), "userImportPriceNowCtKwh": Self.num(l.importCt, 2),
            ],
            "userEnergyPricing": [
                "configured": true, "mode": "dynamic", "usesParagraph14aModule3": false,
                "dynamicComponents": [
                    "energyMarkupCtKwh": .double(DemoWorld.markupCt), "gridChargesCtKwh": .double(DemoWorld.gridChargesCt),
                    "leviesAndFeesCtKwh": .double(DemoWorld.leviesCt), "vatPct": .double(DemoWorld.vatPct),
                ],
                "costs": ["pvCtKwh": 6.4, "batteryBaseCtKwh": 2, "batteryLossMarkupPct": 20, "batteryEffectiveCtKwh": 10.1],
                "current": current, "slots": .array(slots),
            ],
            "epex": [
                "ok": true, "bzn": "DE-LU", "date": .string(dayKey(today.start)), "nextDate": .string(dayKey(tomorrow.start)),
                "updatedAt": Self.ms(now.addingTimeInterval(-1500)), "activeSource": "dvhub.online", "data": .array(epex),
                "summary": [
                    "todayMin": Self.num(low[0] * 10, 1), "todayMax": Self.num(high[0] * 10, 1),
                    "tomorrowMin": Self.num(low[1] * 10, 1), "tomorrowMax": Self.num(high[1] * 10, 1),
                    "hasFutureNegative": .bool(futureNegative),
                ],
            ],
            "schedule": schedule(at: now),
            "emergencyStop": ["active": .bool(state.emergencyStop), "pausedAt": state.emergencyStopSince.map { Self.ms($0) } ?? .null, "reason": .null],
            "victronAlarms": ["configured": true, "active": [], "updatedAt": .string(Self.iso(now.addingTimeInterval(-2))), "ageMs": 2000, "stale": false, "severity": 0],
            "systemWarnings": [],
            "runtime": ["ready": true, "busy": false, "mode": "worker"],
            "telemetry": ["enabled": true, "ok": true, "lastWriteAt": Self.ms(now.addingTimeInterval(-4))],
        ]
    }

    // MARK: Verlauf (/api/telemetry/series)

    func series(_ q: [String: String], now: Date) -> JSONValue {
        let keys = (q["keys"] ?? "battery_soc_pct").split(separator: ",").map(String.init)
        let today = world.day(containing: now)
        let start = parseISODate(q["start"]) ?? today.start
        let end = parseISODate(q["end"]) ?? today.end
        var rows: [JSONValue] = []
        var day = world.day(containing: start)
        var guardDays = 0
        while day.start < end, day.start <= now, guardDays < 8 {
            for s in run(day).slots where s.start >= start && s.start < end && s.start <= now {
                let values: [String: Double] = [
                    "pv_total_w": s.pvKw * 1000, "load_power_w": s.loadKw * 1000, "self_consumption_w": s.loadKw * 1000,
                    "grid_import_w": s.flow.importKw * 1000, "grid_export_w": s.flow.exportKw * 1000,
                    "battery_power_w": s.flow.batteryKw * 1000, "battery_soc_pct": s.socStart,
                ]
                let ts = JSONValue.string(Self.iso(s.start))
                for k in keys {
                    guard let v = values[k] else { continue }
                    rows.append(["key": .string(k), "ts": ts, "value": Self.num(v, k.hasSuffix("pct") ? 1 : 0), "unit": k.hasSuffix("pct") ? "%" : "W", "resolution": 900])
                }
            }
            day = world.day(after: day)
            guardDays += 1
        }
        return ["ok": true, "keys": .array(keys.map { .string($0) }), "start": .string(Self.iso(start)), "end": .string(Self.iso(end)),
                "total": .int(Int64(rows.count)), "data": .array(rows)]
    }

    // MARK: Historie (/api/history/summary)

    static func kpis(_ t: Totals) -> [String: JSONValue] {
        var k: [String: JSONValue] = [
            "pvKwh": num(t.pvKwh, 3), "loadKwh": num(t.loadKwh, 3), "importKwh": num(t.importKwh, 3), "exportKwh": num(t.exportKwh, 3),
            "solarDirectUseKwh": num(t.solarToHomeKwh, 3), "solarToBatteryKwh": num(t.solarToBatteryKwh, 3), "solarToGridKwh": num(t.solarToGridKwh, 3),
            "gridDirectUseKwh": num(t.gridToHomeKwh, 3), "gridToBatteryKwh": num(t.gridToBatteryKwh, 3),
            "batteryDirectUseKwh": num(t.batteryToHomeKwh, 3), "batteryToGridKwh": num(t.batteryToGridKwh, 3),
            "batteryChargeKwh": num(t.batteryChargeKwh, 3), "batteryDischargeKwh": num(t.batteryDischargeKwh, 3),
            "exportRevenueEur": num(t.revenueEur, 4), "gridCostEur": num(t.costEur, 4), "avoidedImportGrossEur": num(t.avoidedEur, 4),
            "netEur": num(t.netEur, 4),
            "exportPvRevenueEur": num(t.revenueEur - t.batteryRevenueEur, 4), "exportBatteryRevenueEur": num(t.batteryRevenueEur, 4),
            "curtailedPvKwh": num(t.curtailedKwh, 3), "negPriceQuarterHourCount": num(t.negativeSlots, 2),
        ]
        k["gridShareKwh"] = k["gridDirectUseKwh"]
        k["cycles"] = num(t.batteryDischargeKwh / batteryKwh, 2)
        k["pvFullLoadHours"] = num(t.pvKwh / kwp, 1)
        if let mean = t.meanSpotCt { k["avgSpotPriceCtKwh"] = num(mean, 2) }
        if t.solarToGridKwh > 0.01 { k["exportPvCtKwh"] = num((t.revenueEur - t.batteryRevenueEur) / t.solarToGridKwh * 100, 2) }
        return k
    }

    func history(_ q: [String: String], now: Date) -> LinkResponse {
        let view = q["view"] ?? "day"
        guard let anchor = day(key: q["date"] ?? dayKey(now)) else { return Self.bad("invalid date") }
        let cal = world.calendar
        var rows: [JSONValue] = []
        var charts: [String: JSONValue] = [:]
        var sum = Totals()
        let first: DemoWorld.Day, endExclusive: Date

        func dayRow(_ d: DemoWorld.Day) -> Totals? {
            guard d.start <= now else { return nil }
            return totals(run(d), until: now)
        }
        func row(key: String, label: String, _ t: Totals) -> JSONValue {
            var o = Self.kpis(t)
            o["key"] = .string(key)
            o["label"] = .string(label)
            return .object(o)
        }

        switch view {
        case "day":
            first = anchor
            endExclusive = anchor.end
            let r = run(anchor)
            sum = totals(r, until: now)
            var energy: [JSONValue] = [], money: [JSONValue] = [], prices: [JSONValue] = []
            for s in r.slots where s.start < now {
                // Die laufende Viertelstunde zählt, soweit sie vergangen ist.
                let share = s.end <= now ? 1 : now.timeIntervalSince(s.start) / s.end.timeIntervalSince(s.start)
                let ts = JSONValue.string(Self.iso(s.start))
                energy.append([
                    "ts": ts, "pvKwh": Self.num(s.pvKwh * share, 4), "loadKwh": Self.num(s.loadKwh * share, 4),
                    "importKwh": Self.num(s.importKwh * share, 4), "exportKwh": Self.num(s.exportKwh * share, 4),
                    "solarDirectUseKwh": Self.num(s.solarToHomeKwh * share, 4), "solarToBatteryKwh": Self.num(s.solarToBatteryKwh * share, 4),
                    "solarToGridKwh": Self.num(s.solarToGridKwh * share, 4), "batteryDirectUseKwh": Self.num(s.batteryToHomeKwh * share, 4),
                    "batteryToGridKwh": Self.num(s.batteryToGridKwh * share, 4), "gridDirectUseKwh": Self.num(s.gridToHomeKwh * share, 4),
                    "gridToBatteryKwh": Self.num(s.gridToBatteryKwh * share, 4), "estimated": false, "incomplete": .bool(share < 1),
                ])
                money.append(["ts": ts, "gridCostEur": Self.num(s.costEur * share, 4), "exportRevenueEur": Self.num(s.revenueEur * share, 4),
                              "netEur": Self.num((s.revenueEur - s.costEur) * share, 4)])
                prices.append(["ts": ts, "marketPriceCtKwh": Self.num(s.spotCt, 2), "userImportPriceCtKwh": Self.num(s.importCt, 2)])
            }
            charts = ["dayEnergyLines": .array(energy), "dayFinancialLines": .array(money), "dayPriceLines": .array(prices)]
        case "week", "month":
            if view == "week" {
                first = world.day(after: anchor, by: -(anchor.weekday - 1))
                endExclusive = world.day(after: first, by: 7).start
            } else {
                let c = cal.dateComponents([.year, .month], from: anchor.start)
                let start = cal.date(from: DateComponents(year: c.year, month: c.month, day: 1, hour: 12)) ?? anchor.start
                first = world.day(containing: start)
                endExclusive = cal.date(byAdding: .month, value: 1, to: first.start) ?? first.end
            }
            var d = first
            while d.start < endExclusive, let t = dayRow(d) {
                let c = cal.dateComponents([.month, .day], from: d.start)
                rows.append(row(key: dayKey(d.start), label: String(format: "%02d.%02d.", c.day ?? 1, c.month ?? 1), t))
                sum.add(t)
                d = world.day(after: d)
            }
        case "year":
            let year = cal.component(.year, from: anchor.start)
            first = world.day(containing: cal.date(from: DateComponents(year: year, month: 1, day: 1, hour: 12)) ?? anchor.start)
            endExclusive = cal.date(from: DateComponents(year: year + 1, month: 1, day: 1)) ?? first.end
            var d = first
            var month = Totals(), monthNumber = 1, any = false
            func flush() {
                guard any else { return }
                rows.append(row(key: String(format: "%04d-%02d", year, monthNumber), label: String(format: "%02d/%04d", monthNumber, year), month))
            }
            while d.start < endExclusive, let t = dayRow(d) {
                let m = cal.component(.month, from: d.start)
                if m != monthNumber { flush(); month = Totals(); monthNumber = m; any = false }
                month.add(t)
                sum.add(t)
                any = true
                d = world.day(after: d)
            }
            flush()
        default:
            return Self.bad("invalid view")
        }

        return Self.ok([
            "view": .string(view), "date": .string(dayKey(anchor.start)),
            "range": ["startDate": .string(dayKey(first.start)), "endDateExclusive": .string(dayKey(endExclusive))],
            "kpis": .object(Self.kpis(sum)), "series": ["financial": [], "energy": [], "prices": []],
            "charts": .object(charts), "rows": .array(rows), "slots": [], "meta": ["demo": true],
        ])
    }

    // MARK: EOS-Plan

    static func planLabel(_ s: Slot) -> JSONValue {
        switch s.mode {
        case .gridCharge: return .string(L("Akku aus dem Netz laden"))
        case .feedIn: return .string(L("Akku ins Netz entladen"))
        case .own, .sell:
            if s.evKw > 0 { return .string(L("E-Auto laden")) }
            if s.exportBlocked, s.flow.curtailed > 0.02 { return .string(L("Einspeisung aussetzen (negativer Preis)")) }
            return .null
        }
    }

    func eosPlan(_ q: [String: String], now: Date) -> JSONValue {
        let limit = max(1, min(384, Int(q["rows"] ?? "") ?? 192))
        let today = world.day(containing: now)
        let slots = runs(from: today, count: 4).flatMap(\.slots).filter { $0.end > now }.prefix(limit)
        let rows: [JSONValue] = slots.map { s in
            ["ts_utc": .string(Self.iso(s.start)), "socPct": Self.num(s.socStart), "pvWh": Self.num(s.pvKwh * 1000), "loadWh": Self.num(s.loadKwh * 1000),
             "gridFeedinWh": Self.num(s.exportKwh * 1000), "gridConsumptionWh": Self.num(s.importKwh * 1000), "priceCtKwh": Self.num(s.spotCt, 2),
             "zeitplanLabel": Self.planLabel(s)]
        }
        return ["ok": true, "available": true, "reason": .null,
                "output": ["slotMinutes": 15, "rows": .array(rows), "truncated": false, "totalCount": .int(Int64(rows.count))],
                "plan": ["fetchedAt": .string(Self.iso(lastPlanRun(before: now)))]]
    }

    /// EOS rechnet alle zwei Stunden — der letzte Lauf vor `now`.
    func lastPlanRun(before now: Date) -> Date {
        let t = now.timeIntervalSince1970
        return Date(timeIntervalSince1970: floor((t - 420) / 7200) * 7200 + 420)
    }

    // MARK: Zeitplan

    func planRules(at now: Date) -> [JSONValue] {
        run(containing: now).rules.map { r in
            ["id": .string(r.id), "enabled": .bool(!state.disabledPlanRules.contains(r.id)), "target": "gridSetpointW",
             "start": .string(r.start), "end": .string(r.end), "value": Self.num(r.gridSetpointW), "source": "forecast_optimizer"]
        }
    }

    func schedule(at now: Date) -> JSONValue {
        let l = live(at: now)
        let at = Self.ms(now.addingTimeInterval(-60))
        var active: [String: JSONValue] = [
            "gridSetpointW": ["value": Self.num(l.gridSetpointW), "source": .string(l.setpointSource), "at": at],
            "minSocPct": ["value": Self.num(Self.minSocPct), "source": "default", "at": at],
        ]
        if !state.emergencyStop, let rule = activeRule("chargeCurrentA", at: now, soc: l.soc) {
            active["chargeCurrentA"] = ["value": Self.num(rule.value), "source": .string(rule.source), "at": at]
        } else {
            active["chargeCurrentA"] = ["value": Self.num(state.defaultChargeCurrentA), "source": "default", "at": at]
        }
        return [
            "config": ["defaultGridSetpointW": Self.num(state.defaultGridSetpointW), "defaultChargeCurrentA": Self.num(state.defaultChargeCurrentA),
                       "defaultFeedExcessDcPv": Self.num(state.defaultFeedExcessDcPv)],
            "rules": .array(state.manualRules + planRules(at: now) + state.automationRules),
            "active": .object(active),
            "lastWrite": ["gridSetpointW": ["value": Self.num(l.gridSetpointW), "source": .string(l.setpointSource), "writeType": "holding", "at": at]],
            "smallMarketAutomation": [
                "lastRunDate": .string(dayKey(state.automationLastRun ?? now)), "lastOutcome": "ok",
                "generatedRuleCount": .int(Int64(state.automationRules.count)),
            ],
        ]
    }

    /// `POST /api/schedule/rules` ersetzt alle Regeln von Hand; Plan-Regeln bleiben, wie sie sind.
    mutating func setRules(_ body: JSONValue) -> LinkResponse {
        guard let list = body["rules"]?.array,
              list.allSatisfy({ $0.object != nil && $0["target"]?.string != nil && ($0["value"] == nil || $0["value"]?.number != nil) })
        else { return Self.bad("invalid rule structure") }
        let manual = list.filter { !ScheduleEdit.isAutomation($0) }
        update { $0.manualRules = manual }
        return Self.ok(["ok": true, "count": .int(Int64(manual.count))])
    }

    mutating func toggleRules(_ body: JSONValue, now: Date) -> LinkResponse {
        let ids = Set((body["ids"]?.array ?? []).compactMap(\.string))
        guard !ids.isEmpty, let enabled = body["enabled"]?.bool else { return Self.bad("ids array required") }
        var hits = 0
        func set(_ rules: [JSONValue]) -> [JSONValue] {
            rules.map { r in
                guard var o = r.object, let id = r["id"]?.string, ids.contains(id) else { return r }
                o["enabled"] = .bool(enabled)
                hits += 1
                return .object(o)
            }
        }
        let manual = set(state.manualRules), auto = set(state.automationRules)
        var disabled = Set(state.disabledPlanRules)
        for id in run(containing: now).rules.map(\.id) where ids.contains(id) {
            if enabled { disabled.remove(id) } else { disabled.insert(id) }
            hits += 1
        }
        guard hits > 0 else { return Self.bad("no matching rules", status: 404) }
        // Merker alter Tage nicht ansammeln.
        update { $0.manualRules = manual; $0.automationRules = auto; $0.disabledPlanRules = Array(disabled.sorted().suffix(16)) }
        return Self.ok(["ok": true, "toggled": .int(Int64(hits))])
    }

    mutating func setScheduleConfig(_ body: JSONValue, now: Date) -> LinkResponse {
        guard body.object != nil else { return Self.bad("invalid body") }
        var next = state
        for (key, path) in [("defaultGridSetpointW", \State.defaultGridSetpointW), ("defaultChargeCurrentA", \State.defaultChargeCurrentA),
                            ("defaultFeedExcessDcPv", \State.defaultFeedExcessDcPv)] {
            guard let v = body[key] else { continue }
            guard let n = v.number else { return Self.bad("\(key) invalid") }
            next[keyPath: path] = n
        }
        guard abs(next.defaultGridSetpointW) <= ScheduleEdit.maxGridSetpointW, (0...ScheduleEdit.maxChargeCurrentA).contains(next.defaultChargeCurrentA)
        else { return Self.bad("value out of range") }
        state = next
        return Self.ok(["ok": true, "config": schedule(at: now)["config"] ?? .null])
    }

    // MARK: Börsenautomatik

    func automationConfig() -> JSONValue {
        ["enabled": .bool(state.automationEnabled), "searchWindowStart": .string(state.automationWindowStart),
         "searchWindowEnd": .string(state.automationWindowEnd), "maxDischargeW": Self.num(state.automationMaxDischargeW),
         "minSocPct": Self.num(state.automationMinSocPct), "maxDischargeFromPlant": false]
    }

    func automationView() -> JSONValue {
        ["ok": true, "config": automationConfig(), "optimizerEnabled": true, "globalMinSocPct": Self.num(Self.minSocPct)]
    }

    /// Wie die Box (automation-view.js): nur benannte Felder, alles andere ist ein Fehler.
    mutating func setAutomation(_ body: JSONValue) -> LinkResponse {
        guard let o = body.object else { return Self.bad("invalid body") }
        guard !o.isEmpty else { return Self.bad("nothing to change") }
        var next = state
        for (key, v) in o {
            switch key {
            case "enabled":
                guard let b = v.bool else { return Self.bad("enabled invalid") }
                next.automationEnabled = b
            case "searchWindowStart", "searchWindowEnd":
                guard let s = v.string, s.count == 5, let t = ScheduleEdit.normalizeTime(s) else { return Self.bad("\(key) invalid") }
                if key == "searchWindowStart" { next.automationWindowStart = t } else { next.automationWindowEnd = t }
            case "maxDischargeW":
                guard let n = v.number, abs(n) <= 100_000 else { return Self.bad("maxDischargeW invalid") }
                next.automationMaxDischargeW = n
            case "minSocPct":
                guard let n = v.number, (0...100).contains(n) else { return Self.bad("minSocPct invalid") }
                next.automationMinSocPct = n
            case "targetSlotCount":
                guard v.isNull || (v.int.map { (0...24).contains($0) } ?? false) else { return Self.bad("targetSlotCount invalid") }
            default:
                return Self.bad("field_not_allowed:\(key.prefix(40))")
            }
        }
        // Ausgeschaltet: Die Regeln der Automatik verschwinden aus dem Zeitplan.
        if !next.automationEnabled { next.automationRules = [] }
        state = next
        return Self.ok(["ok": true, "config": automationConfig()])
    }

    /// „Neu planen“: die vier teuersten Viertelstunden im Suchfenster der nächsten 24 Stunden.
    mutating func replan(now: Date) -> LinkResponse {
        guard state.automationEnabled else {
            update { $0.automationRules = []; $0.automationLastRun = now }
            return Self.ok(["ok": true, "generatedRuleCount": 0, "availableEnergyKwh": 0, "lastOutcome": "disabled", "plan": .null])
        }
        let from = Self.minutes(state.automationWindowStart) ?? 14 * 60, to = Self.minutes(state.automationWindowEnd) ?? 9 * 60
        let today = world.day(containing: now)
        let horizon = now.addingTimeInterval(24 * 3600)
        let candidates = runs(from: today, count: 2).flatMap { run in
            run.slots.filter { s in
                s.start >= now && s.start < horizon && Self.inWindow(Int(run.day.hour(of: s.start) * 60 + 1e-6), start: from, end: to)
            }
        }
        let best = candidates.sorted { $0.spotCt > $1.spotCt }.prefix(4).sorted { $0.start < $1.start }
        // Aufeinanderfolgende Viertelstunden zu einer Regel zusammenfassen.
        var groups: [[Slot]] = []
        for s in best {
            if let last = groups.last?.last, abs(s.start.timeIntervalSince(last.end)) < 1 { groups[groups.count - 1].append(s) } else { groups.append([s]) }
        }
        let rules: [JSONValue] = groups.enumerated().compactMap { i, g in
            guard let a = g.first, let b = g.last else { return nil }
            return ["id": .string("sma-\(i + 1)"), "enabled": true, "target": "gridSetpointW", "start": .string(world.clock(a.start)),
                    "end": .string(world.clock(b.end)), "value": Self.num(-abs(state.automationMaxDischargeW)),
                    "stopSocPct": Self.num(state.automationMinSocPct), "source": "small_market_automation"]
        }
        let soc = live(at: now).soc
        update { $0.automationRules = rules; $0.automationLastRun = now }
        return Self.ok(["ok": true, "generatedRuleCount": .int(Int64(rules.count)),
                        "availableEnergyKwh": Self.num(max(0, soc - state.automationMinSocPct) / 100 * Self.batteryKwh, 1),
                        "lastOutcome": "ok", "plan": .null])
    }

    // MARK: Not-Halt

    mutating func emergencyStop(_ stop: Bool, now: Date) -> LinkResponse {
        if state.emergencyStop != stop {
            // Bis hierher zählt „Sofort laden“ nach dem alten Zustand, ab jetzt nach dem neuen.
            checkpointOverride(at: now)
            update {
                $0.emergencyStop = stop
                $0.emergencyStopSince = stop ? now : nil
                $0.events.append(State.Event(at: now, emergencyStop: stop, alarms: 0, severity: 0))
                if $0.events.count > 40 { $0.events.removeFirst($0.events.count - 40) }
            }
        }
        return Self.ok(["ok": true, "emergencyStop": .bool(stop)])
    }

    // MARK: E-Auto

    static let overrideLimits: JSONValue = ["minPowerW": 4140, "maxPowerW": 11_000]

    func overrideJSON(at now: Date) -> JSONValue {
        guard let o = override(at: now) else { return .null }
        return ["kind": .string(o.kind), "powerW": Self.num(o.powerW), "requestedW": Self.num(o.requestedW), "startedAt": .string(Self.iso(o.startedAt)),
                "until": o.until.map { .string(Self.iso($0)) } ?? .null, "seenConnected": true, "minPowerW": 4140, "maxPowerW": 11_000]
    }

    /// Nächste Abfahrt aus dem Wochenplan (Zeile = Abfahrtstag, 1 = Montag) — zur Uhrzeit an der Wand,
    /// auch an Tagen mit Zeitumstellung.
    func nextWeekly(after now: Date) -> (at: Date, minSocPct: Double?)? {
        var best: (at: Date, minSocPct: Double?)?
        var day = world.day(containing: now)
        for _ in 0..<8 {
            for row in state.evWeek where row["day"]?.int == Int64(day.weekday) {
                guard let m = Self.minutes(row["departure"]?.string) else { continue }
                let at = day.date(atHour: Double(m) / 60)
                if at > now, best.map({ at < $0.at }) ?? true { best = (at, row["minSocPct"]?.number) }
            }
            if best != nil { break }
            day = world.day(after: day)
        }
        return best
    }

    func ev(at now: Date) -> JSONValue {
        let car = vehicle(at: now)
        let once = state.evOnce.flatMap { $0 > now ? $0 : nil }
        let weekly = state.evDepartures ? nextWeekly(after: now) : nil
        var resolved: JSONValue = ["enabled": false, "departureAt": .null, "source": .null, "targetSocPct": .null]
        if let once {
            resolved = ["enabled": true, "departureAt": .string(Self.iso(once)), "source": "once",
                        "targetSocPct": Self.num(state.evOnceMinSocPct ?? state.evMinSocPct)]
        } else if let weekly {
            resolved = ["enabled": true, "departureAt": .string(Self.iso(weekly.at)), "source": "weekly",
                        "targetSocPct": Self.num(weekly.minSocPct ?? state.evMinSocPct)]
        }
        let target = resolved["targetSocPct"]?.number ?? state.evMinSocPct
        let energy = max(0, target - car.socPct) / 100 * DemoWorld.evBatteryKwh
        return [
            "ok": true, "optimizeEv": .bool(state.evOptimize), "onlyWhenPlugged": .bool(state.evOnlyWhenPlugged), "chargerConfigured": true,
            "departure": [
                "enabled": .bool(state.evDepartures), "once": once.map { .string(Self.iso($0)) } ?? "",
                "onceMinSocPct": once != nil ? (state.evOnceMinSocPct.map { Self.num($0) } ?? .null) : .null,
                "maxSocPct": state.evMaxSocPct.map { Self.num($0) } ?? .null, "defaultMinSocPct": Self.num(state.evMinSocPct),
                "weeklyDepartures": .array(state.evWeek), "targetMode": "percent", "targetValue": Self.num(state.evMinSocPct),
                "resolved": resolved,
            ],
            "vehicle": [
                "title": .string(L("E-Auto")), "connected": .bool(car.plugged), "charging": .bool(car.charging), "chargePowerW": Self.num(car.chargePowerW),
                "socPct": Self.num(car.socPct), "rangeKm": Self.num(car.socPct * 4.1), "plugged": .bool(car.plugged),
            ],
            "plan": state.evOptimize ? ["hasEv": true, "energyKwh": Self.num(energy, 1), "socAtDeparture": Self.num(max(car.socPct, target))] : .null,
            "planError": .null,
            "override": overrideJSON(at: now), "overrideLimits": Self.overrideLimits, "lastCommandError": .null,
        ]
    }

    /// Wochenplan prüfen und in feste Form bringen (ev-departure.js parseWeeklyDepartures / normalizeDepartureRows):
    /// Montag bis Sonntag, je Tag die Abfahrten nach Uhrzeit; ein Tag ohne Abfahrt hat genau eine leere Zeile.
    /// Ablehnung einer Eingabe, mit dem Fehlertext der Box.
    struct Rejection: Error { let error: String }

    static func normalizeWeek(_ list: [JSONValue]) -> Result<[JSONValue], Rejection> {
        guard list.count <= EVEdit.maxWeeklyDepartures + 7,
              list.filter({ !($0["departure"]?.string ?? "").trimmingCharacters(in: .whitespaces).isEmpty }).count <= EVEdit.maxWeeklyDepartures
        else { return .failure(Rejection(error: "departure.weeklyDepartures must be a list of up to \(EVEdit.maxWeeklyDepartures) departures")) }
        struct Row { var day: Int; var dep: String; var home: String; var prev: Bool; var min: JSONValue; var trip: JSONValue; var order: Int }
        var rows: [Row] = []
        for (i, e) in list.enumerated() {
            let p = "departure.weeklyDepartures[\(i)]"
            guard e.object != nil else { return .failure(Rejection(error: "\(p) must be an object")) }
            guard let day = e["day"]?.int.map(Int.init), (1...7).contains(day) else { return .failure(Rejection(error: "\(p).day must be a weekday 1..7")) }
            var times: [String: String] = [:]
            for k in ["departure", "homeFrom"] {
                let raw = (e[k]?.string ?? "").trimmingCharacters(in: .whitespaces)
                if raw.isEmpty { times[k] = ""; continue }
                guard let t = ScheduleEdit.normalizeTime(raw) else { return .failure(Rejection(error: "\(p).\(k) must be HH:MM or empty")) }
                times[k] = t
            }
            let dep = times["departure"] ?? "", home = times["homeFrom"] ?? ""
            if !home.isEmpty, dep.isEmpty { return .failure(Rejection(error: "\(p).departure is required with homeFrom")) }
            let prev = home.isEmpty ? false : (e["homeFromPrevDay"]?.bool ?? EVEdit.defaultHomeFromPrevDay(homeFrom: home, departure: dep))
            if !home.isEmpty, !prev, (minutes(home) ?? 0) >= (minutes(dep) ?? 0) { return .failure(Rejection(error: "\(p).homeFrom must be before the departure on the same day")) }
            var pct: [String: JSONValue] = [:]
            for k in ["minSocPct", "tripSocPct"] {
                guard let v = e[k], !v.isNull else { pct[k] = .null; continue }
                guard let n = v.number, (0...100).contains(n) else { return .failure(Rejection(error: "\(p).\(k) must be 0..100 or empty")) }
                pct[k] = v.int != nil ? .int(Int64(n)) : .double(n)
            }
            rows.append(Row(day: day, dep: dep, home: home, prev: prev, min: pct["minSocPct"] ?? .null, trip: pct["tripSocPct"] ?? .null, order: i))
        }
        var out: [JSONValue] = []
        for day in 1...7 {
            let with = rows.filter { $0.day == day && !$0.dep.isEmpty }.sorted {
                let a = minutes($0.dep) ?? 0, b = minutes($1.dep) ?? 0
                if a != b { return a < b }
                if $0.prev != $1.prev { return $0.prev }
                return $0.order < $1.order
            }
            if with.isEmpty { out.append(State.emptyDeparture(day)); continue }
            out += with.map { ["day": .int(Int64(day)), "departure": .string($0.dep), "homeFrom": .string($0.home), "homeFromPrevDay": .bool($0.prev),
                               "minSocPct": $0.min, "tripSocPct": $0.trip] }
        }
        return .success(out)
    }

    /// `POST /api/ev`: nur die Felder im Körper, mit den Grenzen der Box.
    mutating func patchEV(_ body: JSONValue, now: Date) -> LinkResponse {
        guard body.object != nil else { return Self.bad("invalid body") }
        var next = state
        var changed = 0
        if let v = body["optimizeEv"] { next.evOptimize = v.bool == true; changed += 1 }
        if let v = body["onlyWhenPlugged"] { next.evOnlyWhenPlugged = v.bool == true; changed += 1 }
        if let d = body["departure"], !d.isNull {
            guard d.object != nil else { return Self.bad("departure must be an object") }
            if let v = d["enabled"] { next.evDepartures = v.bool == true; changed += 1 }
            if let v = d["targetValue"] {
                guard let n = v.number, (0...100).contains(n) else { return Self.bad("departure.targetValue must be 0..100") }
                next.evMinSocPct = n
                changed += 1
            }
            if let v = d["maxSocPct"] {
                if v.isNull { next.evMaxSocPct = nil } else {
                    guard let n = v.number, (10...100).contains(n) else { return Self.bad("departure.maxSocPct must be 10..100 or empty") }
                    next.evMaxSocPct = n.rounded()
                }
                changed += 1
            }
            if let v = d["once"] {
                if v.string == "" || v.isNull { next.evOnce = nil } else {
                    guard let at = parseISODate(v.string) else { return Self.bad("departure.once must be an ISO date time or empty") }
                    guard at.timeIntervalSince(now) > 30 * 60 else { return Self.bad("departure.once must be more than 30 min in the future") }
                    next.evOnce = at
                }
                changed += 1
            }
            if let v = d["onceMinSocPct"] {
                if v.isNull { next.evOnceMinSocPct = nil } else {
                    guard let n = v.number, (0...100).contains(n) else { return Self.bad("departure.onceMinSocPct must be 0..100 or empty") }
                    next.evOnceMinSocPct = n
                }
                changed += 1
            }
            if let v = d["weeklyDepartures"] {
                guard let list = v.array else { return Self.bad("departure.weeklyDepartures must be a list") }
                switch Self.normalizeWeek(list) {
                case .failure(let e): return Self.bad(e.error)
                case .success(let rows): next.evWeek = rows
                }
                changed += 1
            }
        }
        guard changed > 0 else { return Self.bad("nothing to change") }
        state = next
        return Self.ok(["ok": true])
    }

    /// „Sofort laden“ / „Laden stoppen“, geprüft wie normalizeOverride auf der Box.
    mutating func setOverride(_ body: JSONValue, now: Date) -> LinkResponse {
        var until: Date?
        if let v = body["durationMin"], !v.isNull {
            guard let minutes = v.number, minutes > 0 else { return Self.bad("durationMin must be > 0") }
            guard minutes <= 48 * 60 else { return Self.bad("until must be within 48 h") }
            until = now.addingTimeInterval(minutes * 60)
        }
        // Eine laufende Vorgabe endet hier; was sie geladen hat, bleibt im Auto.
        finishOverride(at: now)
        let o: State.Override
        if body["kind"]?.string == "stop" {
            o = State.Override(kind: "stop", powerW: 0, requestedW: 0, startedAt: now, until: until)
        } else {
            guard let p = body["powerW"]?.number, p > 0 else { return Self.bad("powerW must be > 0") }
            o = State.Override(kind: "charge", powerW: min(11_000, max(4140, p)).rounded(), requestedW: p.rounded(), startedAt: now, until: until)
        }
        update { $0.evOverride = o }
        // Im Not-Halt steuert DVhub die Wallbox nicht: gespeichert, wirkt aber erst nach dem Aufheben.
        let result: JSONValue = state.emergencyStop ? ["ok": false, "skipped": "paused"] : ["ok": true]
        return Self.ok(["ok": true, "override": overrideJSON(at: now), "result": result])
    }

    mutating func clearOverride(now: Date) -> LinkResponse {
        // Wie die Box: Im Not-Halt bleibt „Laden stoppen“ stehen.
        if state.emergencyStop, state.evOverride?.kind == "stop" { return Self.bad("emergency_stop_active", status: 409) }
        finishOverride(at: now)
        let result: JSONValue = state.emergencyStop ? ["ok": false, "skipped": "paused"] : ["ok": true]
        return Self.ok(["ok": true, "override": .null, "result": result, "error": .null])
    }

    // MARK: Integrationen

    func health(at now: Date) -> JSONValue {
        func entry(_ latency: Double, _ errors: Int, ago: TimeInterval, firmware: JSONValue = .null) -> JSONValue {
            ["latencyMs": Self.num(latency), "uptimeSec": 266_400, "errors24h": .int(Int64(errors)),
             "lastSampleAt": .string(Self.iso(now.addingTimeInterval(-ago))), "firmware": firmware, "status": "ok", "statusReason": "ok"]
        }
        let t = now.timeIntervalSince1970
        return ["victron": entry(34 + 6 * sin(t / 13), 0, ago: 3, firmware: "v3.62"), "epex": entry(410 + 30 * sin(t / 29), 1, ago: 1500),
                "mqtt": entry(4, 0, ago: 2), "featured": ["victronHeartbeatSec": 3, "victronEssMode": 3]]
    }

    func dataflow(at now: Date) -> JSONValue {
        let l = live(at: now)
        let at = Self.ms(now.addingTimeInterval(-60))
        return [
            "ok": true, "generatedAt": .string(Self.iso(now)), "profile": "victron",
            "in": ["source": ["kind": "modbus", "label": "Victron GX (Modbus TCP)"], "inputs": []],
            "seen": [
                ["key": "grid", "label": .string(L("Netz")), "value": Self.num(l.gridImportW - l.gridExportW), "unit": "W", "note": .string(L("Vorzeichen: + = Bezug"))],
                ["key": "pvTotalW", "label": .string(L("PV gesamt")), "value": Self.num(l.pvW), "unit": "W"],
                ["key": "batteryPowerW", "label": .string(L("Akku (Laden +)")), "value": Self.num(l.batteryW), "unit": "W"],
                ["key": "soc", "label": .string(L("Ladestand")), "value": Self.num(l.soc), "unit": "%"],
                ["key": "selfConsumptionW", "label": .string(L("Hausverbrauch")), "value": Self.num(l.loadW), "unit": "W", "note": .string(L("berechnet aus der Energiebilanz"))],
            ],
            "checks": [],
            "out": [
                "control": [
                    "source": "schedule", "rule": .null, "updatedAt": at, "paused": .bool(state.emergencyStop),
                    "rows": [
                        ["key": "gridSetpointW", "label": .string(L("Netz-Sollwert")), "unit": "W", "value": Self.num(l.gridSetpointW), "source": .string(l.setpointSource)],
                        ["key": "minSocPct", "label": .string(L("Mindest-Ladestand")), "unit": "%", "value": Self.num(Self.minSocPct), "source": "default"],
                    ],
                ],
                "dvSignal": ["value": 1, "forcedOff": false], "gridLimit": .null,
                "lastWrites": state.emergencyStop ? [] : [["key": "gridSetpointW", "value": Self.num(l.gridSetpointW), "writeType": "holding", "source": .string(l.setpointSource), "at": at]],
                "channels": [],
            ],
        ]
    }

    func eosStatus(at now: Date) -> JSONValue {
        ["ok": true, "status": "up", "version": "0.4.0",
         "dvhubEos": ["build": "0.4.0-dvhub.3", "nativeCore": "0.2.0", "label": "DVhub-EOS 0.4.0-dvhub.3 · Rust-Kern 0.2.0"],
         "enabled": true, "reachable": true, "lastOkAt": .string(Self.iso(now.addingTimeInterval(-20))),
         "solutionAt": .string(Self.iso(lastPlanRun(before: now))), "restarts": 0, "push": ["active": true, "count": 12]]
    }

    func vpnStatus(at now: Date) -> JSONValue {
        ["enabled": true, "status": "connected", "protocol": "openvpn", "uptimeSeconds": .int(93_600 + Int64(max(0, now.timeIntervalSince(state.startedAt)).rounded())),
         "reconnectAttempts": 0, "certDaysRemaining": 284, "watchdogOk": true,
         "lastModbusActivity": ["ts": Self.ms(now.addingTimeInterval(-41)), "fc": 3, "addr": 0, "qty": 2]]
    }

    func devices(at now: Date) -> JSONValue {
        let l = live(at: now)
        let day = world.day(containing: now)
        // Tagesenergie der Wärmepumpe: aus den Viertelstunden bis jetzt.
        var heatWh = 0.0
        for i in 0..<day.slotCount where day.start.addingTimeInterval(Double(i) * 900) < now {
            heatWh += world.heatPumpKw(day, hour: (Double(i) + 0.5) / 4) * 250
        }
        return [
            ["id": "d1", "name": .string(L("Wärmepumpe")), "powerW": Self.num(l.heatPumpW), "energyTodayWh": Self.num(heatWh), "online": true, "managed": true],
            ["id": "d2", "name": .string(L("Heizstab Warmwasser")), "powerW": 0, "energyTodayWh": 0, "online": true, "managed": true],
        ]
    }

    func victronDevices(at now: Date) -> JSONValue {
        let car = vehicle(at: now)
        let status = car.charging ? L("lädt") : (car.plugged ? L("bereit") : L("kein Fahrzeug"))
        return ["ok": true, "supported": true, "scannedAt": Self.ms(now.addingTimeInterval(-3600)), "scanning": false, "scanError": .null,
                "devices": [["kind": "evcharger", "unitId": 40, "label": .string(L("Wallbox")), "statusText": .string(status), "connected": .bool(car.plugged),
                             "charging": .bool(car.charging), "powerW": Self.num(car.chargePowerW), "sessionEnergyKwh": 0, "error": .null]]]
    }

    func feedInCap() -> JSONValue {
        ["ok": true, "mode": "static", "configured": true, "limitW": Self.num(Self.feedInLimitW), "pct": 60, "kwp": Self.num(Self.kwp), "path": "native",
         "effectiveW": Self.num(Self.feedInLimitW), "monitor": ["exceeding": false, "current": .null, "episodes": 0, "lastEpisode": .null]]
    }

    func storage(at now: Date) -> JSONValue {
        ["ok": true, "at": Self.ms(now), "freePct": 61, "freeMb": 18_200, "totalMb": 29_800, "level": "ok", "dbMb": 2350, "actions": []]
    }

    /// Was eingerichtet ist — in der Form der Sicht für die App (integrations-view.js): Wahrheitswerte, Zähler, kurze Texte.
    func setup(at now: Date) -> JSONValue {
        [
            "ok": true, "timestamp": Self.ms(now),
            "mqtt": ["enabled": true, "connected": true, "embedded": true, "topicCount": 164, "passwordSet": true, "haDiscovery": true],
            "tesla": ["enabled": false, "name": .null, "hasState": false, "lastUpdate": .null],
            "victron": ["configured": true, "modelId": "MultiPlus-II 48/5000", "firmware": "v3.62"],
            "mid": ["configured": true, "firmware": "1.4"],
            "dveos": ["enabled": true, "active": .bool(!state.emergencyStop), "primarySource": "eos"],
            "luox": ["configured": false, "firmware": .null],
            "loxone": ["configured": false],
            "devices": ["total": 2, "online": 2],
            "notifications": ["enabled": true, "providers": [["name": "ntfy", "enabled": true]]],
            "vrm": ["enabled": true, "portalIdSet": true, "tokenSet": true],
            "forecastProviders": [
                "solcast": ["enabled": false, "apiKeySet": false, "siteIdSet": false],
                "pvnode": ["enabled": true, "apiKeySet": true, "siteIdSet": true, "nowcastEnabled": true],
            ],
            "evcc": ["configured": true, "reachable": true, "loadpointCount": 1, "wallboxType": "evcc", "hasError": false, "charger": .null],
            "p14a": ["available": true, "active": false, "source": .null, "limitW": .null, "pminW": 4200, "devices": 2, "relayEnabled": false],
            "eebus": ["enabled": false, "status": "disabled", "statusLabel": .null, "gridPeer": false, "gridConnected": false, "devices": 0],
            "schedulable": ["total": 2, "deferrable": 1, "modulating": 1, "eosActive": true],
            "pvStrings": ["enabled": true, "sourceCount": 3, "groupCount": 2, "lastSyncAt": Self.ms(now.addingTimeInterval(-600)), "hasError": false],
        ]
    }

    // MARK: Briefkasten

    /// Meldungen, wie die Box sie im Briefkasten hinterlegt (Alarme, Not-Halt).
    public func mailbox() -> [MailboxItem] {
        state.events.map { e in
            let stamp = Int64((e.at.timeIntervalSince1970 * 1000).rounded())
            return MailboxItem(id: "demo-\(stamp)", slot: nil, ts: e.at, message: [
                "t": "event", "ts": .string(Self.iso(e.at)), "kind": "state", "alarmsActive": .int(Int64(e.alarms)),
                "alarmsSeverity": .int(Int64(e.severity)), "emergencyStop": .bool(e.emergencyStop),
            ])
        }
    }
}
