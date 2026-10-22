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
}
