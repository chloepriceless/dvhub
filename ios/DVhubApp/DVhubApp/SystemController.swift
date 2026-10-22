// SystemController.swift — hält die Verbindung zu einer Anlage.
//
// Zuerst die Heimnetz-Adressen (kurzer Timeout), dann das Relay; nach einem
// Abbruch automatisch neu verbinden. Die Verbindung lebt hier und nicht in den
// Ansichten — Auf-/Zuklappen des iPhone Duo, Drehen oder Größenwechsel bauen
// nur die Oberfläche neu, nicht die Verbindung.

import Foundation
import Observation
import DVhubLink

@MainActor
@Observable
final class SystemController {
    enum State: Equatable {
        case idle
        case connecting
        case online(LinkRoute.Kind)
        case boxOffline(LinkRoute.Kind)
        case offline(String)
    }

    private(set) var credentials: LinkCredentials
    private(set) var state: State = .idle
    private(set) var live: LiveStatus?
    private(set) var liveAt: Date?
    /// Letzter Stand aus dem Briefkasten, wenn die Box nicht erreichbar ist.
    private(set) var mailboxStatus: LiveStatus?
    private(set) var mailboxAt: Date?
    private(set) var events: [MailboxItem] = []
    private(set) var perms: [String]
    private(set) var boxVersion: String?

    var onCredentialsChanged: ((LinkCredentials) -> Void)?

    private var connection: DeviceConnection?
    private var loop: Task<Void, Never>?
    /// Fertige Heimnetz-Verbindung, die die Relay-Verbindung ablösen soll.
    private var pendingUpgrade: DeviceConnection?
    static let lanProbeSeconds: UInt64 = 30

    init(credentials: LinkCredentials) {
        self.credentials = credentials
        self.perms = credentials.perms
    }

