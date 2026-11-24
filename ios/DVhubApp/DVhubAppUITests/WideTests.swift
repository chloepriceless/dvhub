// WideTests.swift — breite Fläche (iPhone Duo aufgeklappt, iPad): EINE
// Seitenleiste für alle Bereiche, und die Artikel-Vorschau bleibt im Bild.
// Läuft gegen ios/interop/harness.mjs; auf schmaler Fläche übersprungen.
//   TEST_RUNNER_DVHUB_QR="$(cat qr.txt)" TEST_RUNNER_DVHUB_SHOTS=/pfad TEST_RUNNER_DVHUB_POSE=auf \
//   xcodebuild test -scheme DVhubApp -destination 'platform=iOS Simulator,name=iPhone Duo' \
//     -only-testing:DVhubAppUITests/WideTests
// Den iPhone-Duo-Simulator vorher in Device Hub aufklappen (Inspektor → Device Configuration).

import XCTest

final class WideTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testOneSidebarForAllAreasAndArticleStaysOnScreen() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE", "-navPlacement", "auto"]
        if let qr = ProcessInfo.processInfo.environment["DVHUB_QR"], !qr.isEmpty { app.launchArguments += ["-DVHUB_PAIR", qr] }
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let state = app.descendants(matching: .any)["connectionState"].firstMatch
        guard state.waitForExistence(timeout: 40) else { throw XCTSkip("Keine gekoppelte Anlage") }
        let sidebar = Sidebar(app: app)
        guard sidebar.isShown else {
            throw XCTSkip("Schmale Fläche (\(Int(app.windows.firstMatch.frame.width)) pt): keine Seitenleiste – iPhone Duo aufklappen oder iPad nehmen")
        }

        let all = [("dashboard", nil), ("market", "Markt"), ("history", "Historie"), ("news", "Nachrichten"), ("plan", "Fahrplan"), ("ev", "E-Auto"),
                   ("integrations", "Integrationen"), ("system", "System"), ("systems", "Anlagen"), ("appearance", "Darstellung"), ("about", "Über")] as [(String, String?)]
        let startedWide = app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height
        try walk(app, sidebar, areas: all, suffix: startedWide ? "-quer" : "")
        // Andere Ausrichtung (wenn das Gerät sie einnimmt): noch einmal dasselbe.
        XCUIDevice.shared.orientation = startedWide ? .portrait : .landscapeLeft
        sleep(3)
        let turned = app.windows.firstMatch.frame
        if (turned.width > turned.height) != startedWide, sidebar.isShown {
            try walk(app, sidebar, areas: all, suffix: startedWide ? "" : "-quer")
        } else {
            print("DVHUB_DUO_DIAG zweite Ausrichtung nicht eingenommen: Fenster \(Int(turned.width))×\(Int(turned.height))")
        }
        XCUIDevice.shared.orientation = .portrait
    }

    /// Jeden Bereich über dieselbe Seitenleiste öffnen; sie bleibt dabei stehen, und es gibt keine zweite Navigation.
    private func walk(_ app: XCUIApplication, _ sidebar: Sidebar, areas: [(String, String?)], suffix: String) throws {
        let window = app.windows.firstMatch.frame
        print("DVHUB_DUO_DIAG Fenster \(Int(window.width))×\(Int(window.height))\(suffix)")
        XCTAssertFalse(app.tabBars.firstMatch.exists, "Reiter-Leiste neben der Seitenleiste")
        XCTAssertFalse(app.buttons["rail.market"].exists, "Ersatz-Seitenleiste neben der Seitenleiste")
        for (id, title) in areas {
            sidebar.open(id)
            if let title {
                XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10), "Bereich \(title) öffnet nicht")
            }
            // Die Seitenleiste steht in jedem Bereich, links — und sie ist die einzige Navigation.
            XCTAssertTrue(sidebar.list.exists, "Seitenleiste fehlt im Bereich \(id)")
            XCTAssertLessThan(sidebar.item(id).frame.midX, window.width * 0.45, "Seitenleiste steht nicht links")
            XCTAssertFalse(app.descendants(matching: .any)["more.plan"].exists, "zweite Liste „Mehr“ neben der Seitenleiste")
            sleep(2)
            Shots.take("\(id)\(suffix)", app: app, defaultPose: "breit")
            if id == "appearance" {
                let diag = app.staticTexts["layoutDiagnostics"].firstMatch
                if diag.waitForExistence(timeout: 3) { print("DVHUB_DUO_DIAG \(diag.label)") }
            }
        }

        // Artikel-Vorschau: ganz im Bild, nichts ragt über den Rand.
        sidebar.open("news")
        let hero = app.buttons["newsHero"].firstMatch
        guard hero.waitForExistence(timeout: 20) else { print("DVHUB_DUO_DIAG keine Nachrichten geladen – Artikel nicht geprüft"); return }
        hero.tap()
        let read = app.buttons["readArticle"].firstMatch
        XCTAssertTrue(read.waitForExistence(timeout: 10), "Artikel-Vorschau öffnet nicht")
        sleep(1)
        let win = app.windows.firstMatch.frame
        for el in [read, app.descendants(matching: .any)["articleContent"].firstMatch] where el.exists {
            XCTAssertGreaterThanOrEqual(el.frame.minX, win.minX + 8, "Artikel ragt links aus dem Bild: \(el.frame) in \(win)")
            XCTAssertLessThanOrEqual(el.frame.maxX, win.maxX - 8, "Artikel ragt rechts aus dem Bild: \(el.frame) in \(win)")
            XCTAssertLessThanOrEqual(el.frame.width, 640, "Lesespalte zu breit: \(el.frame.width)")
        }
        print("DVHUB_DUO_DIAG Artikel \(read.frame) in Fenster \(win)")
        // Breit ist die Vorschau eine Seite neben der Seitenleiste, kein schwebendes Blatt.
        XCTAssertFalse(app.buttons["Schließen"].exists, "Artikel öffnet breit als Blatt")
        XCTAssertTrue(sidebar.item("news").isHittable, "Seitenleiste neben dem Artikel nicht erreichbar")
        XCTAssertGreaterThan(read.frame.minX, sidebar.item("news").frame.maxX, "Artikel liegt über der Seitenleiste")
        Shots.take("artikel\(suffix)", app: app, defaultPose: "breit")
        app.leaveArticle()
        XCTAssertTrue(hero.waitForExistence(timeout: 5), "zurück zur Liste geht nicht")
        sidebar.open("dashboard")
    }
}
