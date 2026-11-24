// SharedIntents.swift — App Intents, die App und Widget-Erweiterung beide
// kennen müssen: der Aktualisieren-Knopf der Widgets und der Knopf im
// Kontrollzentrum.

import AppIntents
import WidgetKit
import DVhubLink

/// Einstiege, die nur die App erfüllen kann (Navigation, Live-Aktivität). Die
/// App setzt sie beim Start; in der Erweiterung bleiben sie leer.
@MainActor
enum IntentHooks {
    /// Bereich „Steuern“ öffnen und die Rückfrage zum Not-Halt zeigen
    /// (true: auslösen, false: aufheben).
    static var openEmergencyStop: ((Bool) -> Void)?
    /// Neuer Stand nach einem Abruf oder Schaltbefehl (Live-Aktivität nachführen).
    static var snapshotChanged: ((WidgetSnapshot) async -> Void)?
}

/// Aktualisieren-Knopf im Widget: holt einen frischen Stand. Läuft im Prozess
/// der Erweiterung; danach zeichnet das System die Widgets neu. Nur Lesen.
struct RefreshSnapshotIntent: AppIntent {
    static let title: LocalizedStringResource = "Werte aktualisieren"
    static let description = IntentDescription("Holt den aktuellen Stand der Anlage für die Widgets.")
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult {
        LinkAccess.configure()
        if case .fresh(let snapshot) = await SnapshotRefresher.refresh(timeout: 10) {
            await IntentHooks.snapshotChanged?(snapshot)
        }
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

/// Knopf im Kontrollzentrum, auf dem Sperrbildschirm und an der Aktionstaste:
/// öffnet DVhub im Bereich „Steuern“ mit der Rückfrage zum Not-Halt.
///
/// Warum kein Schalter, der sofort schaltet: Das Kontrollzentrum kann keine
/// Rückfrage zeigen (Apple dokumentiert für Controls keinen Dialog; ein
/// Schalter würde ohne Bestätigung schalten). Der Not-Halt braucht aber beides —
/// also entsperrt das System zuerst das Gerät (`authenticationPolicy`), dann
/// fragt die App nach und lässt mit Touch ID, Face ID oder Gerätecode bestätigen.
struct OpenEmergencyStopIntent: AppIntent {
    static let title: LocalizedStringResource = "Not-Halt in DVhub öffnen"
    static let description = IntentDescription("Öffnet DVhub mit der Rückfrage, den Not-Halt auszulösen oder aufzuheben.")
    static let isDiscoverable = false
    /// Nur mit entsperrtem iPhone — nicht über eine entsperrte Uhr.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    /// Vor iOS 26: App öffnen.
    static let openAppWhenRun = true
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }

    @MainActor
    func perform() async throws -> some IntentResult {
        // Läuft im Prozess der App (Vordergrund). Welche Richtung gefragt wird,
        // entscheidet der aktuelle Zustand: aktiv → aufheben, sonst auslösen.
        let active = SharedStore.read()?.emergencyStop == true
        IntentHooks.openEmergencyStop?(!active)
        return .result()
    }
}
