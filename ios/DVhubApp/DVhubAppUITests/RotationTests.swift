// RotationTests.swift — Drehen und Größenwechsel ohne Verbindungsabbruch.
// Läuft gegen ios/interop/harness.mjs:
//   TEST_RUNNER_DVHUB_QR="$(cat qr.txt)" TEST_RUNNER_DVHUB_SHOTS=/pfad \
//   xcodebuild test -scheme DVhubApp -destination '…'
// Ohne gekoppelte Anlage und ohne DVHUB_QR wird der Test übersprungen.

import XCTest

final class RotationTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func shot(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["DVHUB_SHOTS"] else { return }
        let data = XCUIScreen.main.screenshot().pngRepresentation
        try? data.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }

    func testLiveSurvivesRotation() throws {
        let app = XCUIApplication()
        if let qr = ProcessInfo.processInfo.environment["DVHUB_QR"], !qr.isEmpty {
            app.launchArguments += ["-DVHUB_PAIR", qr]
        }
        XCUIDevice.shared.orientation = .portrait
        app.launch()

        let state = app.descendants(matching: .any)["connectionState"].firstMatch
        guard state.waitForExistence(timeout: 20) else { throw XCTSkip("Keine gekoppelte Anlage") }
        let online = NSPredicate(format: "label CONTAINS 'Verbunden'")
        expectation(for: online, evaluatedWith: state)
        waitForExpectations(timeout: 30)

        let pv = app.staticTexts["loadValue"]
        XCTAssertTrue(pv.waitForExistence(timeout: 15))
        shot("ui-portrait")
        let before = pv.label

        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        shot("ui-landscape")
        XCTAssertTrue(state.label.contains("Verbunden"), "nach dem Drehen: \(state.label)")

        // Live-Werte laufen weiter (Harness ändert PV laufend).
        let changed = NSPredicate(format: "label != %@", before)
        expectation(for: changed, evaluatedWith: pv)
        waitForExpectations(timeout: 20)
        XCTAssertTrue(state.label.contains("Verbunden"))

        XCUIDevice.shared.orientation = .portrait
        sleep(2)
        XCTAssertTrue(state.label.contains("Verbunden"), "zurückgedreht: \(state.label)")
        shot("ui-portrait-back")
    }
}