    var canControl: Bool { perms.contains("control") }
    var isOnline: Bool { if case .online = state { return true }; return false }
    var displayStatus: LiveStatus? { isOnline ? (live ?? mailboxStatus) : (mailboxStatus ?? live) }
    var displayAt: Date? { isOnline ? (liveAt ?? mailboxAt) : (mailboxAt ?? liveAt) }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in await self?.run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        let up = pendingUpgrade
        pendingUpgrade = nil
        Task { await up?.close() }
        let c = connection
        connection = nil
        Task { await c?.close() }
        if case .online = state { state = .idle }
    }

    /// Verständliche Meldung statt Schließcode.
    static func explain(_ error: Error) -> String {
        guard let e = error as? LinkError else { return error.localizedDescription }
        switch e {
        case .closed(let code, let reason):
            switch (code, reason) {
            case (_, "device_not_allowed"): return "Dieses Gerät wurde in DVhub entkoppelt. Bitte neu koppeln."
            case (4002, _): return "Anmeldung abgelehnt. Bitte neu koppeln."
            case (_, "box_not_allowed"): return "Unter der gespeicherten Adresse antwortet eine andere Anlage."
            case (_, "mobile_link_disabled"): return "Die Handy-App ist in DVhub ausgeschaltet."
            case (4008, _): return "Das Relay hat die Verbindung begrenzt. Gleich erneut."
            case (4011, _): return "Das Relay startet neu."
            default: return e.description
            }
        case .timeout: return "Keine Antwort (Zeitüberschreitung)."
        default: return e.description
        }
    }

    private func signer() throws -> LinkSigner {
        guard let ref = credentials.keyRef else { throw LinkError.keychain(-25300) }
        return try KeyStore.loadSigner(ref)
    }

    private func run() async {
        var backoff: UInt64 = 1
        while !Task.isCancelled {
            state = .connecting
            var conn: DeviceConnection?
            var lastError = "Keine Verbindung"
            do {
                let s = try signer()
                if let up = pendingUpgrade {
                    pendingUpgrade = nil
                    conn = up
                }
                for route in credentials.routes where conn == nil {
                    if Task.isCancelled { return }
                    do {
                        conn = try await DeviceConnection.connect(
                            credentials: credentials, signer: s, route: route,
                            connectTimeout: route.kind == .lan ? 2.5 : 8
                        )
                        break
                    } catch {
                        lastError = Self.explain(error)
                        // In DVhub entkoppelt oder Ticket ungültig: gilt auf jedem Weg.
                        // (box_not_allowed im Heimnetz heißt nur: unter dieser Adresse
                        // antwortet eine andere Box — dann weiter zum Relay.)
                        if case .closed(let code, let reason) = error as? LinkError,
                           code == 4002 || reason == "device_not_allowed" { break }
                    }
                }
            } catch {
                lastError = Self.explain(error)
            }
            guard let conn else {
                state = .offline(lastError)
                try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                backoff = min(backoff * 2, 30)
                continue
            }
            backoff = 1
            connection = conn
            await serve(conn)
            connection = nil
            if Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    private func serve(_ conn: DeviceConnection) async {
        let kind = conn.route.kind
        // Steht die Sitzung schon, liegt das Ereignis `.connected` im Puffer
        // und richtet sie unten ein.
        if await !conn.isSessionReady {
            state = .boxOffline(kind)
            await loadMailbox(conn)
        }
        // Über das Relay verbunden: regelmäßig prüfen, ob das Heimnetz wieder
        // geht, und dann wechseln (schneller, ohne Umweg über das Internet).
        let probe: Task<Void, Never>? = kind == .relay ? Task { [weak self] in await self?.probeLan(replacing: conn) } : nil
        defer { probe?.cancel() }
        for await ev in conn.events {
            switch ev {
            case .connected(let welcome, let ticket):
                updateFromWelcome(welcome, ticket: ticket)
                await sessionReady(conn, kind: kind)
            case .live(let status, let ts):
                if let s = LiveStatus.from(status) {
                    live = s
                    liveAt = ISO.parse(ts) ?? Date()
                }
            case .boxOffline:
                state = .boxOffline(kind)
                await loadMailbox(conn)
            case .message:
                break
            case .closed(let err):
                if let err { state = .offline(Self.explain(err)) }
                return
            }
        }
    }

    private func probeLan(replacing current: DeviceConnection) async {
        let lanRoutes = credentials.routes.filter { $0.kind == .lan }
        guard !lanRoutes.isEmpty else { return }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: Self.lanProbeSeconds * 1_000_000_000)
            if Task.isCancelled { return }
            guard let s = try? signer() else { return }
            for route in lanRoutes {
                guard let c = try? await DeviceConnection.connect(credentials: credentials, signer: s, route: route, connectTimeout: 2.5) else { continue }
                if Task.isCancelled { await c.close(); return }
                if await c.isSessionReady {
                    pendingUpgrade = c
                    await current.close()
                    return
                }
                await c.close()
            }
        }
    }

    private func sessionReady(_ conn: DeviceConnection, kind: LinkRoute.Kind) async {
        state = .online(kind)
        let p = await conn.perms
        if !p.isEmpty { perms = p }
        let updated = await conn.currentCredentials
        if updated.ticket != credentials.ticket {
            credentials.ticket = updated.ticket
            onCredentialsChanged?(credentials)
        }
        try? await conn.subscribe(live: true, intervalMs: 2000)
        await loadMailbox(conn)
    }

    private func updateFromWelcome(_ welcome: JSONValue, ticket: JSONValue?) {
        boxVersion = welcome["box"]?["version"]?.string
        if let name = welcome["box"]?["name"]?.string, name != credentials.boxName {
            credentials.boxName = name
            onCredentialsChanged?(credentials)
        }
    }

    private func loadMailbox(_ conn: DeviceConnection) async {
        guard let items = try? await conn.fetchMailbox() else { return }
        if let latest = items.first(where: { $0.slot == "latest" }), let s = LiveStatus.from(latest.message["status"] ?? .null) {
            mailboxStatus = s
            mailboxAt = ISO.parse(latest.message["ts"]?.string) ?? latest.ts
        }
        let newEvents = items.filter { $0.slot == nil }
        if !newEvents.isEmpty {
            events = (newEvents + events).prefix(50).map { $0 }
            try? await conn.ackMailbox(newEvents.map(\.id))
        }
    }

    /// Anfrage an die Box (nur bei bestehender Sitzung).
    func request(_ method: String, _ path: String, body: JSONValue? = nil) async throws -> LinkResponse {
        guard let connection, isOnline else { throw LinkError.boxOffline }
        return try await connection.request(method, path, body: body)
    }
}
