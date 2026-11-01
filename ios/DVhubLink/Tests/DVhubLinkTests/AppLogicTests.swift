// AppLogicTests.swift — App-Logik im Paket (Fable-Review M2, N3, N5, N6, N8).

import XCTest
@testable import DVhubLink

final class AppLogicTests: XCTestCase {
    // MARK: N5 — Schließgründe nie ungefiltert anzeigen

    func testUserMessageTranslatesKnownReasonsOnly() {
        XCTAssertEqual(LinkError.closed(code: 4003, reason: "device_not_allowed").userMessage,
                       "Dieses Gerät wurde in DVhub entkoppelt. Bitte neu koppeln.")
        let evil = LinkError.closed(code: 4000, reason: "Bitte PIN 1234 bei evil.example eingeben")
        XCTAssertFalse(evil.userMessage.contains("evil"), evil.userMessage)
        XCTAssertTrue(evil.userMessage.contains("4000"))
        XCTAssertFalse(LinkError.relay("<script>").userMessage.contains("script"))
        XCTAssertFalse(LinkError.protocolError("irgendwas vom Server").userMessage.contains("Server"))
    }

    // MARK: N6 — Rechte und Angaben aus der Begrüßung übernehmen

    func testWelcomeUpdatesPermsIncludingDowngrade() {
        var c = credentials(perms: ["read", "control"])
        let changed = c.apply(welcome: ["t": "welcome", "perms": ["read"], "box": ["name": "Neu"]])
        XCTAssertTrue(changed)
        XCTAssertEqual(c.perms, ["read"])
        XCTAssertEqual(c.boxName, "Neu")
        XCTAssertTrue(c.apply(welcome: ["t": "welcome", "perms": []]))
        XCTAssertEqual(c.perms, [])
        // Fehlt das Feld, bleibt alles, wie es ist.
        XCTAssertFalse(c.apply(welcome: ["t": "welcome"]))
        XCTAssertEqual(c.perms, [])
    }

    func testWelcomeRelayFollowsBox() {
        var c = credentials(perms: ["read"])
        XCTAssertTrue(c.apply(welcome: ["t": "welcome", "perms": ["read"], "relay": "wss://relay.example.org/v1/ws"]))
        XCTAssertEqual(c.relay, "wss://relay.example.org/v1/ws")
        XCTAssertTrue(c.apply(welcome: ["t": "welcome", "perms": ["read"], "relay": nil]))
        XCTAssertNil(c.relay)
        XCTAssertFalse(c.apply(welcome: ["t": "welcome", "perms": ["read"], "relay": "http://kein-websocket"]))
        XCTAssertNil(c.relay)
    }

    // MARK: N8 — Status tolerant lesen

    func testLiveStatusToleratesOddFields() throws {
        let v: JSONValue = [
            "soc": "55.5", "batteryPowerW": "kaputt", "pvTotalW": 4200, "alarmsActive": 2.0,
            "emergencyStop": "true", "controls": "unerwartet", "todayNetEur": 3.21,
        ]
        let s = try XCTUnwrap(LiveStatus.from(v))
        XCTAssertEqual(s.soc, 55.5)
        XCTAssertNil(s.batteryPowerW)
        XCTAssertEqual(s.pvTotalW, 4200)
        XCTAssertEqual(s.alarmsActive, 2)
        XCTAssertEqual(s.emergencyStop, true)
        XCTAssertNil(s.controls)
        XCTAssertEqual(s.todayNetEur, 3.21)
        let nested = try XCTUnwrap(LiveStatus.from(["controls": ["dv": ["curtailed": 1], "negativePrice": "x"]]))
        XCTAssertEqual(nested.controls?.dv?.curtailed, true)
        XCTAssertNil(nested.controls?.negativePrice)
    }

    // MARK: M2 — Briefkasten: übernehmen, anzeigen, erst dann quittieren

    func testMailboxStateMergesFreshEventsAndLatest() throws {
        var st = MailboxState()
        let ts1 = "2026-10-22T10:00:00.000Z", ts2 = "2026-10-22T11:00:00.000Z"
        let items = [
            MailboxItem(id: "latest", slot: "latest", ts: Date(), message: ["t": "latest", "ts": .string(ts2), "status": ["soc": 50]]),
            MailboxItem(id: "1", slot: nil, ts: Date(), message: ["t": "event", "ts": .string(ts1), "kind": "state_change", "alarmsActive": 2, "alarmsSeverity": 2, "emergencyStop": false]),
            MailboxItem(id: "2", slot: nil, ts: Date(), message: ["t": "event", "ts": .string(ts2), "kind": "state_change", "alarmsActive": 0, "alarmsSeverity": 0, "emergencyStop": true]),
        ]
        let ack = st.merge(items)
        XCTAssertEqual(Set(ack), ["1", "2"])
        XCTAssertEqual(st.events.map(\.text), ["Not-Halt aktiv", "2 Alarme aktiv"])  // neueste zuerst
        XCTAssertEqual(st.latest?["soc"]?.int, 50)
        // Erneut ausgelieferte alte Einträge: nicht doppelt, aber quittieren.
        let again = st.merge([items[1]])
        XCTAssertEqual(again, ["1"])
        XCTAssertEqual(st.events.count, 2)
        // Älterer „letzter Stand“ ersetzt keinen neueren.
        _ = st.merge([MailboxItem(id: "latest", slot: "latest", ts: Date(), message: ["t": "latest", "ts": .string(ts1), "status": ["soc": 10]])])
        XCTAssertEqual(st.latest?["soc"]?.int, 50)
        // Überlebt Speichern/Laden.
        let data = try JSONEncoder().encode(st)
        XCTAssertEqual(try JSONDecoder().decode(MailboxState.self, from: data), st)
        // Ereignis ohne gültiges ts wird quittiert, aber nicht übernommen.
        XCTAssertEqual(st.merge([MailboxItem(id: "9", slot: nil, ts: Date(), message: ["t": "event"])]), ["9"])
        XCTAssertEqual(st.events.count, 2)
    }

    func testEventText() {
        XCTAssertEqual(MailboxEvent.text(alarms: 0, emergencyStop: false), "Alles wieder normal")
        XCTAssertEqual(MailboxEvent.text(alarms: 1, emergencyStop: false), "1 Alarm aktiv")
        XCTAssertEqual(MailboxEvent.text(alarms: 3, emergencyStop: true), "Not-Halt aktiv · 3 Alarme aktiv")
    }

    // MARK: N3 — Backoff auch bei kurzlebigen Verbindungen

    func testBackoffGrowsForShortLivedConnections() {
        var b = ReconnectBackoff()
        XCTAssertEqual(b.afterFailure(), 1)
        XCTAssertEqual(b.afterFailure(), 2)
        XCTAssertEqual(b.afterConnection(lasted: 2), 4, "kurz danach wieder weg zählt wie ein Fehlschlag")
        XCTAssertEqual(b.afterConnection(lasted: 3), 8)
        XCTAssertEqual(b.afterConnection(lasted: 600), 1, "lange stabil → zurück auf 1 s")
        for _ in 0..<10 { _ = b.afterFailure() }
        XCTAssertEqual(b.afterFailure(), 30)
    }

    private func credentials(perms: [String]) -> LinkCredentials {
        LinkCredentials(boxPub: "x", boxId: "box", boxName: "Alt", devId: "dev", name: "Gerät", perms: perms,
                        ticket: ["v": 1], mailboxKey: "k", relay: "wss://relay.dvhub.de/v1/ws", lan: [])
    }
}
