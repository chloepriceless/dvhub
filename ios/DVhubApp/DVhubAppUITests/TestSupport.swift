// TestSupport.swift — Hilfen der Oberflächentests: Bildschirmfotos und die Seitenleiste.

import XCTest

enum Shots {
    /// Bildschirmfoto nach `DVHUB_SHOTS` (ohne die Variable: nichts). Der Name
    /// beginnt mit `DVHUB_POSE` (z. B. „zu“, „auf“).
    static func take(_ name: String, app: XCUIApplication, defaultPose: String) {
        guard let dir = ProcessInfo.processInfo.environment["DVHUB_SHOTS"] else { return }
        let pose = ProcessInfo.processInfo.environment["DVHUB_POSE"] ?? defaultPose
        // iPhone Duo: zwei Bildschirme, einer davon dunkel (aufgeklappt das Außendisplay).
        // Ein einfarbiges Bild ist winzig — das inhaltsreichste ist das mit der App.
        guard let png = XCUIScreen.screens.map({ $0.screenshot().pngRepresentation }).max(by: { $0.count < $1.count }) else { return }
        print("DVHUB_DUO_DIAG Bild \(name): \(XCUIScreen.screens.count) Bildschirme, \(png.count) Bytes")
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(pose)-\(name).png"))
    }
}

/// Seitenleiste der breiten Fläche (iPhone Duo aufgeklappt, iPad).
struct Sidebar {
    let app: XCUIApplication

    func item(_ id: String) -> XCUIElement { app.descendants(matching: .any)["side.\(id)"].firstMatch }

    var list: XCUIElement {
        let named = app.collectionViews["sidebar"].firstMatch
        return named.exists ? named : app.collectionViews.firstMatch
    }

    var isShown: Bool { item("market").waitForExistence(timeout: 4) }

    /// Eintrag antippen; liegt er außerhalb des sichtbaren Teils (niedrige Fläche), vorher rollen.
    func open(_ id: String, file: StaticString = #filePath, line: UInt = #line) {
        let el = item(id)
        var tries = 0
        while !(el.exists && el.isHittable), tries < 3 { list.swipeUp(); tries += 1 }
        while !(el.exists && el.isHittable), tries < 8 { list.swipeDown(); tries += 1 }
        XCTAssertTrue(el.exists && el.isHittable, "Eintrag \(id) fehlt in der Seitenleiste", file: file, line: line)
        el.tap()
    }
}

extension XCUIApplication {
    /// Eine Ebene zurück. Den Zurück-Knopf legt das System je nach Pose in die
    /// Navigationsleiste (dort trägt er den Titel der vorigen Ebene) oder in seine Leiste am Rand.
    func goBack(to title: String, file: StaticString = #filePath, line: UInt = #line) {
        let candidates = [buttons["BackButton"].firstMatch, navigationBars.buttons[title].firstMatch, buttons["Zurück"].firstMatch]
        guard let button = candidates.first(where: { $0.exists && $0.isHittable }) else {
            XCTFail("kein Zurück-Knopf: \(buttons.allElementsBoundByIndex.map { "\($0.identifier)|\($0.label)" })", file: file, line: line)
            return
        }
        button.tap()
    }

    /// Artikel-Vorschau verlassen: schmal ein Blatt (Schließen), breit eine Seite im Stapel (Zurück).
    func leaveArticle(file: StaticString = #filePath, line: UInt = #line) {
        let close = buttons["Schließen"].firstMatch
        if close.exists && close.isHittable { close.tap() } else { goBack(to: "Nachrichten", file: file, line: line) }
    }
}
