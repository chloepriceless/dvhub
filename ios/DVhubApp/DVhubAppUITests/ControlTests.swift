// ControlTests.swift — Not-Halt über die Oberfläche (mit Biometrie-Bestätigung).
// Braucht eine gekoppelte Anlage mit Recht „Steuern“ (Harness: HARNESS_PERMS=read,control)
// und im Simulator eingeschriebenes Face ID; die Freigabe kommt von außen:
//   xcrun simctl spawn <Gerät> notifyutil -p com.apple.BiometricKit_Sim.pearl.match

import XCTest

final class ControlTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testEmergencyStopAndResume() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-DVHUB_TAB", "control"]
        app.launch()
        let stop = app.buttons["Not-Halt auslösen"].firstMatch
        guard stop.waitForExistence(timeout: 30) else { throw XCTSkip("Keine gekoppelte Anlage mit Recht „Steuern“") }
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: stop)
        waitForExpectations(timeout: 30)
        stop.tap()
        // Bestätigungsdialog: zweiter Knopf mit derselben Beschriftung.
        let confirm = app.sheets.buttons["Not-Halt auslösen"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        sleep(4)
        if let dir = ProcessInfo.processInfo.environment["DVHUB_SHOTS"] {
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ui-control-after-confirm.png"))
        }
        XCTAssertTrue(app.staticTexts["Erledigt."].waitForExistence(timeout: 30), "Not-Halt nicht bestätigt")
        XCTAssertTrue(app.staticTexts["Not-Halt ist aktiv"].waitForExistence(timeout: 15))

        let resume = app.buttons["Not-Halt aufheben"].firstMatch
        XCTAssertTrue(resume.waitForExistence(timeout: 10))
        resume.tap()
        let confirmResume = app.sheets.buttons["Not-Halt aufheben"].firstMatch
        XCTAssertTrue(confirmResume.waitForExistence(timeout: 5))
        confirmResume.tap()
        XCTAssertTrue(app.staticTexts["Regelung läuft"].waitForExistence(timeout: 30))
    }
}
