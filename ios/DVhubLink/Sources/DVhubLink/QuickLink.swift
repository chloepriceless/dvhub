// QuickLink.swift — ein einzelner Abruf ohne Dauer-Verbindung.
//
// Für alles, was nicht die laufende App ist: Hintergrund-Aktualisierung
// (BGAppRefreshTask), Widgets, Kurzbefehle/Siri, Kontrollzentrum. Verbinden
// (Heimnetz zuerst, dann Relay), einen Stand holen bzw. eine Anfrage stellen,
// wieder trennen. Das Relay erlaubt mehrere Verbindungen desselben Geräts
// nebeneinander; eine laufende App wird dadurch nicht getrennt.
//
// Quittiert wird hier nichts: Ereignisse im Briefkasten bleiben für die App.

import Foundation

/// Ein Stand der Anlage aus einem einzelnen Abruf.
public struct QuickSnapshot: Sendable, Equatable {
    public let status: LiveStatus
    public let at: Date
    /// true: frisch von der Box; false: letzter Stand aus dem Briefkasten am Relay.
    public let live: Bool
    public let route: LinkRoute.Kind
    /// Rechte laut Begrüßung der Box (nil, wenn die Box nicht verbunden war).
    public let perms: [String]?
    public let boxName: String?
}

public enum QuickLink {
    /// Über den ersten Weg verbinden, der antwortet.
    public static func connect(
        credentials: LinkCredentials, signer: LinkSigner,
        lanTimeout: TimeInterval = 2.5, relayTimeout: TimeInterval = 8,
        socketFactory: (URL) -> LinkSocket = { URLSessionLinkSocket(url: $0) }
    ) async throws -> DeviceConnection {
        var last: Error = LinkError.boxOffline
        for route in credentials.routes {
            try Task.checkCancellation()
            do {
                return try await DeviceConnection.connect(
                    credentials: credentials, signer: signer, route: route,
                    connectTimeout: route.kind == .lan ? lanTimeout : relayTimeout, socketFactory: socketFactory)
            } catch {
                last = error
                // Entkoppelt oder Ticket ungültig: gilt auf jedem Weg.
                if case .closed(let code, let reason) = error as? LinkError, code == 4002 || reason == "device_not_allowed" { break }
            }
        }
        throw last
    }

    /// Aktueller Stand: live von der Box, sonst der letzte aus dem Briefkasten.
    public static func snapshot(
        credentials: LinkCredentials, signer: LinkSigner,
        lanTimeout: TimeInterval = 2.5, relayTimeout: TimeInterval = 8, liveTimeout: TimeInterval = 6,
        socketFactory: (URL) -> LinkSocket = { URLSessionLinkSocket(url: $0) }
    ) async throws -> QuickSnapshot {
        let conn = try await connect(credentials: credentials, signer: signer, lanTimeout: lanTimeout, relayTimeout: relayTimeout,
                                     socketFactory: socketFactory)
        do {
            let snap = try await snapshot(on: conn, credentials: credentials, liveTimeout: liveTimeout)
            await conn.close()
            return snap
        } catch {
            await conn.close()
            throw error
        }
    }

    /// Stand über eine bestehende Verbindung (schließt sie nicht).
    public static func snapshot(on conn: DeviceConnection, credentials: LinkCredentials, liveTimeout: TimeInterval = 6) async throws -> QuickSnapshot {
        if await conn.isSessionReady {
            let perms = await conn.welcomePerms
            let name = await conn.welcomeBoxName
            try await conn.subscribe(live: true, intervalMs: 5000)
            let first = await firstLive(conn, timeout: liveTimeout)
            try? await conn.subscribe(live: false)
            if let first {
                return QuickSnapshot(status: first.0, at: first.1, live: true, route: conn.route.kind, perms: perms, boxName: name)
            }
        }
        // Box nicht verbunden (oder kein Live-Wert in der Zeit): letzter Stand aus dem Briefkasten.
        var state = MailboxState()
        _ = state.merge(try await conn.fetchMailbox(timeout: 6))
        guard let status = state.latest.flatMap(LiveStatus.from), let at = state.latestAt else { throw LinkError.boxOffline }
        return QuickSnapshot(status: status, at: at, live: false, route: conn.route.kind, perms: nil, boxName: nil)
    }

