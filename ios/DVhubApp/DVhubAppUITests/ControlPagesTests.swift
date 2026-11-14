// ControlPagesTests.swift — Bedienen und die neu geordneten Seiten: Leitstand
// ohne doppelte Werte, Einspeisung und Bezug in einem Diagramm, Integrationen
// ohne Adressen, E-Auto und Zeitplan mit Schreiben.
//
// Läuft gegen ios/interop/harness.mjs (HARNESS_PERMS=read,control), in der
// Pose, in der der Simulator steht. Die Schreib-Tests brauchen eingeschriebene
// Biometrie und die Freigabe von außen in Schleife:
//   xcrun simctl spawn <Gerät> notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
//   xcrun simctl spawn <Gerät> notifyutil -p com.apple.BiometricKit.enrollmentChanged
//   xcrun simctl spawn <Gerät> notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match   (iPhone Duo)
//   xcrun simctl spawn <Gerät> notifyutil -p com.apple.BiometricKit_Sim.pearl.match          (Face ID)

import XCTest

final class ControlPagesTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ area: String) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE", "-navPlacement", "auto", "-DVHUB_TAB", area]
        if let qr = ProcessInfo.processInfo.environment["DVHUB_QR"], !qr.isEmpty { app.launchArguments += ["-DVHUB_PAIR", qr] }
        app.launch()
        return app
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

    /// Inhalt ein Stück nach oben schieben — im Fenster der App und rechts der
    /// Mitte (breit steht links die Seitenleiste). `swipeUp()` der App greift
    /// auf dem aufgeklappten iPhone Duo nicht zuverlässig.
    private func scrollDown(_ app: XCUIApplication) {
        let win = app.windows.firstMatch
        let from = win.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.72))
        let to = win.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.3))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.1)
    }

    /// Bis zum Element rollen (die Seiten sind länger als das Außendisplay).
    private func reveal(_ el: XCUIElement, in app: XCUIApplication, tries: Int = 8) {
        var n = 0
        while !(el.exists && el.isHittable), n < tries { scrollDown(app); n += 1 }
    }

    private func waitOnline(_ app: XCUIApplication) throws {
        // Auf Seiten unter „Mehr“ steht die Verbindungsanzeige nicht; dort zeigt der Inhalt, dass die Anlage antwortet.
        let state = any(app, "connectionState")
        if state.waitForExistence(timeout: 5) {
            expectation(for: NSPredicate(format: "label CONTAINS 'Verbunden'"), evaluatedWith: state)
            waitForExpectations(timeout: 40)
        }
    }

    // MARK: Leitstand

    func testDashboardShowsLiveValuesOnceAndFlowLikeTheWebControlRoom() throws {
        let app = try launch("dashboard")
        guard any(app, "connectionState").waitForExistence(timeout: 40) else { throw XCTSkip("Keine gekoppelte Anlage") }
        try waitOnline(app)
        let home = app.buttons["flowNode.home"].firstMatch, grid = app.buttons["flowNode.grid"].firstMatch
        let pv = app.buttons["flowNode.pv"].firstMatch, battery = app.buttons["flowNode.battery"].firstMatch
        XCTAssertTrue(home.waitForExistence(timeout: 15))
        // Anordnung wie im Web-Leitstand: Haus links, Netz rechts, PV oben, Akku unten.
        XCTAssertLessThan(home.frame.midX, grid.frame.midX, "Haus muss links vom Netz stehen")
        XCTAssertLessThan(pv.frame.midY, battery.frame.midY)
        XCTAssertTrue(home.label.contains("Verbrauch"), home.label)
        // Der Harness speist ein: Der Netz-Knoten sagt Einspeisung und trägt ein Minus (Web: − = Einspeisung).
        XCTAssertTrue(grid.label.contains("Einspeisung") || grid.label.contains("Bezug") || grid.label.contains("ausgeglichen"), grid.label)
        if grid.label.contains("Einspeisung") { XCTAssertTrue(grid.label.contains("−"), "Einspeisung ohne Minus: \(grid.label)") }
        if grid.label.contains("Bezug") { XCTAssertTrue(grid.label.contains("+"), "Bezug ohne Plus: \(grid.label)") }

        // Karten: Tagesenergie statt der Momentanwerte aus dem Energiefluss.
        let pvCard = app.buttons["card.PV"].firstMatch
        XCTAssertTrue(pvCard.waitForExistence(timeout: 10))
        let pvToday = app.staticTexts["pvToday"].firstMatch
        expectation(for: NSPredicate(format: "label CONTAINS 'kWh'"), evaluatedWith: pvToday)
        waitForExpectations(timeout: 30)
        XCTAssertFalse(app.staticTexts["pvValue"].exists, "Momentanwert steht noch einmal in einer Karte")
        XCTAssertFalse(app.staticTexts["loadValue"].exists, "Momentanwert steht noch einmal in einer Karte")
        Shots.take("leitstand", app: app, defaultPose: "ui")
        scrollDown(app)
        Shots.take("leitstand-karten", app: app, defaultPose: "ui")
    }

    // MARK: Markt

    func testMarketShowsFeedInAndImportTariffInOneChart() throws {
        let app = try launch("market")
        let chart = any(app, "priceChart")
        guard chart.waitForExistence(timeout: 40) else { throw XCTSkip("Keine Börsenpreise (dvhub.online nicht erreichbar)") }
        // Der Bezugstarif kommt von der Anlage: Legende und Auswertung nennen ihn.
        let stats = any(app, "tariffStats")
        guard stats.waitForExistence(timeout: 40) else { throw XCTSkip("Kein Bezugstarif (keine gekoppelte Anlage)") }
        XCTAssertTrue(app.staticTexts["Bezug (dein Tarif, brutto)"].exists)
        XCTAssertTrue(app.staticTexts["Spanne im Mittel"].exists)
        // Was gerade gilt, steht klein — nicht mehr als große Kachel über dem Diagramm.
        let now = app.staticTexts["marketNowPrice"].firstMatch
        XCTAssertTrue(now.exists)
        XCTAssertLessThan(now.frame.height, 26, "aktueller Preis zu groß: \(now.frame)")
        XCTAssertFalse(app.staticTexts["Börse jetzt"].exists || app.staticTexts["BÖRSE JETZT"].exists)
        reveal(chart, in: app, tries: 3)
        Shots.take("markt-tarif", app: app, defaultPose: "ui")
    }

    // MARK: Integrationen

    func testIntegrationsShowSetupWithoutAddresses() throws {
        let app = try launch("integrations")
        guard app.navigationBars["Integrationen"].waitForExistence(timeout: 20), app.staticTexts["Wechselrichter"].firstMatch.waitForExistence(timeout: 60) else {
            throw XCTSkip("Keine gekoppelte Anlage")
        }
        // Die Karte „Eingerichtet“ steht unter den Zustandskarten und entsteht erst beim Rollen.
        let mqtt = any(app, "setup.mqtt")
        var swipes = 0
        while !mqtt.exists, swipes < 14 { scrollDown(app); swipes += 1 }
        if !mqtt.exists { Shots.take("integrationen-fehlt", app: app, defaultPose: "ui"); print("DVHUB_DIAG \(app.staticTexts.allElementsBoundByIndex.map(\.label).suffix(40))") }
        XCTAssertTrue(mqtt.exists, "Karte „Eingerichtet“ fehlt")
        // Schmal steht die Karte einspaltig und baut ihre Zeilen beim Rollen auf.
        let victron = any(app, "setup.victron")
        swipes = 0
        while !victron.exists, swipes < 5 { scrollDown(app); swipes += 1 }
        XCTAssertTrue(victron.exists, "Zeile Wechselrichter fehlt")
        // Nichts auf der Seite sieht nach Adresse oder Zugang aus (der Harness legt Köder in die große Übersicht).
        let address = try NSRegularExpression(pattern: #"\b\d{1,3}(\.\d{1,3}){3}\b|://|koeder|KOEDER"#)
        for text in app.staticTexts.allElementsBoundByIndex.map(\.label) {
            XCTAssertNil(address.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), "Adresse oder Köder auf der Seite: \(text)")
        }
        Shots.take("integrationen-eingerichtet", app: app, defaultPose: "ui")
    }

    // MARK: E-Auto

    func testEVPlanningSavesAndReadsBack() throws {
        let app = try launch("ev")
        let toggle = app.switches["ev.optimize"].firstMatch
        guard toggle.waitForExistence(timeout: 60) else { throw XCTSkip("Keine gekoppelte Anlage") }
        XCTAssertTrue(app.staticTexts["ev.soc"].exists)
        Shots.take("eauto", app: app, defaultPose: "ui")
        let save = app.buttons["ev.save"].firstMatch
        reveal(save, in: app)
        XCTAssertFalse(save.isEnabled, "ohne Änderung gibt es nichts zu speichern")
        let before = toggle.value as? String
        reveal(toggle, in: app, tries: 2)
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
        XCTAssertNotEqual(toggle.value as? String, before, "Schalter reagiert nicht")
        reveal(save, in: app)
        guard save.isEnabled else { throw XCTSkip("Dieses Gerät darf nicht steuern (HARNESS_PERMS=read,control)") }
        save.tap()
        let status = any(app, "ev.status")
        XCTAssertTrue(status.waitForExistence(timeout: 40), "keine Rückmeldung – Biometrie-Freigabe läuft?")
        XCTAssertTrue(status.label.contains("Gespeichert"), status.label)
        // Von der Box zurückgelesen: Der Schalter steht wie gespeichert, und es gibt nichts mehr zu speichern.
        XCTAssertNotEqual(toggle.value as? String, before)
        XCTAssertFalse(save.isEnabled)
        Shots.take("eauto-gespeichert", app: app, defaultPose: "ui")
        // Zurückstellen (kurz warten: Solange das Blatt der Biometrie noch abbaut, liefert die App keinen Schnappschuss).
        sleep(2)
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
        reveal(save, in: app)
        save.tap()
        expectation(for: NSPredicate(format: "isEnabled == false"), evaluatedWith: save)
        waitForExpectations(timeout: 40)
        XCTAssertEqual(toggle.value as? String, before)
        let week = app.buttons["ev.week.0"].firstMatch
        reveal(week, in: app)
        if week.exists { Shots.take("eauto-wochenplan", app: app, defaultPose: "ui") }
    }

    // MARK: Zeitplan

    func testScheduleRuleCanBeAddedToggledAndDeleted() throws {
        let app = try launch("plan")
        let add = app.buttons["schedule.add"].firstMatch
        guard app.staticTexts["Regeln von Hand"].firstMatch.waitForExistence(timeout: 60) else { throw XCTSkip("Keine gekoppelte Anlage") }
        reveal(add, in: app, tries: 12)
        guard add.exists else { throw XCTSkip("Dieses Gerät darf nicht steuern (HARNESS_PERMS=read,control)") }
        Shots.take("zeitplan", app: app, defaultPose: "ui")
        add.tap()
        let amount = app.textFields["schedule.edit.amount"].firstMatch
        XCTAssertTrue(amount.waitForExistence(timeout: 5))
        let save = app.buttons["schedule.edit.save"].firstMatch
        reveal(amount, in: app, tries: 3)
        amount.tap()
        amount.typeText("1234")
        Shots.take("zeitplan-neue-regel", app: app, defaultPose: "ui")
        // Tastatur schließen, falls sie den Knopf verdeckt.
        if app.keyboards.firstMatch.exists { app.staticTexts["Neue Regel"].firstMatch.tap() }
        reveal(save, in: app, tries: 4)
        XCTAssertTrue(save.isEnabled)
        save.tap()
        let status = any(app, "schedule.status")
        XCTAssertTrue(status.waitForExistence(timeout: 40), "keine Rückmeldung – Biometrie-Freigabe läuft?")
        XCTAssertTrue(status.label.contains("Gespeichert"), status.label)
        // Die neue Regel steht in der Liste: 12:00–14:00, Einspeisen 1,2 kW.
        let rule = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'schedule.rule.app-'")).firstMatch
        XCTAssertTrue(rule.waitForExistence(timeout: 20), "neue Regel fehlt in der Liste")
        XCTAssertTrue(rule.label.contains("12:00–14:00"), rule.label)
        XCTAssertTrue(rule.label.contains("−1,2 kW"), rule.label)
        Shots.take("zeitplan-regel-angelegt", app: app, defaultPose: "ui")

        // Öffnen und löschen (mit Rückfrage).
        reveal(rule, in: app, tries: 3)
        rule.tap()
        let delete = app.buttons["schedule.edit.delete"].firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        reveal(delete, in: app, tries: 4)
        delete.tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Regel löschen'")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: rule)
        waitForExpectations(timeout: 40)
    }
}
