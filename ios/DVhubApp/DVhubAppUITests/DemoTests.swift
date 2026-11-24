// DemoTests.swift — der Demo-Modus über die Oberfläche: „Demo ansehen“ auf dem
// Startbildschirm, danach zeigt jeder Bereich Inhalt, Bedienen wirkt sichtbar
// (Not-Halt, Sofort laden, Zeitplan-Regel), „Demo beenden“ führt zurück.
//
// Braucht nichts von außen: keine gekoppelte Anlage, kein Harness, kein Netz,
// keine eingeschriebene Biometrie — in der Demo wird nichts geschaltet.
// Ist auf dem Simulator schon eine Anlage gekoppelt, beginnt der Test unter
// Mehr → Anlagen; die gekoppelte Anlage bleibt unberührt.

import XCTest

final class DemoTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    override func tearDown() {
        // Nie eine laufende Demo hinterlassen: Die übrigen Tests erwarten den Simulator, wie er war.
        launch(["-DVHUB_DEMO", "off"])
        app.terminate()
    }

    @discardableResult
    private func launch(_ args: [String] = []) -> XCUIApplication {
        app = XCUIApplication()
        // Die Tests suchen deutsche Beschriftungen — unabhängig von der Sprache des Simulators.
        app.launchArguments = ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE", "-navPlacement", "auto"] + args
        app.launch()
        return app
    }

    private func any(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

    /// Inhalt ein Stück nach oben schieben (rechts der Mitte: breit steht links die Seitenleiste).
    private func scrollDown() {
        let win = app.windows.firstMatch
        let from = win.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.72))
        let to = win.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.3))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.1)
    }

    private func reveal(_ el: XCUIElement, tries: Int = 10) {
        var n = 0
        while !(el.exists && el.isHittable), n < tries { scrollDown(); n += 1 }
    }

    /// Bereich öffnen: Reiter antippen, auf breiter Fläche die Seitenleiste; sonst neu starten (die Demo bleibt über Neustarts).
    private func show(_ area: String, tab title: String) {
        let tab = app.tabBars.buttons[title].firstMatch
        if tab.exists && tab.isHittable { tab.tap(); return }
        let side = Sidebar(app: app)
        if side.item(area).exists { side.open(area); return }
        launch(["-DVHUB_TAB", area])
    }

    /// Bereich unter „Mehr“ öffnen.
    private func showMore(_ area: String) {
        let side = Sidebar(app: app)
        if side.item(area).exists { side.open(area); return }
        let row = any("more.\(area)")
        if !row.exists { show("more", tab: "Mehr") }
        if row.waitForExistence(timeout: 5) {
            reveal(row, tries: 4)
            if row.isHittable { row.tap(); return }
        }
        launch(["-DVHUB_TAB", area])
    }

    /// Knopf einer Rückfrage antippen (das System zeigt sie je nach Pose als Blatt oder als Aufklapper).
    private func confirm(_ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let inSheet = app.sheets.buttons[label].firstMatch
        if inSheet.waitForExistence(timeout: 3) { inSheet.tap(); return }
        let all = app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
        guard let button = all.last(where: { $0.isHittable }) else {
            XCTFail("Rückfrage „\(label)“ fehlt", file: file, line: line)
            return
        }
        button.tap()
    }

    private func expectDemoStrip(_ where_: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(any("demoStrip").waitForExistence(timeout: 10), "Kennzeichnung „Demo“ fehlt: \(where_)", file: file, line: line)
    }

    func testDemoShowsEveryAreaReactsToControlsAndEnds() throws {
        // Sauberer Anfang: eine frühere Demo beenden.
        launch(["-DVHUB_DEMO", "off"])

        // Einstieg: Startbildschirm ohne Anlage — oder, mit gekoppelter Anlage, Mehr → Anlagen.
        var start = app.buttons["demoStart"].firstMatch
        let onboarding = start.waitForExistence(timeout: 15)
        if onboarding {
            XCTAssertTrue(app.buttons["pairButton"].exists, "„Koppeln“ steht weiter daneben")
        } else {
            launch(["-DVHUB_TAB", "systems"])
            start = app.buttons["demoStart"].firstMatch
            XCTAssertTrue(start.waitForExistence(timeout: 15), "„Demo ansehen“ fehlt unter Anlagen")
        }
        reveal(start, tries: 4)
        Shots.take("demo-einstieg", app: app, defaultPose: "ui")
        start.tap()
        if !onboarding { show("dashboard", tab: "Leitstand") }

        // Leitstand: Live-Werte der Beispielanlage, als Demo gekennzeichnet.
        let state = any("connectionState")
        XCTAssertTrue(state.waitForExistence(timeout: 15), "Leitstand der Demo erscheint nicht")
        expectation(for: NSPredicate(format: "label CONTAINS 'Demo'"), evaluatedWith: state)
        waitForExpectations(timeout: 15)
        expectDemoStrip("Leitstand")
        XCTAssertTrue(app.navigationBars["Demo-Anlage"].firstMatch.exists || app.staticTexts["Demo-Anlage"].firstMatch.exists)
        let home = app.buttons["flowNode.home"].firstMatch
        XCTAssertTrue(home.waitForExistence(timeout: 10))
        XCTAssertTrue(home.label.contains("Verbrauch"), home.label)
        let load = app.staticTexts["loadToday"].firstMatch
        expectation(for: NSPredicate(format: "label CONTAINS 'kWh'"), evaluatedWith: load)
        waitForExpectations(timeout: 20)
        Shots.take("demo-leitstand", app: app, defaultPose: "ui")

        // Markt: Beispielpreise mit Bezugstarif der Anlage, Tageskarten bis in die Prognose.
        show("market", tab: "Markt")
        XCTAssertTrue(app.staticTexts["marketNowPrice"].firstMatch.waitForExistence(timeout: 15), "Markt ohne Preise")
        expectDemoStrip("Markt")
        XCTAssertGreaterThanOrEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'marketDay.'")).count, 3)
        let readout = any("tariffReadout")
        XCTAssertTrue(readout.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "label CONTAINS 'Bezug'"), evaluatedWith: readout)
        waitForExpectations(timeout: 15)
        Shots.take("demo-markt", app: app, defaultPose: "ui")

        // Historie: Tag und Woche.
        show("history", tab: "Historie")
        XCTAssertTrue(app.staticTexts["historyNet"].firstMatch.waitForExistence(timeout: 20), "Historie lädt nicht")
        expectDemoStrip("Historie")
        app.segmentedControls.buttons["Woche"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] 'Erlöse und Kosten'")).firstMatch.waitForExistence(timeout: 20), "Wochenansicht ohne Inhalt")
        app.segmentedControls.buttons["Jahr"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] 'Je Monat'")).firstMatch.waitForExistence(timeout: 20), "Jahresansicht ohne Inhalt")
        Shots.take("demo-historie", app: app, defaultPose: "ui")
        app.segmentedControls.buttons["Tag"].firstMatch.tap()

        // Nachrichten: Beispielmeldungen, als solche gekennzeichnet.
        show("news", tab: "Nachrichten")
        let hero = any("newsHero")
        XCTAssertTrue(hero.waitForExistence(timeout: 15), "keine Meldungen")
        XCTAssertTrue(hero.label.localizedCaseInsensitiveContains("Beispiel"), hero.label)
        expectDemoStrip("Nachrichten")
        Shots.take("demo-nachrichten", app: app, defaultPose: "ui")

        // Fahrplan: EOS-Plan und Zeitplan — eine Regel anlegen, in der Liste sehen.
        showMore("plan")
        XCTAssertTrue(app.staticTexts["Regeln von Hand"].firstMatch.waitForExistence(timeout: 30), "Fahrplan ohne Zeitplan")
        let add = app.buttons["schedule.add"].firstMatch
        reveal(add, tries: 12)
        XCTAssertTrue(add.exists && add.isEnabled, "In der Demo lässt sich der Zeitplan bedienen")
        add.tap()
        let amount = app.textFields["schedule.edit.amount"].firstMatch
        XCTAssertTrue(amount.waitForExistence(timeout: 5))
        reveal(amount, tries: 3)
        amount.tap()
        amount.typeText("2500")
        if app.keyboards.firstMatch.exists { app.staticTexts["Neue Regel"].firstMatch.tap() }
        let save = app.buttons["schedule.edit.save"].firstMatch
        reveal(save, tries: 4)
        save.tap()
        let rule = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'schedule.rule.app-'")).firstMatch
        XCTAssertTrue(rule.waitForExistence(timeout: 20), "neue Regel fehlt in der Liste")
        XCTAssertTrue(rule.label.contains("−2,5 kW"), rule.label)
        Shots.take("demo-fahrplan", app: app, defaultPose: "ui")

        // E-Auto: Sofort laden starten — ohne Bestätigung am Gerät — und beenden.
        showMore("ev")
        XCTAssertTrue(app.staticTexts["ev.soc"].firstMatch.waitForExistence(timeout: 30), "E-Auto ohne Werte")
        let charge = app.buttons["ev.chargeNow"].firstMatch
        reveal(charge)
        XCTAssertTrue(charge.exists && charge.isEnabled)
        charge.tap()
        confirm("Sofort laden")
        let active = any("ev.overrideActive")
        XCTAssertTrue(active.waitForExistence(timeout: 20), "Sofort laden startet nicht")
        XCTAssertTrue(active.label.contains("Sofort laden läuft mit"), active.label)
        Shots.take("demo-eauto", app: app, defaultPose: "ui")
        let end = app.buttons["ev.overrideEnd"].firstMatch
        reveal(end, tries: 3)
        end.tap()
        confirm("Beenden und EOS wieder planen lassen")
        XCTAssertTrue(charge.waitForExistence(timeout: 20), "Sofort laden endet nicht")

        // Integrationen: Karten und „Eingerichtet“.
        showMore("integrations")
        let setup = any("setup.victron")
        XCTAssertTrue(app.staticTexts["EOS-Optimierer"].firstMatch.waitForExistence(timeout: 30), "Integrationen ohne Karten")
        reveal(setup, tries: 14)
        XCTAssertTrue(setup.exists, "„Eingerichtet“ fehlt")

        // Steuern: Not-Halt auslösen und aufheben.
        showMore("control")
        let stop = app.buttons["Not-Halt auslösen"].firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 30), "Steuern fehlt")
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: stop)
        waitForExpectations(timeout: 20)
        stop.tap()
        confirm("Not-Halt auslösen")
        XCTAssertTrue(app.staticTexts["Not-Halt ist aktiv"].firstMatch.waitForExistence(timeout: 20), "Not-Halt wirkt in der Demo nicht")
        Shots.take("demo-nothalt", app: app, defaultPose: "ui")
        let resume = app.buttons["Not-Halt aufheben"].firstMatch
        XCTAssertTrue(resume.waitForExistence(timeout: 10))
        resume.tap()
        confirm("Not-Halt aufheben")
        XCTAssertTrue(app.staticTexts["Regelung läuft"].firstMatch.waitForExistence(timeout: 20))

        // Die Demo übersteht einen Neustart: Die angelegte Regel ist noch da.
        launch(["-DVHUB_TAB", "plan"])
        XCTAssertTrue(app.staticTexts["Regeln von Hand"].firstMatch.waitForExistence(timeout: 30))
        reveal(rule, tries: 12)
        XCTAssertTrue(rule.exists, "die Regel der Demo ist nach dem Neustart fort")

        // Demo beenden — unter „Anlagen“ (in jeder Pose erreichbar; schmal steht dasselbe unter „Mehr“).
        launch(["-DVHUB_TAB", "systems"])
        XCTAssertTrue(any("systems.demo").waitForExistence(timeout: 15), "die Demo fehlt in der Anlagenliste")
        let endDemo = app.buttons["demoEnd"].firstMatch
        XCTAssertTrue(endDemo.waitForExistence(timeout: 5))
        endDemo.tap()
        confirm("Demo beenden")
        XCTAssertTrue(app.buttons["demoStart"].firstMatch.waitForExistence(timeout: 15), "nach dem Beenden steht wieder „Demo ansehen“ da")
        XCTAssertFalse(any("systems.demo").exists)
        XCTAssertFalse(any("demoStrip").exists)
    }

    /// „Mehr“ bietet das Beenden jederzeit an; danach steht — ohne gekoppelte Anlage — wieder der Startbildschirm da.
    func testDemoCanBeEndedFromMore() throws {
        launch(["-DVHUB_DEMO", "on", "-DVHUB_TAB", "more"])
        let end = app.buttons["demoEnd"].firstMatch
        guard end.waitForExistence(timeout: 15) else {
            // Breite Fläche: „Mehr“ ist dort die Seitenleiste.
            throw XCTSkip("„Mehr“ ist in dieser Pose keine eigene Seite")
        }
        XCTAssertTrue(app.buttons["demoPair"].firstMatch.exists, "„Eigene Anlage koppeln“ steht daneben")
        end.tap()
        confirm("Demo beenden")
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: end)
        waitForExpectations(timeout: 15)
        XCTAssertFalse(any("demoStrip").exists)
    }
}
