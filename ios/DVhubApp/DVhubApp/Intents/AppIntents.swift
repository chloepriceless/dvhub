// AppIntents.swift — Kurzbefehle und Siri (App Intents).
//
// Lesen: Akkustand, Erzeugung, Netz, Hausverbrauch, Tagesverdienst, Überblick.
// Die Antwort kommt frisch von der Anlage, wenn das geht (Heimnetz oder Relay,
// Gerät entsperrt), sonst vom letzten Stand — dann mit Uhrzeit.
//
// Schalten: nur der Not-Halt (in DVhub freigegeben). Er verlangt das entsperrte
// iPhone (`authenticationPolicy`) und eine ausdrückliche Bestätigung
// (`requestConfirmation`). Weitere Schaltpfade gibt es hier nicht.
//
// Ist die Demo gewählt, antworten die Kurzbefehle mit den Werten der
// Beispielanlage und sagen das dazu; der Not-Halt schaltet dann nur die Demo.

import AppIntents
import Foundation
import WidgetKit
import DVhubLink

// MARK: - Daten für die Antworten

/// Fehler, die Siri bzw. die Kurzbefehle-App als Satz ausgeben.
enum IntentFailure: Error, CustomLocalizedStringResourceConvertible {
    case noSystem
    case locked
    case noData
    case noValue
    case notAllowed
    case unreachable
    /// Zwischen Rückfrage und Ausführung wurde eine andere Anlage gewählt (oder die Demo beendet).
    case targetChanged
    case message(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .noSystem: return "Es ist noch keine Anlage gekoppelt. Öffne DVhub und kopple deine Anlage."
        case .locked: return "Entsperre das iPhone – die Verbindung zur Anlage ist nur dann möglich."
        case .noData: return "Ich habe noch keinen Stand der Anlage. Öffne DVhub einmal."
        case .noValue: return "Diesen Wert liefert die Anlage gerade nicht."
        case .notAllowed: return "Dieses Gerät darf nicht steuern. In DVhub unter „Handy-App“ freigeben."
        case .unreachable: return "Die Anlage ist gerade nicht erreichbar."
        case .targetChanged: return "Inzwischen ist eine andere Anlage gewählt. Es wurde nichts geschaltet – bitte noch einmal."
        case .message(let text): return "\(text)"
        }
    }
}

struct IntentReading {
    let snapshot: WidgetSnapshot
    /// Gerade eben von der Anlage geholt (sonst: letzter gespeicherter Stand).
    let fresh: Bool

    /// Der Stand ist jung genug, um ihn ohne Uhrzeit zu nennen. Allein nach
    /// seinem Alter: Auch ein eben geholter Stand kann alt sein — ist die Anlage
    /// nicht erreichbar, liefert das Relay den letzten aus dem Briefkasten.
    var current: Bool { Date().timeIntervalSince(snapshot.at) < 120 }
    var time: String { Format.dateTime(snapshot.at) }

    /// Antwort für Siri bzw. die Kurzbefehle-App. Werte der Beispielanlage sind als solche benannt.
    func say(_ text: String) -> IntentDialog { Self.say(text, demo: snapshot.isDemo) }

    static func say(_ text: String, demo: Bool) -> IntentDialog {
        demo ? "\(String(localized: "Demo-Anlage: \(text)", comment: "Antwort eines Kurzbefehls mit Werten der Beispielanlage"))" : "\(text)"
    }

    static func load() async throws -> IntentReading {
        LinkAccess.configure()
        switch await SnapshotRefresher.refresh(timeout: 8) {
        case .fresh(let s):
            await IntentHooks.snapshotChanged?(s)
            return IntentReading(snapshot: s, fresh: true)
        case .unchanged(let s?, _):
            return IntentReading(snapshot: s, fresh: false)
        case .unchanged(nil, let reason):
            switch reason {
            case .noSystem: throw IntentFailure.noSystem
            case .locked: throw IntentFailure.locked
            default: throw IntentFailure.noData
            }
        }
    }
}

