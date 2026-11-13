// NavigationTests.swift — Reiter, Detailansichten und Seitenleiste.
// Läuft gegen ios/interop/harness.mjs (TEST_RUNNER_DVHUB_QR wie RotationTests).

import XCTest

final class NavigationTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ args: [String] = []) throws -> XCUIApplication {
        let app = XCUIApplication()
        if let qr = ProcessInfo.processInfo.environment["DVHUB_QR"], !qr.isEmpty { app.launchArguments += ["-DVHUB_PAIR", qr] }
        app.launchArguments += args
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let state = app.descendants(matching: .any)["connectionState"].firstMatch
        guard state.waitForExistence(timeout: 20) else { throw XCTSkip("Keine gekoppelte Anlage") }
        expectation(for: NSPredicate(format: "label CONTAINS 'Verbunden'"), evaluatedWith: state)
        waitForExpectations(timeout: 30)
        return app
    }

    /// Karte antippen → Detailwerte; zurück; Markt und Historie über die Reiter.
    func testCardsOpenDetailsAndTabsWork() throws {
        let app = try launch(["-navPlacement", "bottom"])
        let card = app.buttons["card.Akku"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        card.tap()
        XCTAssertTrue(app.navigationBars["Akku"].waitForExistence(timeout: 5), "Detailansicht Akku fehlt")
        XCTAssertTrue(app.staticTexts["Min-SoC"].waitForExistence(timeout: 10), "Detailwerte fehlen")
        app.navigationBars["Akku"].buttons.firstMatch.tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5))

        // Knoten im Energiefluss öffnen dieselben Details.
        app.buttons["flowNode.pv"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["PV"].waitForExistence(timeout: 5))
        app.navigationBars["PV"].buttons.firstMatch.tap()

        app.tabBars.buttons["Markt"].tap()
        XCTAssertTrue(app.navigationBars["Markt"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Historie"].tap()
        XCTAssertTrue(app.staticTexts["historyNet"].waitForExistence(timeout: 20), "Historie lädt nicht")
        // Woche: die Gegenstelle liefert Tageszeilen.
        app.segmentedControls.buttons["Woche"].tap()
        XCTAssertTrue(app.staticTexts["Erlöse und Kosten"].waitForExistence(timeout: 20) || app.staticTexts["ERLÖSE UND KOSTEN"].waitForExistence(timeout: 2))
    }

    /// Erzwungene Seitenleiste: Reiter rechts, keine Leiste unten; die Verbindung bleibt beim Wechsel.
    func testSideRailReplacesTabBar() throws {
        let app = try launch(["-navPlacement", "side"])
        let market = app.buttons["rail.market"].firstMatch
        XCTAssertTrue(market.waitForExistence(timeout: 10), "Seitenleiste fehlt")
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "Leiste unten sollte ausgeblendet sein")
        // Die Leiste steht am rechten Rand.
        XCTAssertGreaterThan(market.frame.midX, app.windows.firstMatch.frame.width * 0.8)
        market.tap()
        XCTAssertTrue(app.staticTexts["marketNowPrice"].waitForExistence(timeout: 10))
        app.buttons["rail.dashboard"].firstMatch.tap()
        let state = app.descendants(matching: .any)["connectionState"].firstMatch
        XCTAssertTrue(state.waitForExistence(timeout: 5))
        XCTAssertTrue(state.label.contains("Verbunden"))
        if let dir = ProcessInfo.processInfo.environment["DVHUB_SHOTS"] {
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ui-rail.png"))
        }
    }
}
