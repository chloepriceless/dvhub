// DemoConnectionTests.swift — die Verbindung zur Demo-Anlage: gleiche Ereignisse
// und Antworten wie die echte, aber ohne jeden Netzzugriff.

import XCTest
@testable import DVhubLink

/// Fängt jede HTTP-Anfrage ab, die über URLSession läuft, und zählt sie.
final class NetworkSpy: URLProtocol {
    nonisolated(unsafe) static var requests: [URL] = []
    private static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let url = request.url { requests.append(url) }
        return true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    override func stopLoading() {}
}

/// Zählt, wie oft ein Socket verlangt wird.
final class SocketCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return n }
    func make(_ url: URL) -> LinkSocket {
        lock.lock(); n += 1; lock.unlock()
        return FakeSocket()
    }
}

final class DemoConnectionTests: XCTestCase {
    let start = demoDate(2026, 11, 24, 10)

    func box(now: Date? = nil, onChange: (@Sendable (DemoPlant.State) -> Void)? = nil) -> DemoBox {
        let at = now ?? start.addingTimeInterval(1800)
        return DemoBox(state: .init(startedAt: start), calendar: demoCalendar(), clock: { at }, onChange: onChange)
    }

    func testConnectionGreetsStreamsLiveValuesAndAnswers() async throws {
        let conn = DemoConnection(box: box(), name: "Demo-Anlage", latency: .zero)
        XCTAssertEqual(conn.route.kind, .demo)
        let ready = await conn.isSessionReady
        XCTAssert(ready)
        try await conn.subscribe(live: true, intervalMs: 500)
        var greeted = false
        var lives: [LiveStatus] = []
        for await ev in conn.events {
            switch ev {
            case .connected(let welcome, let ticket):
                greeted = true
                XCTAssertNil(ticket)
                XCTAssertEqual(welcome["perms"]?.array?.compactMap(\.string), ["read", "control"])
                XCTAssertEqual(welcome["box"]?["name"]?.string, "Demo-Anlage")
                // Die Begrüßung ändert die Zugangsdaten der Demo nicht (nichts zu speichern).
                var creds = LinkCredentials.demo(name: "Demo-Anlage")
                XCTAssertFalse(creds.apply(welcome: welcome))
            case .live(let status, let ts):
                XCTAssertNotNil(parseISODate(ts))
                lives.append(try XCTUnwrap(LiveStatus.from(status)))
            default: break
            }
            if lives.count == 2 { break }
        }
        XCTAssert(greeted, "erst die Begrüßung, dann Live-Werte")
        XCTAssertNotNil(lives[0].soc)

        let status = try await conn.request("GET", "/api/status")
        XCTAssertEqual(status.status, 200)
        XCTAssertNotNil(StatusDetail.from(status: status.body)?.pvTotalW)
        let stop = try await conn.request("POST", "/api/control/stop", body: [:])
        XCTAssertEqual(ControlOutcome.from(stop), .done)
        let items = try await conn.fetchMailbox()
        var mailbox = MailboxState()
        let ack = mailbox.merge(items)
        XCTAssertEqual(mailbox.events.first?.emergencyStop, true)
        try await conn.ackMailbox(ack)
        // Dieselben Meldungen noch einmal: nichts doppelt.
        _ = mailbox.merge(try await conn.fetchMailbox())
        XCTAssertEqual(mailbox.events.count, items.count)

        await conn.close()
        let after = await conn.isSessionReady
        XCTAssertFalse(after)
        do {
            _ = try await conn.request("GET", "/api/status")
            XCTFail("nach dem Schließen antwortet die Verbindung nicht mehr")
        } catch {}
    }

    func testCloseEndsTheEventStream() async throws {
        let conn = DemoConnection(box: box(), name: "Demo", latency: .zero)
        try await conn.subscribe(live: true, intervalMs: 500)
        let reader = Task { () -> Bool in
            var closed = false
            for await ev in conn.events { if case .closed(let e) = ev { closed = e == nil } }
            return closed
        }
        try await Task.sleep(for: .milliseconds(50))
        await conn.close()
        let closedCleanly = await reader.value
        XCTAssert(closedCleanly, "der Strom endet mit „geschlossen“ ohne Fehler")
    }

    func testChangesAreReportedForSavingAndReadsAreNot() async {
        let saved = SavedStates()
        let b = box(onChange: { saved.add($0) })
        _ = await b.request("GET", "/api/status")
        _ = await b.request("GET", "/api/ev")
        _ = await b.status()
        XCTAssertEqual(saved.all.count, 0, "Lesen ändert nichts")
        _ = await b.request("POST", "/api/control/stop", body: [:])
        _ = await b.request("POST", "/api/control/stop", body: [:])
        XCTAssertEqual(saved.all.count, 1, "nur die Änderung wird gemeldet")
        XCTAssertEqual(saved.all.last?.emergencyStop, true)
        // Mit dem gespeicherten Zustand geht es genauso weiter.
        let restored = DemoBox(state: saved.all[0], calendar: demoCalendar(), clock: { self.start })
        let live = await restored.status()
        XCTAssertEqual(LiveStatus.from(live.status)?.emergencyStop, true)
    }

