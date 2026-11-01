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
    /// Aus dem Briefkasten übernommen (letzter Stand, Meldungen) — gespeichert,
    /// damit nach dem Quittieren nichts verloren geht.
    private(set) var mailbox: MailboxState
    private(set) var boxVersion: String?
    var mailboxStatus: LiveStatus? { mailbox.latest.flatMap(LiveStatus.from) }
    var mailboxAt: Date? { mailbox.latestAt }
    var events: [MailboxEvent] { mailbox.events }
    var perms: [String] { credentials.perms }

    var onCredentialsChanged: ((LinkCredentials) -> Void)?

    private var connection: DeviceConnection?
    private var loop: Task<Void, Never>?
    /// Fertige Heimnetz-Verbindung, die die Relay-Verbindung ablösen soll.
    private var pendingUpgrade: DeviceConnection?
    static let lanProbeSeconds: UInt64 = 30

    init(credentials: LinkCredentials) {
        self.credentials = credentials
        self.mailbox = Self.loadMailboxState(credentials.id)
    }

    private static func mailboxKey(_ boxId: String) -> String { "mailbox.\(boxId)" }

    private static func loadMailboxState(_ boxId: String) -> MailboxState {
        guard let data = UserDefaults.standard.data(forKey: mailboxKey(boxId)),
              let st = try? JSONDecoder().decode(MailboxState.self, from: data) else { return MailboxState() }
        return st
    }

    private func saveMailboxState() -> Bool {
        guard let data = try? JSONEncoder().encode(mailbox) else { return false }
        UserDefaults.standard.set(data, forKey: Self.mailboxKey(credentials.id))
        return true
    }

    /// Beim Entfernen der Anlage auch die gespeicherten Meldungen löschen.
    static func forgetMailbox(_ boxId: String) {
        UserDefaults.standard.removeObject(forKey: mailboxKey(boxId))
    }

    var canControl: Bool { perms.contains("control") }
    var isOnline: Bool { if case .online = state { return true }; return false }
    /// Immer der neueste Stand — Live-Wert oder Briefkasten, je nachdem, was
    /// jünger ist (nach einem Abbruch nicht auf den älteren Briefkasten zurück).
    private var preferLive: Bool {
        guard live != nil else { return false }
        guard mailboxStatus != nil, let m = mailboxAt else { return true }
        guard let l = liveAt else { return false }
        return l >= m
    }
    var displayStatus: LiveStatus? { preferLive ? live : (mailboxStatus ?? live) }
    var displayAt: Date? { preferLive ? liveAt : (mailboxAt ?? liveAt) }

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

    private func signer() throws -> LinkSigner {
        guard let ref = credentials.keyRef else { throw LinkError.keychain(-25300) }
        return try KeyStore.loadSigner(ref)
    }

    private func run() async {
        var backoff = ReconnectBackoff()
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
                        lastError = userMessage(for: error)
                        // In DVhub entkoppelt oder Ticket ungültig: gilt auf jedem Weg.
                        // (box_not_allowed im Heimnetz heißt nur: unter dieser Adresse
                        // antwortet eine andere Box — dann weiter zum Relay.)
                        if case .closed(let code, let reason) = error as? LinkError,
                           code == 4002 || reason == "device_not_allowed" { break }
                    }
                }
            } catch {
                lastError = userMessage(for: error)
            }
            guard let conn else {
                // Inzwischen gestoppt (Hintergrund, Anlagenwechsel): nichts mehr
                // melden — sonst überschreibt ein später Fehlschlag den Zustand
                // einer neuen, funktionierenden Verbindung (Codex R7).
                if Task.isCancelled { return }
                state = .offline(lastError)
                try? await Task.sleep(nanoseconds: backoff.afterFailure() * 1_000_000_000)
                continue
            }
            // Während des Verbindungsaufbaus gestoppt (Hintergrund, Anlagenwechsel):
            // die fertige Verbindung nicht liegen lassen, sondern schließen.
            if Task.isCancelled { await conn.close(); return }
            connection = conn
            let started = Date()
            await serve(conn)
            // Immer schließen — auch wenn der Ereignisstrom von selbst endete.
            await conn.close()
            if connection === conn { connection = nil }
            if Task.isCancelled { return }
            // Kurz nach dem Aufbau wieder weg → wachsender Abstand, nicht im Sekundentakt.
            let wait = pendingUpgrade != nil ? 0 : backoff.afterConnection(lasted: Date().timeIntervalSince(started))
            if wait > 0 { try? await Task.sleep(nanoseconds: wait * 1_000_000_000) }
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
            case .connected(let welcome, _):
                boxVersion = welcome["box"]?["version"]?.string
                var updated = credentials
                if updated.apply(welcome: welcome) {
                    credentials = updated
                    onCredentialsChanged?(credentials)
                }
                await sessionReady(conn, kind: kind)
            case .live(let status, let ts):
                if let s = LiveStatus.from(status) {
                    live = s
                    liveAt = parseISODate(ts) ?? Date()
                }
            case .boxOffline:
                state = .boxOffline(kind)
                await loadMailbox(conn)
            case .message(let m):
                // Die Box hat ihre Relay-Adresse geändert (oder das Relay
                // ausgeschaltet): übernehmen, bevor sie die alte Verbindung trennt.
                if m["t"]?.string == "relay" {
                    var updated = credentials
                    if updated.apply(welcome: ["relay": m["relay"] ?? .null]) {
                        credentials = updated
                        onCredentialsChanged?(credentials)
                    }
                }
            case .closed(let err):
                if let err, !Task.isCancelled { state = .offline(userMessage(for: err)) }
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
        try? await conn.subscribe(live: true, intervalMs: 2000)
        await loadMailbox(conn)
    }

    private func loadMailbox(_ conn: DeviceConnection) async {
        guard let items = try? await conn.fetchMailbox() else { return }
        var next = mailbox
        let ack = next.merge(items)
        let changed = next != mailbox
        if changed { mailbox = next }
        // Jeden geänderten Stand speichern — auch einen reinen `latest` ohne
        // Ereignisse, damit er einen Neustart ohne Verbindung übersteht (Codex R4).
        let saved = changed ? saveMailboxState() : true
        // Erst quittieren, wenn übernommen und gespeichert ist.
        guard !ack.isEmpty, saved else { return }
        try? await conn.ackMailbox(ack)
    }

    /// Anfrage an die Box (nur bei bestehender Sitzung).
    func request(_ method: String, _ path: String, body: JSONValue? = nil) async throws -> LinkResponse {
        guard let connection, isOnline else { throw LinkError.boxOffline }
        return try await connection.request(method, path, body: body)
    }
}
