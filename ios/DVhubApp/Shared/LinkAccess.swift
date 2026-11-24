// LinkAccess.swift — Zugang zur gewählten Anlage außerhalb der laufenden App:
// Hintergrundabruf, Widgets, Kurzbefehle, Kontrollzentrum.
//
// Zugangsdaten und Geräteschlüssel liegen im Schlüsselbund, in einer Gruppe,
// die App und Erweiterung teilen (Keychain Access Group, siehe
// Config/*.entitlements). Die Schutzklasse bleibt „nur bei entsperrtem Gerät,
// nur dieses Gerät“, der Geräteschlüssel bleibt in der Secure Enclave. Folge:
// Bei gesperrtem Gerät kann niemand abrufen — weder App noch Erweiterung. Dann
// bleibt der letzte Stand stehen, mit Uhrzeit.

import Foundation
import Security
import os
import DVhubLink

enum LinkAccess {
    enum Failure: Error, Equatable {
        /// Keine Anlage gekoppelt.
        case noSystem
        /// Gerät gesperrt: Der Schlüsselbund gibt nichts heraus.
        case locked
        /// Die Zugangsdaten sind für dieses Programm nicht sichtbar (ohne
        /// geteilte Schlüsselbund-Gruppe gebaut oder App seit dem Update nie geöffnet).
        case notShared
        /// Der Geräteschlüssel lässt sich in diesem Programm nicht verwenden.
        case keyUnavailable
        /// Die Demo ist gewählt: Es gibt keine Zugangsdaten — und zu einer
        /// gekoppelten Anlage wird dann nicht gegriffen.
        case demo
    }

    /// Läuft dieses Programm als Erweiterung (Widgets, Kontrollzentrum)?
    static let isExtension = Bundle.main.bundleURL.pathExtension == "appex"

    /// Die geteilte Schlüsselbund-Gruppe ist für dieses Programm nutzbar.
    private(set) static var sharedGroupActive = false

    /// Schlüsselbund-Gruppe einrichten — einmal je Prozess, an jedem Einstieg
    /// aufrufbar (App-Start, Hintergrundaufgabe, Kurzbefehl, Widget).
    /// Die App prüft, ob die Signatur die Gruppe erlaubt, und zieht vorhandene
    /// Einträge um; die Erweiterung liest nur.
    static func configure() { _ = configured }

    private static let configured: Void = {
        if isExtension {
            KeyStore.accessGroup = SharedStore.keychainGroup
            sharedGroupActive = SharedStore.keychainGroup != nil
        } else {
            sharedGroupActive = KeyStore.adoptSharedGroup(SharedStore.keychainGroup)
            if sharedGroupActive { KeyStore.migrateToSharedGroup() }
        }
    }()

    /// Zugangsdaten und Geräteschlüssel der gewählten Anlage. Ist die Demo
    /// gewählt, gibt es keine — auch nicht ersatzweise die einer gekoppelten
    /// Anlage: Wer die Demo ansieht, erreicht nie eine echte.
    static func selected() throws -> (credentials: LinkCredentials, signer: LinkSigner) {
        configure()
        if DemoStore.isSelected { throw Failure.demo }
        let systems: [LinkCredentials]
        do {
            systems = try KeyStore.loadSystems()
        } catch LinkError.keychain(let status) where status == errSecInteractionNotAllowed {
            throw Failure.locked
        } catch {
            throw Failure.notShared
        }
        let wanted = SharedStore.selectedSystemId
        guard let creds = systems.first(where: { $0.id == wanted }) ?? systems.first else { throw Failure.noSystem }
        guard let ref = creds.keyRef else { throw Failure.keyUnavailable }
        do {
            return (creds, try KeyStore.loadSigner(ref))
        } catch LinkError.keychain(let status) where status == errSecInteractionNotAllowed {
            throw Failure.locked
        } catch {
            throw Failure.keyUnavailable
        }
    }
}

extension WidgetSnapshot {
    init(_ s: LiveStatus, at: Date, boxName: String, boxId: String?) {
        self.init(boxName: boxName, boxId: boxId, at: at, soc: s.soc, pvW: s.pvTotalW, loadW: s.loadW, gridImportW: s.gridImportW,
                  gridExportW: s.gridExportW, batteryW: s.batteryPowerW, todayNetEur: s.todayNetEur,
                  todayRevenueEur: s.todayRevenueEur, todayCostEur: s.todayCostEur, emergencyStop: s.emergencyStop,
                  alarmsActive: s.alarmsActive)
    }
}

/// Holt einen frischen Stand der gewählten Anlage und legt ihn für Widgets ab.
/// Ist die Demo gewählt, rechnet er den Stand der Beispielanlage — ohne Netz.
enum SnapshotRefresher {
    enum Outcome: Equatable {
        case fresh(WidgetSnapshot)
        /// Kein Abruf möglich; der gespeicherte Stand (falls vorhanden) gilt weiter.
        case unchanged(WidgetSnapshot?, reason: Reason)
    }