    /// Kein Netz: Die Demo öffnet weder eine HTTP- noch eine Socket-Verbindung —
    /// und die Zugangsdaten der Demo führen auch auf dem echten Weg nirgends hin.
    func testDemoNeverTouchesTheNetwork() async throws {
        NetworkSpy.requests = []
        XCTAssert(URLProtocol.registerClass(NetworkSpy.self))
        defer { URLProtocol.unregisterClass(NetworkSpy.self) }

        let b = box()
        let conn = DemoConnection(box: b, name: "Demo-Anlage", latency: .zero)
        try await conn.subscribe(live: true, intervalMs: 500)
        let iso = ISO8601DateFormatter()
        let day = "start=\(iso.string(from: demoDate(2026, 11, 24, 0)))&end=\(iso.string(from: demoDate(2026, 11, 25, 0)))".replacingOccurrences(of: ":", with: "%3A")
        let reads = ["/api/status", "/api/telemetry/series?keys=pv_total_w,battery_soc_pct&\(day)&maxResolution=300",
                     "/api/history/summary?view=day&date=2026-11-24&lean=1", "/api/history/summary?view=week&date=2026-11-24&lean=1",
                     "/api/history/summary?view=month&date=2026-11-24&lean=1", "/api/history/summary?view=year&date=2026-11-24&lean=1",
                     "/api/eos/plan?rows=192", "/api/schedule", "/api/schedule/automation/config", "/api/ev", "/api/integrations/health",
                     "/api/integrations/dataflow", "/api/eos/status", "/api/vpn/status", "/api/devices", "/api/victron/devices",
                     "/api/feed-in-cap/status", "/api/storage/status", "/api/mobile-link/integrations"]
        for path in reads {
            let r = try await conn.request("GET", path)
            XCTAssertEqual(r.status, 200, path)
        }
        let writes: [(String, String, JSONValue)] = [
            ("POST", "/api/control/stop", [:]), ("POST", "/api/control/resume", [:]),
            ("POST", "/api/schedule/config", ["defaultGridSetpointW": -80]),
            ("POST", "/api/schedule/automation/config", ["enabled": true]), ("POST", "/api/schedule/automation/replan", [:]),
            ("POST", "/api/ev", ["optimizeEv": false]), ("POST", "/api/ev/override", ["kind": "charge", "powerW": 7000]),
            ("DELETE", "/api/ev/override", .null),
        ]
        for (method, path, body) in writes {
            let r = try await conn.request(method, path, body: body.isNull ? nil : body)
            XCTAssertEqual(r.status, 200, path)
        }
        _ = try await conn.fetchMailbox()
        let market = DemoMarket(world: b.world)
        for path in ["api/prices", "api/prices/tomorrow-status", "v1/residual-load/outlook", "api/news"] {
            XCTAssertNotNil(market.respond(path: path, now: start))
        }
        await conn.close()
        XCTAssertEqual(NetworkSpy.requests, [], "die Demo hat das Netz angefasst")

        // Die Demo-Anlage in der Liste trägt keinen Weg, kein Ticket, keinen Schlüssel.
        let creds = LinkCredentials.demo(name: "Demo-Anlage")
        XCTAssert(creds.isDemo)
        XCTAssert(creds.routes.isEmpty)
        XCTAssertNil(creds.relay)
        XCTAssertNil(creds.keyRef)
        XCTAssert(creds.canControl)
        XCTAssertNotEqual(DemoPlant.boxId.count, keyId(Data(repeating: 4, count: 65)).count, "keine echte Kennung kann „demo“ heißen")
        // Selbst wer mit diesen Zugangsdaten den echten Weg ginge, bekäme keinen Socket.
        let sockets = SocketCounter()
        do {
            _ = try await QuickLink.connect(credentials: creds, signer: try SoftwareSigner(), socketFactory: sockets.make)
            XCTFail("ohne Weg keine Verbindung")
        } catch {}
        XCTAssertEqual(sockets.count, 0)
    }
}

final class SavedStates: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [DemoPlant.State] = []
    var all: [DemoPlant.State] { lock.lock(); defer { lock.unlock() }; return states }
    func add(_ s: DemoPlant.State) { lock.lock(); states.append(s); lock.unlock() }
}
