// DemoStore.swift — die Demo-Anlage für App, Widgets und Kurzbefehle.
//
// Die Demo ist eine eigene „Anlage“ in der Anlagenliste: die eingebaute
// Beispielanlage (Paket DVhubLink, Demo/). Sie rechnet alles im Gerät und
// öffnet keine Netzverbindung. Hier liegt nur ihr bedienter Zustand (Not-Halt,
// Zeitplan, E-Auto …) — in den Einstellungen der App-Gruppe, damit auch die
// Widgets ihn sehen. Zugangsdaten gibt es keine, im Schlüsselbund steht nichts.
//
// Solange die Demo gewählt ist, greift kein Programmteil auf eine gekoppelte
// Anlage zu: Abrufe für Widgets und Kurzbefehle rechnen hier
// (`SnapshotRefresher`, `LinkAccess.selected()` verweigert den echten Weg).

import Foundation
import os
import DVhubLink

enum DemoStore {
    private static let stateKey = "demo.state"

    /// Name der Demo-Anlage in Listen, Widgets und Live-Aktivität.
    static var name: String { String(localized: "Demo-Anlage") }
    /// Eintrag der Demo in der Anlagenliste — ohne Wege, Ticket und Schlüssel.
    static var credentials: LinkCredentials { .demo(name: name) }

    /// Die Demo-Anlage steht in der Anlagenliste.
    static var isActive: Bool { SharedStore.defaults.data(forKey: stateKey) != nil }
    /// Die Demo ist die gewählte Anlage.
    static var isSelected: Bool { SharedStore.selectedSystemId == DemoPlant.boxId && isActive }

    /// Gespeicherter Zustand — auch einer, den ein älterer Stand der App geschrieben hat (State.restore).
    static func loadState() -> DemoPlant.State? {
        SharedStore.defaults.data(forKey: stateKey).flatMap(DemoPlant.State.restore)
    }

    static func save(_ state: DemoPlant.State) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        SharedStore.defaults.set(data, forKey: stateKey)
    }

    /// Uhr der Demo. Sie geht wie die Uhr des Geräts — nur im Debug-Build lässt
    /// sie sich für Bildschirmfotos verstellen (`-DVHUB_DEMO_SHIFT <Stunden>`:
    /// nachts den Mittag der Anlage zeigen).
    static var now: Date {
        #if DEBUG
        return Date().addingTimeInterval(UserDefaults.standard.double(forKey: "DVHUB_DEMO_SHIFT") * 3600)
        #else
        return Date()
        #endif
    }

    // MARK: Box der Demo (ein Exemplar je Programm)

    private struct Held {
        var box: DemoBox?
        /// Zählt mit jedem Beenden hoch: Eine beendete Demo speichert nichts mehr.
        var generation = 0
    }

    private static let shared = OSAllocatedUnfairLock(initialState: Held())

    /// Die Box der Demo-Anlage. Sie entsteht mit dem gespeicherten Zustand
    /// (oder frisch, wenn es keinen gibt oder er unlesbar ist) und speichert jede Änderung.
    /// Der Zugriff legt die Demo an — wer nur eine bestehende will, nimmt `existingBox`.
    static var box: DemoBox { box(create: true)! }

    /// Die Box, wenn es die Demo gibt — sonst nil (legt nichts an).
    static var existingBox: DemoBox? { box(create: false) }

    private static func box(create: Bool) -> DemoBox? {
        shared.withLock { held in
            if let box = held.box { return box }
            let state: DemoPlant.State
            if let stored = loadState() { state = stored } else {
                // Keine Demo (oder ihr Zustand ist unlesbar): nur auf Wunsch frisch beginnen.
                guard create || SharedStore.defaults.data(forKey: stateKey) != nil else { return nil }
                state = DemoPlant.State(startedAt: now)
                save(state)
            }
            let generation = held.generation
            let box = DemoBox(state: state, clock: { now }, onChange: { changed in
                // Antwortet eine alte Verbindung noch, nachdem die Demo beendet wurde, darf ihr
                // Zustand die Demo nicht wieder anlegen. Prüfen und Speichern unter derselben
                // Sperre wie das Beenden — dazwischen passt nichts.
                shared.withLock { if $0.box != nil, $0.generation == generation { save(changed) } }
            })
            held.box = box
            return box
        }
    }

    /// Demo anlegen (falls es sie noch nicht gibt).
    static func start() { _ = box }

    /// Lesezeichen der Beispielmeldungen (getrennt von dem der echten Nachrichten).
    static let newsSeenKey = "news.lastSeen.demo"

    /// Demo beenden: Zustand und Box verwerfen. Ein neuer Start beginnt frisch.
    static func end() {
        shared.withLock {
            $0.box = nil
            $0.generation += 1
            SharedStore.defaults.removeObject(forKey: stateKey)
        }
        UserDefaults.standard.removeObject(forKey: newsSeenKey)
    }

    // MARK: Stand für Widgets und Kurzbefehle

    /// Die Anlage mit dem gespeicherten Zustand — zum Lesen (auch in der Widget-Erweiterung).
    static func plant() -> DemoPlant? { loadState().map { DemoPlant(state: $0) } }

    /// Stand der Demo-Anlage zum Zeitpunkt `date`.
    static func snapshot(at date: Date = now) -> WidgetSnapshot? {
        plant().map { WidgetSnapshot(demo: $0, at: date) }
    }

    /// Die nächsten Stände im Abstand `step` — die Widgets zeichnen sie im Voraus,
    /// so läuft die Demo dort auch weiter, wenn die App zu ist.
    static func ahead(from date: Date = now, count: Int = 8, step: TimeInterval = 900) -> [WidgetSnapshot] {
        guard let plant = plant() else { return [] }
        return (1...max(1, count)).map { WidgetSnapshot(demo: plant, at: date.addingTimeInterval(Double($0) * step)) }
    }

    /// Not-Halt der Demo auslösen bzw. aufheben (Kurzbefehle) — über die Box der App, damit alle
    /// denselben Zustand sehen. nil: Die Demo gibt es nicht mehr (sie wird dafür nicht neu angelegt).
    static func emergencyStop(_ stop: Bool) async -> LinkResponse? {
        await existingBox?.request("POST", stop ? "/api/control/stop" : "/api/control/resume", body: [:])
    }
}

extension WidgetSnapshot {
    /// Stand der Demo-Anlage.
    init(demo plant: DemoPlant, at date: Date) {
        let l = plant.live(at: date)
        func cents(_ v: Double) -> Double { (v * 100).rounded() / 100 }
        self.init(boxName: DemoStore.name, boxId: DemoPlant.boxId, at: date, soc: (l.soc * 10).rounded() / 10, pvW: l.pvW.rounded(), loadW: l.loadW.rounded(),
                  gridImportW: l.gridImportW.rounded(), gridExportW: l.gridExportW.rounded(), batteryW: l.batteryW.rounded(),
                  todayNetEur: cents(l.today.netEur), todayRevenueEur: cents(l.today.revenueEur), todayCostEur: cents(l.today.costEur),
                  emergencyStop: plant.state.emergencyStop, alarmsActive: 0)
    }

    /// Werte der Beispielanlage — Widgets und Live-Aktivität kennzeichnen sie.
    var isDemo: Bool { boxId == DemoPlant.boxId }
}
