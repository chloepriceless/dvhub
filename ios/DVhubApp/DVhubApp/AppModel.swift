// AppModel.swift — gespeicherte Anlagen, Auswahl, Kopplung.

import Foundation
import Observation
import UIKit
import WidgetKit
import DVhubLink

@MainActor
@Observable
final class AppModel {
    enum PairState: Equatable {
        case idle
        case connecting
        case waitingForApproval(name: String, code: String)
        case done(String)
        case failed(String)
    }

    private(set) var systems: [LinkCredentials] = []
    /// Gewählte Anlage — bleibt über Neustarts erhalten.
    var selectedId: String? {
        didSet {
            UserDefaults.standard.set(selectedId, forKey: Self.selectedKey)
            // Auch für Widgets, Kurzbefehle und den Hintergrundabruf (App-Gruppe).
            SharedStore.selectedSystemId = selectedId
        }
    }
    static let selectedKey = "selectedSystem"
    private(set) var controllers: [String: SystemController] = [:]
    private(set) var pairState: PairState = .idle
    private(set) var storageError: String?
    /// Gespeicherte Anlagen sind gelesen (erst dann zeigt die App Inhalte).
    private(set) var loaded = false
    /// Lesen aus dem Schlüsselbund ist gescheitert (z. B. Gerät noch gesperrt,
    /// App vorab gestartet). Solange das so ist, wird nie gespeichert — sonst
    /// würde die leere Liste die gespeicherten Kopplungen überschreiben.
    private var loadFailed = false
    /// Läuft gerade eine Kopplung? Synchron gesetzt, damit ein doppeltes Tippen
    /// keine zweite startet.
    private(set) var pairInFlight = false
    /// QR-Text aus einem dvhub://-Link (Kamera-App, Safari …). Die Kopplung
    /// startet erst, wenn man in der Ansicht Name, Kennung und Wege gesehen und
    /// „Koppeln“ getippt hat — nur ein Treffer des eigenen Scanners startet sofort.
    var pendingPairLink: String?
    /// Nur für Simulator-Tests (Debug-Startargument): Link ohne Rückfrage koppeln.
    var pendingPairAutoStart = false

    /// Bereich, den ein Link, ein Widget oder das Kontrollzentrum öffnen will
    /// (`dvhub://open/<Bereich>`); die Wurzelansicht übernimmt und leert ihn.
    var pendingOpen: String?
    /// Rückfrage zum Not-Halt, die von außen angestoßen wurde (Kontrollzentrum).
    /// Der Wert ist nur die Vermutung des Knopfs; ob ausgelöst oder aufgehoben
    /// wird, entscheidet die Ansicht „Steuern“ nach dem Live-Zustand.
    var pendingStopRequest: Bool?

    private let widgets = WidgetBridge()

    init() {
        // Geteilte Schlüsselbund-Gruppe einrichten und vorhandene Einträge
        // umziehen, bevor irgendetwas gelesen wird.
        LinkAccess.configure()
        IntentHooks.openEmergencyStop = { [weak self] stop in
            self?.pendingStopRequest = stop
            self?.pendingOpen = "control"
        }
        IntentHooks.snapshotChanged = { snapshot in await LiveActivityManager.sync(snapshot) }
    }

    /// Link in die App. Liefert false, wenn er nicht für die App ist.
    @discardableResult
    func handle(url: URL) -> Bool {
        guard url.scheme == "dvhub" else { return false }
        switch url.host {
        case "pair":
            // Kamera-App oder Link: dvhub://pair?…
            pendingPairLink = url.absoluteString
            return true
        case "open":
            pendingOpen = url.pathComponents.dropFirst().first
            return true
        default:
            return false
        }
    }

    /// Anlagen aus dem Schlüsselbund lesen. Wird bei jedem Wechsel in den
    /// Vordergrund wiederholt, solange es nicht geklappt hat.
    private func load() {
        do {
            let list = try KeyStore.loadSystems()
            systems = list
            loadFailed = false
            storageError = nil
        } catch {
            loadFailed = true
            storageError = String(localized: "Gespeicherte Anlagen konnten nicht gelesen werden (Gerät gesperrt?). Neuer Versuch beim nächsten Öffnen.")
        }
        loaded = true
        for s in systems where controllers[s.id] == nil { attach(s) }
        let remembered = SharedStore.selectedSystemId ?? UserDefaults.standard.string(forKey: Self.selectedKey)
        if selectedId == nil || !systems.contains(where: { $0.id == selectedId }) {
            selectedId = systems.contains(where: { $0.id == remembered }) ? remembered : systems.first?.id
        }
    }