    /// Eine Anfrage an die Box; danach der frische Stand über dieselbe Verbindung
    /// (nil, wenn er nicht mehr kam). Wirft `boxOffline`, wenn die Box nicht verbunden ist.
    public static func request(
        credentials: LinkCredentials, signer: LinkSigner, method: String, path: String, body: JSONValue? = nil,
        lanTimeout: TimeInterval = 2.5, relayTimeout: TimeInterval = 8, timeout: TimeInterval = 15,
        socketFactory: (URL) -> LinkSocket = { URLSessionLinkSocket(url: $0) }
    ) async throws -> (response: LinkResponse, after: QuickSnapshot?) {
        let conn = try await connect(credentials: credentials, signer: signer, lanTimeout: lanTimeout, relayTimeout: relayTimeout,
                                     socketFactory: socketFactory)
        do {
            guard await conn.isSessionReady else { throw LinkError.boxOffline }
            let response = try await conn.request(method, path, body: body, timeout: timeout)
            let after = try? await snapshot(on: conn, credentials: credentials, liveTimeout: 4)
            await conn.close()
            return (response, after)
        } catch {
            await conn.close()
            throw error
        }
    }

    /// Erster Live-Wert der Verbindung, höchstens `timeout` Sekunden warten.
    static func firstLive(_ conn: DeviceConnection, timeout: TimeInterval) async -> (LiveStatus, Date)? {
        await withTaskGroup(of: (LiveStatus, Date)?.self) { group in
            group.addTask {
                for await ev in conn.events {
                    switch ev {
                    case .live(let status, let ts):
                        if let s = LiveStatus.from(status) { return (s, parseISODate(ts) ?? Date()) }
                    case .closed, .boxOffline:
                        return nil
                    default:
                        continue
                    }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}

// MARK: - Antwort auf einen Schaltbefehl

/// Was eine Antwort auf „Not-Halt auslösen/aufheben“ bedeutet — dieselbe
/// Auswertung für die App, Kurzbefehle und das Kontrollzentrum.
public enum ControlOutcome: Equatable, Sendable {
    case done
    /// Not-Halt greift, aber der Wechselrichter ließ sich nicht auf 0 W setzen.
    case stoppedButNotNeutralized(reason: String?)
    case boxError(String?)
    case notAllowed
    case busy
    case rejected(status: Int)

    public static func from(_ r: LinkResponse) -> ControlOutcome {
        switch r.status {
        case 200:
            if r.body["ok"]?.bool == false { return .boxError(r.body["error"]?.string) }
            if let n = r.body["neutralize"], !n.isNull, n["ok"]?.bool != true, n["skipped"]?.bool != true {
                return .stoppedButNotNeutralized(reason: n["error"]?.string)
            }
            return .done
        case 403: return .notAllowed
        case 429: return .busy
        default: return .rejected(status: r.status)
        }
    }

    /// Die Schaltung hat gegriffen (auch wenn eine Warnung dabei ist).
    public var applied: Bool {
        switch self {
        case .done, .stoppedButNotNeutralized: return true
        default: return false
        }
    }

    public var message: String {
        switch self {
        case .done: return L("Erledigt.")
        case .stoppedButNotNeutralized(let reason):
            let why = reason.map { " (\($0))" } ?? ""
            return L("Not-Halt ist aktiv, aber der Wechselrichter konnte nicht auf 0 W gesetzt werden\(why). Der letzte Sollwert kann noch wirken — bitte an der Anlage prüfen.")
        case .boxError(let e):
            let text = e ?? L("unbekannt")
            return L("Die Anlage meldet einen Fehler: \(text).")
        case .notAllowed: return L("Dieses Gerät darf nicht steuern. In DVhub unter „Handy-App“ freigeben.")
        case .busy: return L("Gerade zu viele Anfragen. Bitte gleich noch einmal.")
        case .rejected(let status): return L("Die Anlage hat abgelehnt (HTTP \(String(status))).")
        }
    }
}
