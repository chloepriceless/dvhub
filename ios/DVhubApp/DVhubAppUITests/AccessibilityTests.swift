// AccessibilityTests.swift — Bedienungshilfen-Schriftgröße: Karten stehen
// untereinander statt nebeneinander und bleiben bedienbar.
// Läuft gegen ios/interop/harness.mjs (TEST_RUNNER_DVHUB_QR wie RotationTests).

import XCTest

final class AccessibilityTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["DVHUB_SHOTS"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }

    func testAccessibilitySizeStacksCards() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE", "-navPlacement", "auto",
                                "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"]
        if let qr = ProcessInfo.processInfo.environment["DVHUB_QR"], !qr.isEmpty { app.launchArguments += ["-DVHUB_PAIR", qr] }
        XCUIDevice.shared.orientation = .portrait
        app.launchArguments += Demo.off
        app.launch()
        let state = app.descendants(matching: .any)["connectionState"].firstMatch
        guard state.waitForExistence(timeout: 30) else { throw XCTSkip("Keine gekoppelte Anlage") }
        shot("ax-leitstand")

        let pv = app.buttons["card.PV"].firstMatch
        let battery = app.buttons["card.Akku"].firstMatch
        XCTAssertTrue(pv.waitForExistence(timeout: 10))
        XCTAssertTrue(battery.exists)
        // Eine Spalte: Die Akku-Karte beginnt unter der PV-Karte, beide gleich breit.
        XCTAssertGreaterThanOrEqual(battery.frame.minY, pv.frame.maxY, "Karten stehen nebeneinander: \(pv.frame) \(battery.frame)")
        XCTAssertEqual(battery.frame.width, pv.frame.width, accuracy: 1)
        XCTAssertGreaterThan(pv.frame.width, app.windows.firstMatch.frame.width * 0.8)

        // Antippen funktioniert auch in dieser Größe.
        app.swipeUp()
        shot("ax-karten")
        battery.tap()
        XCTAssertTrue(app.navigationBars["Akku"].waitForExistence(timeout: 5), "Detailansicht Akku fehlt")
        shot("ax-akku")
        app.navigationBars["Akku"].buttons.firstMatch.tap()

        app.tabBars.buttons["Markt"].tap()
        XCTAssertTrue(app.staticTexts["marketNowPrice"].waitForExistence(timeout: 15))
        shot("ax-markt")
    }
}
