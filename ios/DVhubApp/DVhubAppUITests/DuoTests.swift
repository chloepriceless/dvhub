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

    private var app = XCUIApplication()
    private func shot(_ name: String) { Shots.take(name, app: app, defaultPose: "duo") }

    func testSystemPlacesBars() throws {
        guard ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] == "iPhone19,4" else {
            throw XCTSkip("Nur im iPhone-Duo-Simulator")
        }
        app.launchArguments += ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE", "-navPlacement", "auto"]
        if let qr = ProcessInfo.processInfo.environment["DVHUB_QR"], !qr.isEmpty { app.launchArguments += ["-DVHUB_PAIR", qr] }
        XCUIDevice.shared.orientation = .portrait
        app.launchArguments += Demo.off
        app.launch()
        let state = app.descendants(matching: .any)["connectionState"].firstMatch
        guard state.waitForExistence(timeout: 40) else { throw XCTSkip("Keine gekoppelte Anlage") }

        // Aufgeklappt (breit) führt die Seitenleiste links, zugeklappt die Reiter des Systems.
        let sidebar = Sidebar(app: app)
        let wide = sidebar.isShown
        func go(_ title: String, _ id: String) {
            if wide { sidebar.open(id) } else { app.buttons[title].firstMatch.tap() }
        }

        // Der Ersatz ist aus.
        XCTAssertFalse(app.buttons["rail.market"].exists, "Ersatz-Seitenleiste ist aktiv")
        let window = app.windows.firstMatch.frame
        if !wide {
            let market = app.buttons["Markt"].firstMatch
            XCTAssertTrue(market.waitForExistence(timeout: 10), "Reiter des Systems fehlen")
            // Zugeklappt hochkant (Außendisplay, schmal): Reiter am rechten Rand.
            if window.width < 540, window.height > window.width {
                XCTAssertGreaterThan(market.frame.midX, window.width * 0.75, "Reiter stehen nicht rechts: \(market.frame) in \(window)")
            }
        }
        shot("leitstand")
        go("Markt", "market")
        XCTAssertTrue(app.staticTexts["marketNowPrice"].waitForExistence(timeout: 15))
        shot("markt")
        for (tab, id, name) in [("Historie", "history", "historie"), ("Nachrichten", "news", "nachrichten")] {
            go(tab, id)
            sleep(3)
            shot(name)
        }
        // Artikel-Vorschau: ganz im Bild, in jeder Pose.
        let hero = app.buttons["newsHero"].firstMatch
        if hero.waitForExistence(timeout: 15) {
            hero.tap()
            let read = app.buttons["readArticle"].firstMatch
            XCTAssertTrue(read.waitForExistence(timeout: 10), "Artikel-Vorschau öffnet nicht")
            sleep(1)
            let win = app.windows.firstMatch.frame
            XCTAssertGreaterThanOrEqual(read.frame.minX, win.minX + 8, "Artikel ragt links aus dem Bild: \(read.frame) in \(win)")
            XCTAssertLessThanOrEqual(read.frame.maxX, win.maxX - 8, "Artikel ragt rechts aus dem Bild: \(read.frame) in \(win)")
            print("DVHUB_DUO_DIAG Artikel \(read.frame) in Fenster \(win)")
            shot("artikel")
            app.leaveArticle()
            sleep(1)
        } else {
            print("DVHUB_DUO_DIAG keine Nachrichten geladen – Artikel nicht geprüft")
        }
        // Mehr → Darstellung: die Diagnosezeile (Fläche, SDK, Falz) mit aufs Bild.
        if wide {
            sidebar.open("appearance")
        } else {
            app.buttons["Mehr"].firstMatch.tap()
            sleep(3)
            shot("mehr")
            let appearance = app.descendants(matching: .any)["more.appearance"].firstMatch
            XCTAssertTrue(appearance.waitForExistence(timeout: 5), "„Mehr“ zeigt die Bereiche nicht")
            appearance.tap()
        }
        let diag = app.staticTexts["layoutDiagnostics"].firstMatch
        XCTAssertTrue(diag.waitForExistence(timeout: 5), "Darstellung öffnet nicht")
        let text = diag.label
        XCTContext.runActivity(named: "Diagnose: \(text)") { _ in }
        print("DVHUB_DUO_DIAG \(text)")
        XCTAssertFalse(text.contains("SDK iphonesimulator27.0"), "mit zu altem SDK gebaut")
        shot("darstellung")
        if !wide {
            // Zurück zur Liste: „Mehr“ führt hinein und wieder heraus.
            app.goBack(to: "Mehr")
            // Der eben angetippte Eintrag steht wieder da (der letzte, „Über“, liegt zugeklappt unter dem Rand).
            XCTAssertTrue(app.descendants(matching: .any)["more.appearance"].firstMatch.waitForExistence(timeout: 5), "zurück zur Liste „Mehr“ geht nicht")
        }

        go("Leitstand", "dashboard")
        let before = app.windows.firstMatch.frame
        XCUIDevice.shared.orientation = before.width > before.height ? .portrait : .landscapeLeft
        sleep(3)
        XCTAssertFalse(app.buttons["rail.market"].exists, "Ersatz-Seitenleiste nach dem Drehen aktiv")
        XCTAssertTrue(state.label.contains("Verbunden"), "nach dem Drehen: \(state.label)")
        // Zugeklappt dreht der Simulator die App nicht mit (Fenster bleibt hochkant) — dann kein Bild.
        let turned = app.windows.firstMatch.frame
        if (turned.width > turned.height) != (before.width > before.height) {
            shot("gedreht-leitstand")
            go("Markt", "market")
            sleep(3)
            shot("gedreht-markt")
        } else {
            print("DVHUB_DUO_DIAG andere Ausrichtung nicht eingenommen: Fenster \(Int(turned.width))×\(Int(turned.height))")
        }
        XCUIDevice.shared.orientation = .portrait
    }
}