    enum Reason: Equatable {
        case noSystem, locked, notShared, keyUnavailable, unreachable, timeout
    }

    /// Ein Abruf mit Gesamtfrist. Schreibt den Stand in die App-Gruppe (nur,
    /// wenn dort kein jüngerer liegt) und liefert ihn zurück. Gleichzeitige
    /// Aufrufe (zwei Widgets, Widget und Kurzbefehl) teilen sich einen Abruf.
    static func refresh(timeout: TimeInterval = 12) async -> Outcome {
        await RefreshGate.shared.run(timeout: timeout)
    }

    /// Der Stand ist so alt, dass sich ein eigener Abruf lohnt. Solange die App
    /// offen ist, schreibt sie alle 30 s — dann ruft sonst niemand ab.
    static func isDue(_ snapshot: WidgetSnapshot?, now: Date = Date(), maxAge: TimeInterval = 600) -> Bool {
        guard let snapshot else { return true }
        return now.timeIntervalSince(snapshot.at) > maxAge
    }

    /// Stand der Demo-Anlage jetzt, für die Widgets abgelegt.
    private static func demo() -> Outcome {
        guard let snap = DemoStore.snapshot() else { return .unchanged(nil, reason: .noSystem) }
        SharedStore.write(snap)
        return .fresh(snap)
    }

    /// Stände, die ein Widget im Voraus zeichnen kann: nur in der Demo (dort
    /// steht der Verlauf fest), für eine gekoppelte Anlage keine.
    static func ahead() -> [WidgetSnapshot] { DemoStore.isSelected ? DemoStore.ahead() : [] }

    fileprivate static func fetch(timeout: TimeInterval) async -> Outcome {
        if DemoStore.isSelected { return demo() }
        let access: (credentials: LinkCredentials, signer: LinkSigner)
        do {
            access = try LinkAccess.selected()
        } catch let f as LinkAccess.Failure {
            switch f {
            case .demo: return demo()
            case .noSystem: return .unchanged(nil, reason: .noSystem)
            case .locked: return .unchanged(SharedStore.read(), reason: .locked)
            case .notShared: return .unchanged(SharedStore.read(), reason: .notShared)
            case .keyUnavailable: return .unchanged(SharedStore.read(), reason: .keyUnavailable)
            }
        } catch {
            return .unchanged(SharedStore.read(), reason: .keyUnavailable)
        }
        let creds = access.credentials
        let signer = SendableSigner(access.signer)
        // Harte Frist: Wer zuerst fertig ist, liefert. Läuft die Frist ab, wird
        // der Abruf abgebrochen und nicht weiter abgewartet (Widgets und
        // Hintergrundaufgaben haben nur wenige Sekunden).
        let result: QuickSnapshot? = await withCheckedContinuation { (cont: CheckedContinuation<QuickSnapshot?, Never>) in
            let done = OSAllocatedUnfairLock(initialState: false)
            @Sendable func finish(_ value: QuickSnapshot?) {
                let first = done.withLock { was -> Bool in
                    defer { was = true }
                    return !was
                }
                if first { cont.resume(returning: value) }
            }
            let work = Task {
                finish(try? await QuickLink.snapshot(credentials: creds, signer: signer.value, lanTimeout: 2, relayTimeout: 6, liveTimeout: 4))
            }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                work.cancel()
                finish(nil)
            }
        }
        guard let result else { return .unchanged(SharedStore.read(), reason: .unreachable) }
        let snap = WidgetSnapshot(result.status, at: result.at, boxName: result.boxName ?? creds.boxName, boxId: creds.id)
        SharedStore.write(snap, onlyIfNewer: true)
        return .fresh(SharedStore.read().flatMap { $0.boxId == snap.boxId ? $0 : nil } ?? snap)
    }
}

/// Der Geräteschlüssel ist ein Wert ohne veränderlichen Zustand (CryptoKit);
/// das Protokoll `LinkSigner` sagt das nur nicht.
struct SendableSigner: @unchecked Sendable {
    let value: LinkSigner
    init(_ value: LinkSigner) { self.value = value }
}

/// Bündelt gleichzeitige Abrufe innerhalb eines Prozesses.
actor RefreshGate {
    static let shared = RefreshGate()
    private var running: Task<SnapshotRefresher.Outcome, Never>?

    func run(timeout: TimeInterval) async -> SnapshotRefresher.Outcome {
        if let running { return await running.value }
        let task = Task { await SnapshotRefresher.fetch(timeout: timeout) }
        running = task
        let result = await task.value
        running = nil
        return result
    }
}
