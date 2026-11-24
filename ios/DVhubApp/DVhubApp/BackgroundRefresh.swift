// BackgroundRefresh.swift — Hintergrundabruf nach Apples Muster
// (BackgroundTasks: BGAppRefreshTask über SwiftUIs `.backgroundTask(.appRefresh)`).
//
// Das System weckt die App gelegentlich für rund 30 Sekunden. Dann holt sie
// einen Stand der gewählten Anlage, legt ihn für die Widgets ab, lässt sie neu
// zeichnen und führt die Live-Aktivität nach. Wann und wie oft, entscheidet
// allein das System (Nutzung der App, Akku, Stromsparmodus, „Hintergrund-
// aktualisierung“ in den Einstellungen); `earliestBeginDate` ist nur eine
// Untergrenze. Bei gesperrtem Gerät ist der Geräteschlüssel nicht nutzbar —
// dann bleibt der letzte Stand stehen.

import BackgroundTasks
import Foundation
import WidgetKit

enum BackgroundRefresh {
    /// Kennung der Aufgabe; steht auch in der Info.plist
    /// (`BGTaskSchedulerPermittedIdentifiers`) und folgt der Bundle-ID.
    static let taskId = (Bundle.main.bundleIdentifier ?? "de.dvhub.app") + ".refresh"
    static let interval: TimeInterval = 15 * 60

    /// Nächsten Abruf anmelden (beim Wechsel in den Hintergrund und in jedem Lauf).
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskId)
        request.earliestBeginDate = Date().addingTimeInterval(interval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Simulator ohne Unterstützung, Hintergrundaktualisierung aus: kein Fehler für die Person.
            #if DEBUG
            print("DVHUB_BGREFRESH nicht angemeldet: \(error.localizedDescription)")
            #endif
        }
    }

    /// Ein Lauf. Wird er vom System abgebrochen, endet der Abruf mit.
    static func run() async {
        schedule()
        LinkAccess.configure()
        guard case .fresh(let snapshot) = await SnapshotRefresher.refresh(timeout: 20) else { return }
        WidgetCenter.shared.reloadAllTimelines()
        ControlCenter.shared.reloadControls(ofKind: SharedStore.controlKindStop)
        await LiveActivityManager.sync(snapshot)
    }
}
