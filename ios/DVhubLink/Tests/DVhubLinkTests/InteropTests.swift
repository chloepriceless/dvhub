// InteropTests.swift — gegen die echte Node-Gegenstelle (ios/interop/harness.mjs).
// Übersprungen ohne DVHUB_INTEROP_QR_FILE bzw. DVHUB_INTEROP_QR.
//
//   HARNESS_QR_FILE=/tmp/qr.txt node ios/interop/harness.mjs &
//   DVHUB_INTEROP_QR_FILE=/tmp/qr.txt swift test --filter InteropTests

import XCTest
@testable import DVhubLink

final class InteropTests: XCTestCase {
    /// Zuletzt verbrauchter QR-Code (der Harness gibt danach einen neuen aus).
    nonisolated(unsafe) static var lastUsedQR: String?

    func currentQR() throws -> String {
        let env = ProcessInfo.processInfo.environment
        if let file = env["DVHUB_INTEROP_QR_FILE"], let text = try? String(contentsOfFile: file, encoding: .utf8) {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let qr = env["DVHUB_INTEROP_QR"] { return qr }
        throw XCTSkip("DVHUB_INTEROP_QR_FILE/DVHUB_INTEROP_QR nicht gesetzt — Interop übersprungen")
    }

    /// Wartet, bis der Harness nach der letzten Kopplung einen neuen QR-Code hat.
    func freshQR() async throws -> String {
        for _ in 0..<50 {
            let qr = try currentQR()
            if !qr.isEmpty, qr != Self.lastUsedQR { Self.lastUsedQR = qr; return qr }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw LinkError.timeout
    }

    func pairAndConnect(via kind: LinkRoute.Kind) async throws -> (LinkCredentials, SoftwareSigner, DeviceConnection, String) {
        let qr = try await freshQR()
        let payload = try PairPayload(qr)
        let signer = SoftwareSigner()
        let url: URL? = kind == .relay ? payload.relay.flatMap(URL.init(string:)) : payload.lan.first.flatMap(URL.init(string:))
        var waitCode: String?
        let creds = try await pairDevice(qr: qr, signer: signer, name: "Swift-Test", model: "macOS", url: try XCTUnwrap(url)) { waitCode = $0 }
        XCTAssertEqual(waitCode?.count, 6, "p_wait mit Vergleichscode muss vor p_ok kommen")
        // Gleicher Code auf der Box-Seite (falls der Agent ihn liefert).
        if let file = ProcessInfo.processInfo.environment["DVHUB_INTEROP_QR_FILE"],
           let boxCode = try? String(contentsOfFile: file + ".code", encoding: .utf8), !boxCode.isEmpty {
            XCTAssertEqual(boxCode.trimmingCharacters(in: .whitespacesAndNewlines), waitCode)
        }
        XCTAssertEqual(creds.devId, signer.id)
        XCTAssertNotNil(verifyTicket(creds.ticket))
        let route = try XCTUnwrap(creds.routes.first { $0.kind == kind })
        let conn = try await DeviceConnection.connect(credentials: creds, signer: signer, route: route)
        return (creds, signer, conn, qr)
    }

    func testPairConnectLiveAndPermissionsViaRelay() async throws {
        let (creds, _, conn, _) = try await pairAndConnect(via: .relay)
        let ready = await conn.isSessionReady
        XCTAssertTrue(ready)
        let perms = await conn.perms
        XCTAssertTrue(perms.contains("read"))

        // Live-Abo: mindestens zwei Werte mit SoC.
        try await conn.subscribe(live: true, intervalMs: 1000)
        var lives: [JSONValue] = []
        for await ev in conn.events {
            if case .live(let status, _) = ev { lives.append(status) }
            if lives.count >= 2 { break }
        }
        XCTAssertNotNil(lives.first?["soc"]?.double)

        let status = try await conn.request("GET", "/api/status")
        XCTAssertEqual(status.status, 200)
        XCTAssertNotNil(status.body["victron"]?["soc"]?.double)

        let forbidden = try await conn.request("GET", "/api/config")
        XCTAssertEqual(forbidden.status, 403)

        let control = try await conn.request("POST", "/api/control/stop", body: [:])
        if creds.canControl {
            XCTAssertEqual(control.status, 200)
            _ = try await conn.request("POST", "/api/control/resume", body: [:])
        } else {
            XCTAssertEqual(control.status, 403)
            XCTAssertEqual(control.body["error"]?.string, "control_not_allowed")
        }

        // Briefkasten: der Harness legt alle 3 s den letzten Stand ab.
        try await Task.sleep(nanoseconds: 3_500_000_000)
        let items = try await conn.fetchMailbox()
        let latest = try XCTUnwrap(items.first { $0.slot == "latest" })
        XCTAssertEqual(latest.message["t"]?.string, "latest")
        XCTAssertNotNil(latest.message["status"]?["soc"])
        await conn.close()
    }

    /// Zeitplan, E-Auto und Integrationen über die echte Gegenstelle: die Rechte
    /// prüft der echte Agent (permissions.js), die Integrationen baut die echte
    /// Sicht für die App (integrations-view.js) aus einer Übersicht voller Köder.
    func testScheduleEvAndRedactedIntegrationsThroughTheRealAgent() async throws {
        let (creds, _, conn, _) = try await pairAndConnect(via: .relay)
        guard creds.canControl else {
            let denied = try await conn.request("POST", "/api/schedule/rules", body: ["rules": []])
            XCTAssertEqual(denied.body["error"]?.string, "control_not_allowed")
            await conn.close()
            throw XCTSkip("Harness ohne Recht „Steuern“ (HARNESS_PERMS=read,control)")
        }
        // Integrationen: nur die Sicht für die App — ohne Adressen und Kennungen.
        let full = try await conn.request("GET", "/api/integrations/status")
        XCTAssertEqual(full.status, 403)
        let setup = try await conn.request("GET", "/api/mobile-link/integrations")
        XCTAssertEqual(setup.status, 200)
        let text = String(decoding: try setup.body.encoded(), as: UTF8.self)
        for bait in ["10.11.12.", "koeder", "KOEDER", "://", "latitude", "53.55"] { XCTAssertFalse(text.contains(bait), "Köder \(bait) in der Antwort") }
        XCTAssertEqual(setup.body["victron"]?["modelId"]?.string, "MultiPlus-II 48/5000")
        XCTAssertEqual(setup.body["mqtt"]?["passwordSet"]?.bool, true)

        // Zeitplan: Regel anlegen, ändern, umschalten, löschen — Plan-Regeln bleiben unberührt.
        func schedule() async throws -> JSONValue { try await conn.request("GET", "/api/schedule").body }
        func post(_ path: String, _ body: JSONValue) async throws -> WriteOutcome { WriteOutcome.from(try await conn.request("POST", path, body: body)) }
        func evNow() async throws -> EVState {
            let r = try await conn.request("GET", "/api/ev")
            return try XCTUnwrap(EVState.from(r.body))
        }
        let before = ScheduleEdit.rules(from: try await schedule())
        let planned = before.filter(\.isAutomation).map(\.raw)
        XCTAssertFalse(planned.isEmpty)
        let draft = ScheduleEdit.Draft(target: "gridSetpointW", start: "21:00", end: "23:30", value: -1500, stopSocPct: 30)
        let scheduleBefore = try await schedule()
        let add = try ScheduleEdit.payload(schedule: scheduleBefore, change: .add(draft), newId: { "app-interop" }).get()
        let added = try await post("/api/schedule/rules", add)
        XCTAssertEqual(added, .done)
        var rules = ScheduleEdit.rules(from: try await schedule())
        let mine = try XCTUnwrap(rules.first { $0.ruleId == "app-interop" })
        XCTAssertEqual(mine.value, -1500)
        XCTAssertEqual(mine.stopSocPct, 30)
        XCTAssertTrue(mine.isEditable)
        XCTAssertEqual(rules.filter(\.isAutomation).map(\.raw), planned)
        XCTAssertEqual(rules.count, before.count + 1)

        var changed = draft
        changed.value = 2200
        changed.stopSocPct = nil
        let update = try ScheduleEdit.payload(schedule: try await schedule(), change: .update(mine, changed)).get()
        let updated = try await post("/api/schedule/rules", update)
        XCTAssertEqual(updated, .done)
        // Die alte Fassung der Regel gilt jetzt als überholt: nichts wird geschickt.
        let afterUpdate = try await schedule()
        XCTAssertEqual(ScheduleEdit.payload(schedule: afterUpdate, change: .remove(mine)), .failure(.changedMeanwhile))
        let toggled = try await conn.request("POST", "/api/schedule/rules/toggle", body: ["ids": ["app-interop"], "enabled": false])
        XCTAssertEqual(toggled.status, 200)
        rules = ScheduleEdit.rules(from: try await schedule())
        let now = try XCTUnwrap(rules.first { $0.ruleId == "app-interop" })
        XCTAssertEqual(now.value, 2200)
        XCTAssertNil(now.stopSocPct)
        XCTAssertFalse(now.enabled)
        let remove = try ScheduleEdit.payload(schedule: try await schedule(), change: .remove(now)).get()
        let removed = try await post("/api/schedule/rules", remove)
        XCTAssertEqual(removed, .done)
        rules = ScheduleEdit.rules(from: try await schedule())
        XCTAssertNil(rules.first { $0.ruleId == "app-interop" })
        // Danach steht alles wie vorher: dieselben Regeln (die Box stellt Regeln von Hand vor die Plan-Regeln,
        // wie nach jedem Speichern in der Weboberfläche; Laufzeit-Markierungen gehen nicht mit zurück).
        XCTAssertEqual(rules.filter(\.isAutomation).map(\.raw), planned)
        XCTAssertEqual(rules.filter { !$0.isAutomation }.map { ScheduleEdit.clean($0.raw) }, before.filter { !$0.isAutomation }.map { ScheduleEdit.clean($0.raw) })

        // Börsenautomatik lesen; Grundwerte schreiben und zurückstellen.
        let auto = try await conn.request("GET", "/api/schedule/automation/config")
        XCTAssertEqual(auto.status, 200)
        XCTAssertNotNil(auto.body["config"]?["searchWindowStart"]?.string)
        // Der Standort der Anlage steht in der Config der Automatik — die App bekommt und ändert ihn nicht.
        XCTAssertNil(auto.body["config"]?["location"])
        let autoText = String(decoding: try auto.body.encoded(), as: UTF8.self)
        XCTAssertFalse(autoText.contains("latitude") || autoText.contains("koeder"), autoText)
        let moveHouse = try await post("/api/schedule/automation/config", ["location": ["latitude": 1, "longitude": 2]])
        if case .invalid(let e) = moveHouse { XCTAssertEqual(e, "field_not_allowed:location") } else { XCTFail("Standort wurde angenommen: \(moveHouse)") }
        let reserve = try await post("/api/schedule/automation/config", ["minSocPct": 25.0])
        XCTAssertEqual(reserve, .done)
        _ = try await post("/api/schedule/automation/config", ["minSocPct": 20.0])
        let scheduleNow = try await schedule()
        let oldDefault = try XCTUnwrap(scheduleNow["config"]?["defaultGridSetpointW"]?.number)
        let setDefault = try await post("/api/schedule/config", ["defaultGridSetpointW": -75])
        XCTAssertEqual(setDefault, .done)
        let newDefault = try await schedule()["config"]?["defaultGridSetpointW"]?.number
        XCTAssertEqual(newDefault, -75)
        _ = try await conn.request("POST", "/api/schedule/config", body: ["defaultGridSetpointW": .double(oldDefault)])

        // E-Auto: Einmal-Ziel setzen und löschen; die Box lehnt Vergangenes ab.
        let ev = try await evNow()
        XCTAssertEqual(ev.week.count, 7)
        let at = Date().addingTimeInterval(8 * 3600)
        let once = try XCTUnwrap(EVEdit.once(at: at, minSocPct: 85))
        let onceSet = try await post("/api/ev", once)
        XCTAssertEqual(onceSet, .done)
        let withOnce = try await evNow()
        XCTAssertEqual(withOnce.onceMinSocPct, 85)
        XCTAssertEqual(withOnce.nextSource, "once")
        XCTAssertEqual(withOnce.once?.timeIntervalSince(at) ?? 99, 0, accuracy: 1)
        let tooSoon: JSONValue = ["departure": ["once": .string(EVEdit.isoString(Date().addingTimeInterval(60))), "onceMinSocPct": 80]]
        let soon = try await post("/api/ev", tooSoon)
        if case .invalid = soon {} else { XCTFail("zu naher Termin wurde angenommen: \(soon)") }
        let cleared = try await post("/api/ev", EVEdit.clearOnce())
        XCTAssertEqual(cleared, .done)
        let afterClear = try await evNow()
        XCTAssertNil(afterClear.once)
        // Sofortladen ist für die App nicht freigegeben.
        let override = try await conn.request("POST", "/api/ev/override", body: ["powerW": 11000])
        XCTAssertEqual(override.status, 403)
        await conn.close()
    }

    func testPairAndConnectViaLan() async throws {
        let qr = try currentQR()
        let hasLan = qr.isEmpty ? true : !(try PairPayload(qr).lan.isEmpty)
        guard hasLan else { throw XCTSkip("QR ohne Heimnetz-Adresse") }
        let (_, signer, conn, _) = try await pairAndConnect(via: .lan)
        let res = try await conn.request("GET", "/api/telemetry/series?keys=pv_total_w,battery_soc_pct&maxResolution=900")
        XCTAssertEqual(res.status, 200)
        XCTAssertGreaterThan(res.body["data"]?.array?.count ?? 0, 0)
        let creds = await conn.currentCredentials
        await conn.close()
        // Mit denselben Zugangsdaten erneut verbinden (zweite Sitzung, neue Schlüssel).
        let again = try await DeviceConnection.connect(credentials: creds, signer: signer, route: try XCTUnwrap(creds.routes.first))
        let r2 = try await again.request("GET", "/api/status")
        XCTAssertEqual(r2.status, 200)
        await again.close()
    }

    func testQRIsSingleUse() async throws {
        let (_, _, conn, usedQR) = try await pairAndConnect(via: .relay)
        await conn.close()
        // Derselbe QR-Code darf kein zweites Gerät koppeln.
        do {
            _ = try await pairDevice(qr: usedQR, signer: SoftwareSigner(), name: "Zweitgerät", model: "macOS",
                                     url: try XCTUnwrap(PairPayload(usedQR).relay.flatMap(URL.init(string:))), waitTimeout: 5)
            XCTFail("Zweite Kopplung mit demselben QR-Code darf nicht gelingen")
        } catch {
            // erwartet: pairing_not_open / auth_failed
        }
    }

    func testForeignDeviceRejected() async throws {
        let qr = try await freshQR()
        Self.lastUsedQR = nil
        let payload = try PairPayload(qr)
        // Ein selbst gebautes Ticket ohne Box-Signatur kommt nicht durch.
        let fake = SoftwareSigner()
        let creds = LinkCredentials(
            boxPub: Base64URL.encode(payload.boxPublicRaw), boxId: payload.boxId, boxName: "x", devId: fake.id,
            name: "x", perms: ["read", "control"],
            ticket: ["v": 1, "box": .string(Base64URL.encode(payload.boxPublicRaw)), "dev": .string(fake.id), "exp": 4_102_444_800,
                     "sig": .string(Base64URL.encode(try fake.sign(Data("x".utf8))))],
            mailboxKey: Base64URL.encode(Data(repeating: 0, count: 32)), relay: payload.relay, lan: payload.lan
        )
        do {
            _ = try await DeviceConnection.connect(credentials: creds, signer: fake, route: LinkRoute(url: try XCTUnwrap(URL(string: payload.relay ?? "")), kind: .relay))
            XCTFail("gefälschtes Ticket muss abgelehnt werden")
        } catch let e as LinkError {
            if case .closed(let code, _) = e { XCTAssertEqual(code, 4002) } else { XCTFail("unerwartet: \(e)") }
        }
    }
    /// Box geht offline (Harness SIGUSR1) und kommt wieder (SIGUSR2): Ereignis
    /// boxOffline, Briefkasten bleibt abholbar, danach neuer Handshake von selbst.
    func testBoxOfflineMailboxAndRecovery() async throws {
        guard let pidText = ProcessInfo.processInfo.environment["DVHUB_INTEROP_HARNESS_PID"], let pid = Int32(pidText) else {
            throw XCTSkip("DVHUB_INTEROP_HARNESS_PID nicht gesetzt")
        }
        let (_, _, conn, _) = try await pairAndConnect(via: .relay)
        try await Task.sleep(nanoseconds: 3_500_000_000)  // Briefkasten füllen lassen
        kill(pid, SIGUSR1)
        var sawOffline = false
        for await ev in conn.events {
            if case .boxOffline = ev { sawOffline = true; break }
        }
        XCTAssertTrue(sawOffline)
        let readyOffline = await conn.isSessionReady
        XCTAssertFalse(readyOffline)
        let items = try await conn.fetchMailbox()
        XCTAssertNotNil(items.first { $0.slot == "latest" }?.message["status"]?["soc"])
        do { _ = try await conn.request("GET", "/api/status"); XCTFail("ohne Box keine Antwort") } catch {}
        kill(pid, SIGUSR2)
        var reconnected = false
        for await ev in conn.events {
            if case .connected = ev { reconnected = true; break }
        }
        XCTAssertTrue(reconnected)
        let r = try await conn.request("GET", "/api/status")
        XCTAssertEqual(r.status, 200)
        await conn.close()
    }
    /// H1: Viele Anfragen gleichzeitig mit unterschiedlicher Priorität — die
    /// Rahmen müssen in Zähler-Reihenfolge rausgehen, sonst verwirft die Box
    /// die Sitzung (decrypt_failed).
    func testParallelRequestsKeepOrder() async throws {
        let (_, _, conn, _) = try await pairAndConnect(via: .relay)
        try await conn.subscribe(live: true, intervalMs: 1000)
        let statuses = try await withThrowingTaskGroup(of: Int.self) { group -> [Int] in
            for i in 0..<24 {
                let prio: TaskPriority = [.high, .low, .background, .userInitiated][i % 4]
                group.addTask(priority: prio) {
                    if i % 7 == 0 { try await conn.subscribe(live: true, intervalMs: 1000) }
                    return try await conn.request("GET", "/api/status").status
                }
            }
            var out: [Int] = []
            for try await s in group { out.append(s) }
            return out
        }
        XCTAssertEqual(statuses.count, 24)
        // 429 = Parallelgrenze der Box (gewollt), alles andere wäre ein Fehler.
        XCTAssertTrue(statuses.allSatisfy { $0 == 200 || $0 == 429 }, "\(statuses)")
        XCTAssertTrue(statuses.contains(200))
        // Lebt die Sitzung noch? Live-Werte kommen weiter an (eine kaputte
        // Zähler-Reihenfolge beendet die Sitzung auf der Box sofort). Nicht über
        // Anfragen prüfen — die zählen gegen das Minutenbudget der Box.
        var lives = 0
        for await ev in conn.events {
            if case .live = ev { lives += 1 }
            if case .closed = ev { break }
            if lives >= 2 { break }
        }
        XCTAssertGreaterThanOrEqual(lives, 2, "Sitzung nach paralleler Last nicht mehr nutzbar")
        await conn.close()
    }

    /// Einzelabruf ohne Dauer-Verbindung (Widgets, Hintergrundabruf, Kurzbefehle):
    /// frischer Stand von der Box, daneben bleibt eine zweite Verbindung
    /// desselben Geräts ungestört.
    func testQuickSnapshotLiveAndSideBySide() async throws {
        let (creds, signer, conn, _) = try await pairAndConnect(via: .relay)
        let snap = try await QuickLink.snapshot(credentials: creds, signer: signer)
        XCTAssertTrue(snap.live)
        XCTAssertNotNil(snap.status.soc)
        XCTAssertEqual(snap.perms?.contains("read"), true)
        XCTAssertLessThan(abs(snap.at.timeIntervalSinceNow), 60)
        // Die erste Verbindung (die „App“) lebt weiter.
        let r = try await conn.request("GET", "/api/status")
        XCTAssertEqual(r.status, 200)
        await conn.close()
    }

    /// Not-Halt als Einzelabruf: Antwort auswerten, danach kommt der neue Stand
    /// über dieselbe Verbindung; verbotene Pfade bleiben verboten.
    func testQuickRequestEmergencyStopAndOutcome() async throws {
        let (creds, signer, conn, _) = try await pairAndConnect(via: .relay)
        await conn.close()
        guard creds.canControl else { throw XCTSkip("Harness ohne Recht „control“ (HARNESS_PERMS=read,control)") }
        let stop = try await QuickLink.request(credentials: creds, signer: signer, method: "POST", path: "/api/control/stop", body: [:])
        XCTAssertTrue(ControlOutcome.from(stop.response).applied, "\(stop.response.status) \(stop.response.body)")
        XCTAssertEqual(stop.after?.status.emergencyStop, true)
        let resume = try await QuickLink.request(credentials: creds, signer: signer, method: "POST", path: "/api/control/resume", body: [:])
        XCTAssertEqual(ControlOutcome.from(resume.response), .done)
        XCTAssertEqual(resume.after?.status.emergencyStop, false)
        let forbidden = try await QuickLink.request(credentials: creds, signer: signer, method: "POST", path: "/api/config", body: [:])
        XCTAssertEqual(ControlOutcome.from(forbidden.response), .notAllowed)
    }

    /// Box nicht verbunden: Der Einzelabruf liefert den letzten Stand aus dem
    /// Briefkasten (nicht live); Schalten meldet „nicht verbunden“.
    func testQuickSnapshotFallsBackToMailbox() async throws {
        guard let pidText = ProcessInfo.processInfo.environment["DVHUB_INTEROP_HARNESS_PID"], let pid = Int32(pidText) else {
            throw XCTSkip("DVHUB_INTEROP_HARNESS_PID nicht gesetzt")
        }
        let (creds, signer, conn, _) = try await pairAndConnect(via: .relay)
        try await Task.sleep(nanoseconds: 3_500_000_000)  // Briefkasten füllen lassen
        await conn.close()
        kill(pid, SIGUSR1)
        defer { kill(pid, SIGUSR2) }
        try await Task.sleep(nanoseconds: 500_000_000)
        var relayOnly = creds
        relayOnly.lan = []
        let snap = try await QuickLink.snapshot(credentials: relayOnly, signer: signer)
        XCTAssertFalse(snap.live)
        XCTAssertNotNil(snap.status.soc)
        do {
            _ = try await QuickLink.request(credentials: relayOnly, signer: signer, method: "POST", path: "/api/control/stop", body: [:])
            XCTFail("ohne Box darf nicht geschaltet werden")
        } catch LinkError.boxOffline {
        } catch {
            XCTFail("unerwarteter Fehler \(error)")
        }
    }
}
