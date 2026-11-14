// DuoTests.swift — iPhone Duo: Das System legt die Leisten selbst, der Ersatz
// (SideRail) bleibt aus. Läuft nur im iPhone-Duo-Simulator (iOS 27.1+, Build
// mit iOS-27.1-SDK oder neuer) gegen ios/interop/harness.mjs:
//   TEST_RUNNER_DVHUB_QR="$(cat qr.txt)" TEST_RUNNER_DVHUB_SHOTS=/pfad \
//   xcodebuild test -scheme DVhubApp -destination 'platform=iOS Simulator,name=iPhone Duo' \
//     -only-testing:DVhubAppUITests/DuoTests
// Auf- und Zuklappen geht nur in Device Hub (Inspektor → Device Configuration),
// nicht von der Kommandozeile: Der Test prüft und fotografiert die Pose, in
// der der Simulator gerade steht (TEST_RUNNER_DVHUB_POSE benennt die Bilder).

import XCTest

final class DuoTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["DVHUB_SHOTS"] else { return }
        let pose = ProcessInfo.processInfo.environment["DVHUB_POSE"] ?? "duo"
        try? XCUIScreen.main.screenshot().pngRepresentation
            .write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(pose)-\(name).png"))
    }

    func testSystemPlacesBars() throws {
        guard ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] == "iPhone19,4" else {
            throw XCTSkip("Nur im iPhone-Duo-Simulator")
        }
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE", "-navPlacement", "auto"]
        if let qr = ProcessInfo.processInfo.environment["DVHUB_QR"], !qr.isEmpty { app.launchArguments += ["-DVHUB_PAIR", qr] }
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let state = app.descendants(matching: .any)["connectionState"].firstMatch
        guard state.waitForExistence(timeout: 40) else { throw XCTSkip("Keine gekoppelte Anlage") }

        // Der Ersatz ist aus, die Reiter kommen vom System.
        XCTAssertFalse(app.buttons["rail.market"].exists, "Ersatz-Seitenleiste ist aktiv")
        let market = app.buttons["Markt"].firstMatch
        XCTAssertTrue(market.waitForExistence(timeout: 10), "Reiter des Systems fehlen")
        let window = app.windows.firstMatch.frame
        // Zugeklappt hochkant (Außendisplay, schmal): Reiter am rechten Rand.
        if window.width < 540, window.height > window.width {
            XCTAssertGreaterThan(market.frame.midX, window.width * 0.75, "Reiter stehen nicht rechts: \(market.frame) in \(window)")
        }
        shot("leitstand")
        market.tap()
        XCTAssertTrue(app.staticTexts["marketNowPrice"].waitForExistence(timeout: 15))
        shot("markt")
        for (tab, name) in [("Historie", "historie"), ("Nachrichten", "nachrichten"), ("Mehr", "mehr")] {
            app.buttons[tab].firstMatch.tap()
            sleep(3)
            shot(name)
        }
        // Mehr → Darstellung: die Diagnosezeile (Fläche, SDK, Falz) mit aufs Bild.
        let appearance = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Darstellung'")).firstMatch
        if appearance.waitForExistence(timeout: 5) {
            appearance.tap()
            let diag = app.staticTexts["layoutDiagnostics"].firstMatch
            if diag.waitForExistence(timeout: 5) {
                let text = diag.label
                XCTContext.runActivity(named: "Diagnose: \(text)") { _ in }
                print("DVHUB_DUO_DIAG \(text)")
                XCTAssertFalse(text.contains("SDK iphonesimulator27.0"), "mit zu altem SDK gebaut")
            }
            shot("darstellung")
        }

        app.buttons["Leitstand"].firstMatch.tap()
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(3)
        XCTAssertFalse(app.buttons["rail.market"].exists, "Ersatz-Seitenleiste im Querformat aktiv")
        XCTAssertTrue(state.label.contains("Verbunden"), "nach dem Drehen: \(state.label)")
        // Zugeklappt dreht der Simulator die App nicht mit (Fenster bleibt hochkant) — dann kein Bild.
        let turned = app.windows.firstMatch.frame
        if turned.width > turned.height {
            shot("quer-leitstand")
            app.buttons["Markt"].firstMatch.tap()
            sleep(3)
            shot("quer-markt")
        } else {
            print("DVHUB_DUO_DIAG Querformat nicht eingenommen: Fenster \(Int(turned.width))×\(Int(turned.height))")
        }
        XCUIDevice.shared.orientation = .portrait
    }
}
