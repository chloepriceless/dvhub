// AppModel.swift — gespeicherte Anlagen, Auswahl, Kopplung.

import Foundation
import Observation
import UIKit
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
        didSet { UserDefaults.standard.set(selectedId, forKey: Self.selectedKey) }
    }
    static let selectedKey = "selectedSystem"
    private(set) var controllers: [String: SystemController] = [:]
    private(set) var pairState: PairState = .idle
    private(set) var storageError: String?
    /// QR-Text aus einem dvhub://-Link, der auf Bestätigung wartet.
    var pendingPairLink: String?

    init() {
        do {
            systems = try KeyStore.loadSystems()
        } catch {
            storageError = (error as? LinkError)?.description ?? error.localizedDescription
        }
        let remembered = UserDefaults.standard.string(forKey: Self.selectedKey)
        selectedId = systems.contains(where: { $0.id == remembered }) ? remembered : systems.first?.id
        for s in systems { attach(s) }
    }

    var selected: SystemController? { selectedId.flatMap { controllers[$0] } }

    private func attach(_ creds: LinkCredentials) {
        let c = SystemController(credentials: creds)
        c.onCredentialsChanged = { [weak self] updated in self?.store(updated) }
        controllers[creds.id] = c
    }

    private func store(_ creds: LinkCredentials) {
        if let i = systems.firstIndex(where: { $0.id == creds.id }) { systems[i] = creds } else { systems.append(creds) }
        persist()
    }

    private func persist() {
        do { try KeyStore.saveSystems(systems); storageError = nil } catch {
            storageError = (error as? LinkError)?.description ?? error.localizedDescription
        }
    }

    // MARK: Lebenszyklus (Vordergrund/Hintergrund)

    func activate() {
        selected?.start()
    }

    func deactivate() {
        for c in controllers.values { c.stop() }
    }

    func select(_ id: String) {
        guard id != selectedId else { return }
        selected?.stop()
        selectedId = id
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

    func pair(qr: String) async {
        let payload: PairPayload
        do {
            payload = try PairPayload(qr)
        } catch {
            pairState = .failed((error as? LinkError)?.description ?? "Kein gültiger Kopplungscode")
            return
        }
        guard payload.expires > Date() else {
            pairState = .failed("Der QR-Code ist abgelaufen. Bitte in DVhub einen neuen erzeugen.")
            return
        }
        guard !payload.lan.isEmpty || payload.relay != nil else {
            pairState = .failed("Der QR-Code enthält keinen Weg zur Anlage.")
            return
        }
        pairState = .connecting
        let created: (signer: LinkSigner, keyRef: String)
        do {
            created = try KeyStore.createSigner()
        } catch {
            pairState = .failed("Geräteschlüssel konnte nicht angelegt werden: \(error.localizedDescription)")
            return
        }
        let boxName = payload.name
        do {
            var creds = try await pairDevice(
                qr: qr, signer: created.signer, name: UIDevice.current.name, model: Self.deviceModel,
                onWait: { [weak self] code in Task { @MainActor in self?.pairState = .waitingForApproval(name: boxName, code: code) } }
            )
            creds.keyRef = created.keyRef
            if let old = systems.first(where: { $0.id == creds.id }) {
                // Neu gekoppelt: alte Verbindung und alten Schlüssel ersetzen.
                controllers[old.id]?.stop()
                if let ref = old.keyRef { KeyStore.deleteKey(ref) }
            }
            store(creds)
            attach(creds)
            selected?.stop()
            selectedId = creds.id
            selected?.start()
            pairState = .done(creds.boxName)
        } catch {
            KeyStore.deleteKey(created.keyRef)
            let msg: String
            switch error as? LinkError {
            case .pairingDenied: msg = "In DVhub abgelehnt."
            case .closed(_, let reason) where reason == "pairing_not_open":
                msg = "Dieser QR-Code ist schon verbraucht oder abgelaufen. Bitte in DVhub einen neuen erzeugen."
            case .some(let e): msg = e.description
            case .none: msg = error.localizedDescription
            }
            pairState = .failed(msg)
        }
    }

    func resetPairState() { pairState = .idle }

    /// Nur auf dem Handy entfernen. Die Kopplung in DVhub bleibt bestehen, bis
    /// sie dort unter „Handy-App“ entfernt wird.
    func remove(_ id: String) {
        controllers[id]?.stop()
        controllers[id] = nil
        if let ref = systems.first(where: { $0.id == id })?.keyRef { KeyStore.deleteKey(ref) }
        systems.removeAll { $0.id == id }
        persist()
        if selectedId == id {
            selectedId = systems.first?.id
            selected?.start()
        }
    }
}