// MARK: - Lesen

struct BatteryLevelIntent: AppIntent {
    static let title: LocalizedStringResource = "Akkustand abfragen"
    static let description = IntentDescription("Sagt, wie voll der Akku ist und ob er lädt oder entlädt.", categoryName: "Anlage")

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
        let r = try await IntentReading.load()
        guard let soc = r.snapshot.soc else { throw IntentFailure.noValue }
        let level = Format.percent(soc)
        let w = r.snapshot.batteryW ?? 0
        let text: String
        if !r.current {
            text = String(localized: "Der Akku war \(r.time) zu \(level) geladen.")
        } else if w >= 20 {
            text = String(localized: "Der Akku ist zu \(level) geladen und lädt mit \(Format.power(w)).")
        } else if w <= -20 {
            text = String(localized: "Der Akku ist zu \(level) geladen und entlädt mit \(Format.power(w)).")
        } else {
            text = String(localized: "Der Akku ist zu \(level) geladen.")
        }
        return .result(value: soc, dialog: r.say(text))
    }
}

struct ProductionIntent: AppIntent {
    static let title: LocalizedStringResource = "Erzeugung abfragen"
    static let description = IntentDescription("Sagt, wie viel die Photovoltaik gerade erzeugt.", categoryName: "Anlage")

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
        let r = try await IntentReading.load()
        guard let pv = r.snapshot.pvW else { throw IntentFailure.noValue }
        let text = r.current ? String(localized: "Die Anlage erzeugt gerade \(Format.power(pv)).") : String(localized: "Die Anlage erzeugte \(r.time) \(Format.power(pv)).")
        return .result(value: pv, dialog: r.say(text))
    }
}

struct GridIntent: AppIntent {
    static let title: LocalizedStringResource = "Netz abfragen"
    static let description = IntentDescription("Sagt, ob gerade Strom eingespeist oder bezogen wird.", categoryName: "Anlage")

    /// Ergebnis in Watt: positiv = Bezug, negativ = Einspeisung.
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
        let r = try await IntentReading.load()
        let s = r.snapshot
        guard s.gridImportW != nil || s.gridExportW != nil else { throw IntentFailure.noValue }
        let imp = s.gridImportW ?? 0, exp = s.gridExportW ?? 0
        let text: String
        if max(imp, exp) < 20 {
            text = r.current ? String(localized: "Am Netz ist es gerade ausgeglichen.") : String(localized: "Am Netz war es \(r.time) ausgeglichen.")
        } else if exp > imp {
            text = r.current ? String(localized: "Du speist gerade \(Format.power(exp)) ein.") : String(localized: "\(r.time) wurden \(Format.power(exp)) eingespeist.")
        } else {
            text = r.current ? String(localized: "Du beziehst gerade \(Format.power(imp)) aus dem Netz.") : String(localized: "\(r.time) wurden \(Format.power(imp)) aus dem Netz bezogen.")
        }
        return .result(value: imp - exp, dialog: r.say(text))
    }
}

struct ConsumptionIntent: AppIntent {
    static let title: LocalizedStringResource = "Hausverbrauch abfragen"
    static let description = IntentDescription("Sagt, wie viel das Haus gerade verbraucht.", categoryName: "Anlage")

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
        let r = try await IntentReading.load()
        guard let load = r.snapshot.loadW else { throw IntentFailure.noValue }
        let text = r.current ? String(localized: "Das Haus verbraucht gerade \(Format.power(load)).") : String(localized: "Das Haus verbrauchte \(r.time) \(Format.power(load)).")
        return .result(value: load, dialog: r.say(text))
    }
}

