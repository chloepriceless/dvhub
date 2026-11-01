// PairLinkTests.swift — dvhub://-Link von außen koppelt erst nach Bestätigung
// (Fable-Review M3). Braucht den Harness: TEST_RUNNER_DVHUB_QR_FILE=<Datei mit QR-Text>.

import XCTest

final class PairLinkTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testLinkShowsSummaryAndWaitsForTap() throws {
        guard let file = ProcessInfo.processInfo.environment["DVHUB_QR_FILE"],
              let qr = try? String(contentsOfFile: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !qr.isEmpty, let url = URL(string: qr) else { throw XCTSkip("DVHUB_QR_FILE fehlt") }
        let app = XCUIApplication()
        app.launch()
        app.open(url)

        let summary = app.staticTexts["Diese Anlage wird gekoppelt"].firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 15), "Zusammenfassung fehlt")
        XCTAssertTrue(app.staticTexts["Kennung"].exists)
        // Ohne Tippen passiert nichts: weder Warten auf Freigabe noch Erfolg.
        sleep(3)
        XCTAssertFalse(app.descendants(matching: .any)["waitingForApproval"].exists, "Kopplung ohne Bestätigung gestartet")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Gekoppelt mit'")).firstMatch.exists)

        app.buttons["pairButton"].firstMatch.tap()
        let done = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Gekoppelt mit'")).firstMatch
        let waiting = app.descendants(matching: .any)["waitingForApproval"]
        XCTAssertTrue(done.waitForExistence(timeout: 30) || waiting.exists, "Kopplung nach Tippen nicht gestartet")
    }
}