    var selected: SystemController? { selectedId.flatMap { controllers[$0] } }

    private func attach(_ creds: LinkCredentials) {
        let c = SystemController(credentials: creds)
        c.onCredentialsChanged = { [weak self] updated in self?.store(updated) }
        c.onStatus = { [weak self, weak c] status, at in
            guard let self, let c, c.credentials.id == self.selectedId else { return }
            self.widgets.update(status, at: at, boxName: c.credentials.boxName, boxId: c.credentials.id)
        }
        controllers[creds.id] = c
    }

    private func store(_ creds: LinkCredentials) {
        if let i = systems.firstIndex(where: { $0.id == creds.id }) { systems[i] = creds } else { systems.append(creds) }
        persist()
    }

    @discardableResult
    private func persist() -> Bool {
        guard !loadFailed else { return false }
        do {
            try KeyStore.saveSystems(systems)
            storageError = nil
            return true
        } catch {
            storageError = String(localized: "Speichern im Schlüsselbund fehlgeschlagen.")
            return false
        }
    }

    // MARK: Lebenszyklus (Vordergrund/Hintergrund)

    func activate() {
        if !loaded || loadFailed { load() }
        selected?.start()
    }

    func deactivate() {
        for c in controllers.values { c.stop() }
        // Beim Verlassen den letzten Stand sicher an die Widgets geben.
        if let c = selected, let s = c.displayStatus, let at = c.displayAt {
            widgets.update(s, at: at, boxName: c.credentials.boxName, boxId: c.credentials.id, force: true)
        }
        BackgroundRefresh.schedule()
    }

    func select(_ id: String) {
        guard id != selectedId else { return }
        selected?.stop()
        selectedId = id
        widgets.reset()
        selected?.start()
    }

    // MARK: Kopplung

    static var deviceModel: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { buf in
            String(decoding: buf.prefix { $0 != 0 }, as: UTF8.self)
        }
        return machine.isEmpty ? UIDevice.current.model : machine
    }

    /// Kopplung starten. Synchron gesperrt: Zweimal Tippen (oder Scanner und
    /// Link zugleich) startet nur eine Kopplung — sonst verbrauchte der erste
    /// Versuch den QR-Code und der zweite meldete einen Fehler.
    @discardableResult
    func startPairing(qr: String) -> Bool {
        guard !pairInFlight else { return false }
        pairInFlight = true
        Task {
            await pair(qr: qr)
            pairInFlight = false
        }
        return true
    }

    private func pair(qr: String) async {
        guard !loadFailed else {
            pairState = .failed(String(localized: "Die gespeicherten Anlagen sind gerade nicht lesbar. Bitte Gerät entsperren und App neu öffnen."))
            return
        }
        let payload: PairPayload
        do {
            payload = try PairPayload(qr)
        } catch {
            pairState = .failed(userMessage(for: error))
            return
        }
        guard payload.expires > Date() else {
            pairState = .failed(String(localized: "Der QR-Code ist abgelaufen. Bitte in DVhub einen neuen erzeugen."))
            return
        }
        guard !payload.lan.isEmpty || payload.relay != nil else {
            pairState = .failed(String(localized: "Der QR-Code enthält keinen Weg zur Anlage."))
            return
        }
        pairState = .connecting
        let created: (signer: LinkSigner, keyRef: String)
        do {
            created = try KeyStore.createSigner()
        } catch {
            pairState = .failed(String(localized: "Geräteschlüssel konnte nicht angelegt werden: \(error.localizedDescription)"))
            return
        }
        let boxName = payload.name
        do {
            var creds = try await pairDevice(
                qr: qr, signer: created.signer, name: UIDevice.current.name, model: Self.deviceModel,
                onWait: { [weak self] code in Task { @MainActor in self?.pairState = .waitingForApproval(name: boxName, code: code) } }
            )
            creds.keyRef = created.keyRef
            // Erst die neuen Zugangsdaten sicher speichern, dann den alten
            // Schlüssel löschen — scheitert das Speichern, bleibt die alte
            // Kopplung vollständig erhalten (Codex R4).
            let old = systems.first(where: { $0.id == creds.id })
            let previous = systems
            if let i = systems.firstIndex(where: { $0.id == creds.id }) { systems[i] = creds } else { systems.append(creds) }
            guard persist() else {
                systems = previous
                KeyStore.deleteKey(created.keyRef)
                pairState = .failed(String(localized: "Die Kopplung konnte nicht im Schlüsselbund gespeichert werden. Bitte erneut versuchen."))
                return
            }
            if let old {
                // Neu gekoppelt: alte Verbindung und alten Schlüssel ersetzen.
                controllers[old.id]?.stop()
                if let ref = old.keyRef, ref != created.keyRef { KeyStore.deleteKey(ref) }
            }
            attach(creds)
            selected?.stop()
            selectedId = creds.id
            selected?.start()
            pairState = .done(creds.boxName)
        } catch {
            KeyStore.deleteKey(created.keyRef)
            switch error as? LinkError {
            case .pairingDenied: pairState = .failed(String(localized: "In DVhub abgelehnt."))
            case .boxSignatureInvalid: pairState = .failed(String(localized: "Die Gegenstelle hat sich nicht als diese Anlage ausgewiesen."))
            default: pairState = .failed(userMessage(for: error))
            }
        }
    }

    func resetPairState() { pairState = .idle }

    /// Nur auf dem Handy entfernen. Die Kopplung in DVhub bleibt bestehen, bis
    /// sie dort unter „Handy-App“ entfernt wird.
    func remove(_ id: String) {
        guard !loadFailed else { return }
        controllers[id]?.stop()
        controllers[id] = nil
        SystemController.forgetMailbox(id)
        if let ref = systems.first(where: { $0.id == id })?.keyRef { KeyStore.deleteKey(ref) }
        systems.removeAll { $0.id == id }
        persist()
        if selectedId == id {
            selectedId = systems.first?.id
            widgets.reset()
            selected?.start()
        }
    }
}