struct TodayEarningsIntent: AppIntent {
    static let title: LocalizedStringResource = "Tagesverdienst abfragen"
    static let description = IntentDescription("Sagt, was die Anlage heute verdient oder gekostet hat.", categoryName: "Anlage")
    /// Geldwerte nur bei entsperrtem Gerät.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    /// Ergebnis in Euro: positiv = verdient, negativ = gekostet.
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
        let r = try await IntentReading.load()
        guard let net = r.snapshot.todayNetEur else { throw IntentFailure.noValue }
        guard SnapshotDay.of(r.snapshot.at, now: Date()) == .today else { throw IntentFailure.noData }
        let amount = Format.euro(abs(net))
        let text: String
        if net >= 0 {
            text = r.current ? String(localized: "Heute hat die Anlage bisher \(amount) verdient.") : String(localized: "Bis \(r.time) hat die Anlage \(amount) verdient.")
        } else {
            text = r.current ? String(localized: "Heute hat die Anlage bisher \(amount) gekostet.") : String(localized: "Bis \(r.time) hat die Anlage \(amount) gekostet.")
        }
        return .result(value: net, dialog: r.say(text))
    }
}

struct PlantOverviewIntent: AppIntent {
    static let title: LocalizedStringResource = "Überblick über die Anlage"
    static let description = IntentDescription("Akkustand, Erzeugung, Hausverbrauch und Netz in einem Satz.", categoryName: "Anlage")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let r = try await IntentReading.load()
        let s = r.snapshot
        let imp = s.gridImportW ?? 0, exp = s.gridExportW ?? 0
        let grid: String
        if max(imp, exp) < 20 {
            grid = String(localized: "Netz ausgeglichen")
        } else if exp > imp {
            grid = String(localized: "Einspeisung \(Format.power(exp))")
        } else {
            grid = String(localized: "Bezug \(Format.power(imp))")
        }
        let stop = s.emergencyStop == true ? String(localized: " Der Not-Halt ist aktiv.") : ""
        let text = r.current
            ? String(localized: "Akku \(Format.percent(s.soc)), Erzeugung \(Format.power(s.pvW)), Verbrauch \(Format.power(s.loadW)), \(grid).\(stop)")
            : String(localized: "Stand \(r.time): Akku \(Format.percent(s.soc)), Erzeugung \(Format.power(s.pvW)), Verbrauch \(Format.power(s.loadW)), \(grid).\(stop)")
        return .result(dialog: r.say(text))
    }
}

// MARK: - Schalten: Not-Halt

/// Führt den Not-Halt aus bzw. hebt ihn auf — ein einzelner Abruf, ohne die
/// Oberfläche. Schreibt den neuen Stand für Widgets und Live-Aktivität.
enum EmergencyStopAction {
    /// Wen die Rückfrage genannt hat: die Demo oder eine gekoppelte Anlage (Kennung; nil = noch keine gewählt).
    enum Target: Equatable {
        case demo
        case plant(String?)

        static var current: Target { DemoStore.isSelected ? .demo : .plant(SharedStore.selectedSystemId) }
    }

