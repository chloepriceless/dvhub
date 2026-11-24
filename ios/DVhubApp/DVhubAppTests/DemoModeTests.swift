// DemoModeTests.swift — der Demo-Modus in der App (läuft im Prozess der App):
// starten und beenden, die Demo als eigener Eintrag der Anlagenliste, Bedienen
// ohne Bestätigung am Gerät, Stand für Widgets — und vor allem: Solange die
// Demo gewählt ist, führt kein Weg zu einer gekoppelten Anlage.

import XCTest
import DVhubLink
@testable import DVhub

@MainActor
final class DemoModeTests: XCTestCase {
    private var selectedBefore: String?
    private var localBefore: String?

    override func setUp() async throws {
        selectedBefore = SharedStore.selectedSystemId
        localBefore = UserDefaults.standard.string(forKey: AppModel.selectedKey)
        DemoStore.end()
    }

    override func tearDown() async throws {
        DemoStore.end()
        SystemController.forgetMailbox(DemoPlant.boxId)
        SharedStore.selectedSystemId = selectedBefore
        UserDefaults.standard.set(localBefore, forKey: AppModel.selectedKey)
    }

    /// Wartet, bis `condition` gilt (höchstens `seconds`).
    private func eventually(_ what: String, within seconds: Double = 5, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(40)) }
        XCTAssert(condition(), what, file: file, line: line)
    }

    // MARK: Starten, bedienen, beenden

    func testDemoIsItsOwnMarkedEntryAndEndsCleanly() async throws {
        let model = AppModel()
        model.activate()
        let paired = model.systems
        XCTAssertFalse(model.demoActive)
        XCTAssertFalse(model.entries.contains { $0.isDemo })

        model.startDemo()
        XCTAssert(model.demoActive)
        XCTAssert(model.selectedIsDemo)
        XCTAssertEqual(model.entries.filter(\.isDemo).count, 1, "genau ein Eintrag, als Demo erkennbar")
        XCTAssertEqual(model.systems, paired, "die gekoppelten Anlagen bleiben, wie sie sind")
        XCTAssert(DemoStore.isSelected)
        let demo = try XCTUnwrap(model.selected)
        XCTAssert(demo.isDemo)
        XCTAssert(demo.credentials.routes.isEmpty, "die Demo hat keinen Weg nach außen")
        XCTAssertNil(demo.credentials.keyRef)

        await eventually("die Demo verbindet sich sofort") { demo.state == .online(.demo) }
        await eventually("Live-Werte kommen") { demo.displayStatus?.soc != nil }
        XCTAssert(demo.canControl)
        await demo.refreshDetail(maxAge: 0)
        XCTAssertNotNil(demo.detail?.pvTotalW)
        await demo.refreshToday(maxAge: 0)
        XCTAssertFalse(demo.todayValues(BoxData.socKey).isEmpty)
        if case .ok(let day) = await BoxData.history(demo, view: .day, date: Date()) { XCTAssertNotNil(day.kpi("loadKwh")) } else { XCTFail("Historie fehlt") }
        await eventually("die Meldungen der Demo stehen im Briefkasten") { !demo.events.isEmpty }

        // Im Schlüsselbund steht von der Demo nichts.
        XCTAssertFalse(try KeyStore.loadSystems().contains { $0.isDemo })

        // Neustart der App: Die Demo ist noch da und gewählt.
        let again = AppModel()
        again.activate()
        XCTAssert(again.demoActive)
        XCTAssert(again.selectedIsDemo)
        again.deactivate()

        model.endDemo()
        XCTAssertFalse(model.demoActive)
        XCTAssertFalse(model.entries.contains { $0.isDemo })
        XCTAssertNil(model.controllers[DemoPlant.boxId])
        XCTAssertEqual(model.selectedId, paired.first?.id)
        XCTAssertFalse(DemoStore.isActive)
        XCTAssertFalse(DemoStore.isSelected)
        XCTAssertNil(UserDefaults.standard.data(forKey: "mailbox.\(DemoPlant.boxId)"), "Meldungen der Demo sind fort")
        model.deactivate()
    }

    func testControlsWorkWithoutDeviceConfirmationAndChangeOnlyTheDemo() async throws {
        let model = AppModel()
        model.activate()
        model.startDemo()
        let demo = try XCTUnwrap(model.selected)
        await eventually("verbunden") { demo.isOnline }

        // Not-Halt: keine Rückfrage per Face ID / Code (im Test gäbe es niemanden, der sie beantwortet).
        let stop = await demo.confirmedPost("/api/control/stop", body: [:], reason: "Not-Halt auslösen")
        XCTAssert(stop.ok, stop.text)
        await eventually("der Leitstand zeigt den Not-Halt") { demo.displayStatus?.emergencyStop == true }
        let resume = await demo.confirmedPost("/api/control/resume", body: [:], reason: "Not-Halt aufheben")
        XCTAssert(resume.ok, resume.text)
        await eventually("aufgehoben") { demo.displayStatus?.emergencyStop == false }

        // Sofort laden: Das Haus zieht entsprechend mehr.
        let before = try XCTUnwrap(demo.displayStatus?.loadW)
        let charge = await demo.confirmed("Sofort laden") {
            let r = try await demo.request("POST", "/api/ev/override", body: EVEdit.chargeNow(powerW: 11_000, durationMin: nil))
            let out = OverrideOutcome.from(r, action: .charge)
            return WriteFeedback(ok: out.ok, text: out.message)
        }
        XCTAssert(charge.ok, charge.text)
        await eventually("die Wallbox lädt sichtbar") { (demo.displayStatus?.loadW ?? 0) > before + 6000 }
        let answer = try await demo.request("GET", "/api/ev")
        let ev = try XCTUnwrap(EVState.from(answer.body))
        XCTAssertEqual(ev.override?.stop, false)

        // Der Zustand überlebt einen Neustart der App (gespeichert, nicht im Schlüsselbund).
        XCTAssertNotNil(DemoStore.loadState()?.evOverride)
        // … und nach dem Beenden beginnt eine neue Demo frisch.
        model.endDemo()
        model.startDemo()
        XCTAssertNil(DemoStore.loadState()?.evOverride)
        model.endDemo()
        model.deactivate()
    }

    // MARK: Kein Weg zu einer gekoppelten Anlage

    func testWhileTheDemoIsSelectedNothingReachesAPairedPlant() async throws {
        let model = AppModel()
        model.activate()
        model.startDemo()

        // Widgets, Kurzbefehle und Hintergrundabruf fragen hier nach Zugangsdaten: Es gibt keine.
        XCTAssertThrowsError(try LinkAccess.selected()) { XCTAssertEqual($0 as? LinkAccess.Failure, .demo) }
        // Der Abruf rechnet stattdessen den Stand der Demo.
        guard case .fresh(let snap) = await SnapshotRefresher.refresh(timeout: 3) else { return XCTFail("kein Stand der Demo") }
        XCTAssert(snap.isDemo)
        XCTAssertEqual(snap.boxName, DemoStore.name)
        XCTAssert((0...100).contains(snap.soc ?? -1))
        XCTAssertLessThan(abs(snap.at.timeIntervalSince(DemoStore.now)), 5)

        // Der Not-Halt-Kurzbefehl schaltet nur die Demo.
        let outcome = try await EmergencyStopAction.run(stop: true)
        XCTAssertEqual(outcome, .done)
        XCTAssertEqual(DemoStore.loadState()?.emergencyStop, true)
        XCTAssertEqual(DemoStore.snapshot()?.emergencyStop, true)
        _ = try await EmergencyStopAction.run(stop: false)
        XCTAssertEqual(DemoStore.loadState()?.emergencyStop, false)

        // Vorausgezeichnete Stände für die Widgets: acht Viertelstunden, alle als Demo gekennzeichnet.
        let ahead = SnapshotRefresher.ahead()
        XCTAssertEqual(ahead.count, 8)
        XCTAssert(ahead.allSatisfy(\.isDemo))
        XCTAssertEqual(ahead[1].at.timeIntervalSince(ahead[0].at), 900, accuracy: 0.01)

        model.endDemo()
        XCTAssert(SnapshotRefresher.ahead().isEmpty, "ohne Demo zeichnet kein Widget voraus")
        XCTAssertNil(DemoStore.snapshot())
        // Jetzt gilt wieder die übliche Antwort: keine Anlage — oder die erste gekoppelte.
        if model.systems.isEmpty {
            XCTAssertThrowsError(try LinkAccess.selected()) { XCTAssertEqual($0 as? LinkAccess.Failure, .noSystem) }
        }
        model.deactivate()
    }

    func testAnEndedDemoIsNotRevivedByALateAnswer() async {
        DemoStore.start()
        let box = DemoStore.box
        XCTAssert(DemoStore.isActive)
        DemoStore.end()
        // Eine alte Verbindung antwortet noch — ihr Zustand darf die Demo nicht wieder anlegen.
        _ = await box.request("POST", "/api/control/stop", body: [:])
        XCTAssertFalse(DemoStore.isActive)
        XCTAssertNil(DemoStore.loadState())
    }

    // MARK: Markt und Nachrichten

    func testDemoSourceFeedsMarketAndNewsOffline() async throws {
        DemoStore.start()
        let plant = try XCTUnwrap(DemoStore.plant())
        let source = DemoOnline(market: DemoMarket(world: plant.world))
        let market = MarketStore(source: source)
        XCTAssert(market.isSample)
        await market.refresh()
        XCTAssertEqual(market.prices(on: market.today).count, 96)
        XCTAssert(market.hasTomorrow)
        XCTAssertNotNil(market.outlook)
        XCTAssertNil(market.priceError)
        XCTAssertNil(market.outlookError)
        let news = NewsStore(source: source)
        XCTAssert(news.isSample)
        await news.refresh()
        XCTAssertEqual(news.items.count, 8)
        XCTAssert(news.items.allSatisfy { $0.source.hasPrefix("Beispiel") || $0.source.hasPrefix("Example") })
        XCTAssertNil(news.error)
    }

    /// Antwortet mit festen Preisen, auf Wunsch verzögert.
    private struct StubOnline: OnlineSource {
        let id: String
        let caches = false
        let isSample = false
        let price: Double
        let delay: Duration

        func get(_ path: String, query: [URLQueryItem]) async throws -> JSONValue {
            try await Task.sleep(for: delay)
            guard path == "api/prices" else { throw Online.Failure.status(404) }
            let start = MarketTime.startOfDay(Date())
            let rows: [JSONValue] = (0..<96).map { i in
                ["ts": .string(ISO.string(start.addingTimeInterval(Double(i) * 900))), "price": .double(price), "resolution": "15min"]
            }
            return ["data": .array(rows)]
        }
    }

    func testSwitchingTheSourceNeverMixesAnswers() async {
        let slow = StubOnline(id: "langsam", price: 100, delay: .milliseconds(400))
        let fast = StubOnline(id: "schnell", price: 500, delay: .milliseconds(10))
        let market = MarketStore(source: slow)
        let running = Task { await market.refresh(force: true) }
        try? await Task.sleep(for: .milliseconds(60))
        // Quelle wechseln, während die alte noch lädt (Demo gewählt bzw. verlassen).
        market.use(fast)
        await eventually("die neue Quelle lädt") { market.prices.count == 96 }
        XCTAssertEqual(market.prices.first?.ctKwh, 50)
        await running.value
        try? await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(market.prices.first?.ctKwh, 50, "die späte Antwort der alten Quelle überschreibt nichts")
        XCTAssertFalse(market.loading)
    }
}