/// Gibt den letzten Stand der gewählten Anlage an Widgets, Kontrollzentrum
/// und Live-Aktivität (App-Gruppe). Gedrosselt: Live-Werte kommen alle 2 s,
/// die Widgets brauchen das nicht — und das System begrenzt, wie oft eine App
/// ihre Widgets neu zeichnen lässt. Not-Halt und Alarme gehen sofort durch.
@MainActor
final class WidgetBridge {
    private var lastWrite: Date?
    private var lastReload: Date?
    private var lastSnapshot: WidgetSnapshot?
    static let writeEvery: TimeInterval = 30
    static let reloadEvery: TimeInterval = 300

    func update(_ s: LiveStatus, at: Date, boxName: String, boxId: String, force: Bool = false) {
        let now = Date()
        let snap = WidgetSnapshot(s, at: at, boxName: boxName, boxId: boxId)
        // Wichtiges (Not-Halt, Alarm) wartet nicht auf die Drosselung.
        let urgent = lastSnapshot.map { $0.emergencyStop != snap.emergencyStop || $0.alarmsActive != snap.alarmsActive } ?? true
        if !force, !urgent, let lastWrite, now.timeIntervalSince(lastWrite) < Self.writeEvery { return }
        lastWrite = now
        lastSnapshot = snap
        // Die Live-Aktivität braucht keine App-Gruppe.
        Task { await LiveActivityManager.sync(snap) }
        guard SharedStore.isAvailable, SharedStore.write(snap) else { return }
        if urgent { ControlCenter.shared.reloadControls(ofKind: SharedStore.controlKindStop) }
        if force || urgent || lastReload.map({ now.timeIntervalSince($0) >= Self.reloadEvery }) ?? true {
            lastReload = now
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// Anlage gewechselt oder entfernt: alten Stand löschen.
    func reset() {
        lastWrite = nil
        lastSnapshot = nil
        Task { await LiveActivityManager.endAll() }
        guard SharedStore.isAvailable else { return }
        SharedStore.clear()
        lastReload = Date()
        WidgetCenter.shared.reloadAllTimelines()
        ControlCenter.shared.reloadControls(ofKind: SharedStore.controlKindStop)
    }
}