    /// Schaltet genau das Ziel, das in der Rückfrage stand. Wurde inzwischen etwas anderes gewählt
    /// (eine Kopplung wurde fertig, die Demo beendet), schaltet nichts: Wer „nur die Demo“ bestätigt
    /// hat, erreicht nie eine Anlage — und umgekehrt.
    static func run(stop: Bool, confirmed target: Target) async throws -> ControlOutcome {
        LinkAccess.configure()
        guard Target.current == target else { throw IntentFailure.targetChanged }
        // Demo bestätigt: nur die Beispielanlage schalten — keine Verbindung, zu keiner Anlage.
        if target == .demo { return try await runDemo(stop: stop) }
        let access: (credentials: LinkCredentials, signer: LinkSigner)
        do {
            access = try LinkAccess.selected()
        } catch LinkAccess.Failure.demo {
            throw IntentFailure.targetChanged
        } catch LinkAccess.Failure.noSystem {
            throw IntentFailure.noSystem
        } catch LinkAccess.Failure.locked {
            throw IntentFailure.locked
        } catch {
            throw IntentFailure.noData
        }
        // Genau die Anlage aus der Rückfrage — nicht eine, die inzwischen an ihre Stelle getreten ist.
        if case .plant(let id?) = target, access.credentials.id != id { throw IntentFailure.targetChanged }
        // Die Box prüft das Recht selbst (und hat das letzte Wort); hier nur die schnelle Absage.
        guard access.credentials.canControl else { throw IntentFailure.notAllowed }
        let signer = SendableSigner(access.signer)
        let creds = access.credentials
        let result: (response: LinkResponse, after: QuickSnapshot?)
        do {
            result = try await QuickLink.request(credentials: creds, signer: signer.value, method: "POST",
                                                 path: stop ? "/api/control/stop" : "/api/control/resume", body: [:])
        } catch LinkError.boxOffline {
            throw IntentFailure.unreachable
        } catch {
            throw IntentFailure.message(userMessage(for: error))
        }
        let outcome = ControlOutcome.from(result.response)
        if let after = result.after {
            let snapshot = WidgetSnapshot(after.status, at: after.at, boxName: after.boxName ?? creds.boxName, boxId: creds.id)
            SharedStore.write(snapshot)
            WidgetCenter.shared.reloadAllTimelines()
            ControlCenter.shared.reloadControls(ofKind: SharedStore.controlKindStop)
            await LiveActivityManager.sync(snapshot)
        }
        return outcome
    }

    /// Not-Halt der Demo-Anlage: ändert ihren Zustand im Gerät und führt Widgets und Live-Aktivität nach.
    private static func runDemo(stop: Bool) async throws -> ControlOutcome {
        // Die Demo wird hierfür nicht neu angelegt: Gibt es sie nicht mehr, schaltet nichts.
        guard let response = await DemoStore.emergencyStop(stop) else { throw IntentFailure.targetChanged }
        let outcome = ControlOutcome.from(response)
        // Stand nur ablegen, solange die Demo noch gewählt ist — sonst gehört der Platz der anderen Anlage.
        if DemoStore.isSelected, let snapshot = DemoStore.snapshot() {
            SharedStore.write(snapshot)
            WidgetCenter.shared.reloadAllTimelines()
            ControlCenter.shared.reloadControls(ofKind: SharedStore.controlKindStop)
            await LiveActivityManager.sync(snapshot)
        }
        return outcome
    }
}

/// „Not-Halt auslösen“ für Kurzbefehle und Siri. `LiveActivityIntent`: läuft
/// im Prozess der App und darf dort die Live-Aktivität „Not-Halt aktiv“ starten.
struct TriggerEmergencyStopIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Not-Halt auslösen"
    static let description = IntentDescription(
        "DVhub hört auf, Sollwerte an die Anlage zu schreiben. Fragt vorher nach und verlangt ein entsperrtes Gerät.",
        categoryName: "Steuern")
    /// Nur mit entsperrtem iPhone — nicht über eine entsperrte Uhr, nicht vom Sperrbildschirm.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    func perform() async throws -> some IntentResult & ProvidesDialog {
        // Das Ziel steht fest, bevor gefragt wird — ausgeführt wird nur an genau diesem.
        let target = EmergencyStopAction.Target.current
        let demo = target == .demo
        try await requestConfirmation(
            actionName: .custom(acceptLabel: "Not-Halt auslösen", acceptAlternatives: [], denyLabel: "Abbrechen", denyAlternatives: [], destructive: true),
            dialog: demo ? "Not-Halt der Demo-Anlage auslösen? Geschaltet wird nichts – es ändert sich nur die Demo."
                         : "Not-Halt auslösen? DVhub hört auf, Sollwerte an die Anlage zu schreiben.")
        let outcome = try await EmergencyStopAction.run(stop: true, confirmed: target)
        // Hat die Anlage nicht geschaltet, ist das ein Fehler — sonst liefe ein
        // Kurzbefehl nach „Not-Halt auslösen“ weiter, als wäre er aktiv.
        guard outcome.applied else { throw IntentFailure.message(outcome.message) }
        return .result(dialog: IntentReading.say(outcome == .done ? String(localized: "Der Not-Halt ist aktiv.") : outcome.message, demo: demo))
    }
}

struct ReleaseEmergencyStopIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Not-Halt aufheben"
    static let description = IntentDescription(
        "DVhub regelt die Anlage wieder. Fragt vorher nach und verlangt ein entsperrtes Gerät.",
        categoryName: "Steuern")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let target = EmergencyStopAction.Target.current
        let demo = target == .demo
        try await requestConfirmation(
            actionName: .custom(acceptLabel: "Not-Halt aufheben", acceptAlternatives: [], denyLabel: "Abbrechen", denyAlternatives: [], destructive: false),
            dialog: demo ? "Not-Halt der Demo-Anlage aufheben?" : "Not-Halt aufheben? DVhub regelt die Anlage dann wieder.")
        let outcome = try await EmergencyStopAction.run(stop: false, confirmed: target)
        guard outcome.applied else { throw IntentFailure.message(outcome.message) }
        return .result(dialog: IntentReading.say(outcome == .done ? String(localized: "Der Not-Halt ist aufgehoben. DVhub regelt wieder.") : outcome.message, demo: demo))
    }
}

// MARK: - Kurzbefehle

struct DVhubShortcuts: AppShortcutsProvider {
    static let shortcutTileColor: ShortcutTileColor = .teal

    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: BatteryLevelIntent(),
                    phrases: ["Wie voll ist der Akku in \(.applicationName)?", "\(.applicationName) Akkustand", "Akkustand mit \(.applicationName)"],
                    shortTitle: "Akkustand", systemImageName: "battery.75percent")
        AppShortcut(intent: ProductionIntent(),
                    phrases: ["Wie viel erzeugt \(.applicationName)?", "\(.applicationName) Erzeugung", "Was macht die Sonne in \(.applicationName)?"],
                    shortTitle: "Erzeugung", systemImageName: "sun.max.fill")
        AppShortcut(intent: GridIntent(),
                    phrases: ["Speist \(.applicationName) gerade ein?", "\(.applicationName) Netz", "Wie viel Strom beziehe ich laut \(.applicationName)?"],
                    shortTitle: "Netz", systemImageName: "bolt.horizontal.fill")
        AppShortcut(intent: ConsumptionIntent(),
                    phrases: ["Wie viel verbraucht das Haus laut \(.applicationName)?", "\(.applicationName) Verbrauch"],
                    shortTitle: "Verbrauch", systemImageName: "house.fill")
        AppShortcut(intent: TodayEarningsIntent(),
                    phrases: ["Was hat \(.applicationName) heute verdient?", "\(.applicationName) Tagesverdienst", "Tagesverdienst mit \(.applicationName)"],
                    shortTitle: "Tagesverdienst", systemImageName: "eurosign.circle.fill")
        AppShortcut(intent: PlantOverviewIntent(),
                    phrases: ["Wie läuft \(.applicationName)?", "\(.applicationName) Überblick", "Überblick mit \(.applicationName)"],
                    shortTitle: "Überblick", systemImageName: "bolt.circle.fill")
        AppShortcut(intent: TriggerEmergencyStopIntent(),
                    phrases: ["Not-Halt mit \(.applicationName) auslösen", "\(.applicationName) Not-Halt auslösen"],
                    shortTitle: "Not-Halt auslösen", systemImageName: "stop.circle")
        AppShortcut(intent: ReleaseEmergencyStopIntent(),
                    phrases: ["Not-Halt mit \(.applicationName) aufheben", "\(.applicationName) Not-Halt aufheben"],
                    shortTitle: "Not-Halt aufheben", systemImageName: "play.circle")
    }
}
