// DeviceConnection.swift — Verbindung eines gekoppelten Geräts zur Box.
//
// Ablauf wie dvhub/services/mobile-link/client.js: Relay-Anmeldung mit Ticket
// und Gerätesignatur, Handshake hs1/hs2/hs3, danach verschlüsselte Nachrichten.
// Ist die Box beim Verbinden nicht da, bleibt die Verbindung offen (Briefkasten
// abholbar); meldet das Relay `box_online`, folgt der Handshake automatisch.

import Foundation

public struct LinkResponse: Sendable {
    public let status: Int
    public let body: JSONValue
}

public struct MailboxItem: Sendable {
    public let id: String
    public let slot: String?
    public let ts: Date
    public let message: JSONValue
}

public enum LinkEvent: Sendable {
    /// Sitzung steht (Begrüßung der Box). `ticket` ist neu ausgestellt → speichern.
    case connected(welcome: JSONValue, ticket: JSONValue?)
    case live(status: JSONValue, ts: String?)
    case boxOffline
    case message(JSONValue)
    case closed(LinkError?)
}

public actor DeviceConnection {
    public nonisolated let events: AsyncStream<LinkEvent>
    public nonisolated let route: LinkRoute
    private let eventSink: AsyncStream<LinkEvent>.Continuation
    private let channel: RelayChannel
    private let signer: LinkSigner
    private let boxPublicRaw: Data
    private var credentials: LinkCredentials
    private var handshake: DeviceHandshake?
    private var session: LinkSession?
    private var welcome: JSONValue?
    private var readyWaiter: CheckedContinuation<JSONValue, Error>?
    /// Nummer des aktuellen Wartenden — ein abgelaufener Timer eines ersetzten
    /// Handshakes bzw. Briefkasten-Abrufs trifft so nie den neuen (Codex R6).
    private var readyGen = 0
    private var mailboxGen = 0
    private var pending: [String: CheckedContinuation<LinkResponse, Error>] = [:]
    private var mailboxWaiter: CheckedContinuation<JSONValue, Error>?
    private var nextId = 1
    private var receiveTask: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?
    private var isClosed = false
    /// Ausgangs-Warteschlange: Versiegeln und Einreihen geschehen ohne
    /// Unterbrechung im Actor, ein einziger Sender arbeitet sie in Reihenfolge
    /// ab. So gehen die Rahmen genau in Zähler-Reihenfolge raus — egal, mit
    /// welcher Priorität die Aufrufer laufen (Fable-Review H1).
    private var outbox: [String] = []
    private var draining = false

    public var isSessionReady: Bool { session != nil && welcome != nil }
    public var currentCredentials: LinkCredentials { credentials }
    public var perms: [String] { (welcome?["perms"]?.array ?? []).compactMap { $0.string } }
    /// Rechte laut Begrüßung; nil, wenn die Box das Feld nicht mitschickt.
    public var welcomePerms: [String]? { welcome?["perms"]?.array?.compactMap { $0.string } }

    init(channel: RelayChannel, route: LinkRoute, credentials: LinkCredentials, signer: LinkSigner) throws {
        self.channel = channel
        self.route = route
        self.credentials = credentials
        self.signer = signer
        self.boxPublicRaw = try Base64URL.decode(credentials.boxPub, length: 65)
        var sink: AsyncStream<LinkEvent>.Continuation!
        self.events = AsyncStream(bufferingPolicy: .bufferingNewest(64)) { sink = $0 }
        self.eventSink = sink
    }

    /// Verbinden über genau einen Weg. Wirft, wenn die Anmeldung scheitert.
    /// `boxOnline == false` → Verbindung steht, aber noch ohne Sitzung.
    public static func connect(
        credentials: LinkCredentials,
        signer: LinkSigner,
        route: LinkRoute,
        connectTimeout: TimeInterval = 5,
        socketFactory: (URL) -> LinkSocket = { URLSessionLinkSocket(url: $0) }
    ) async throws -> DeviceConnection {
        let ch = RelayChannel(socket: socketFactory(route.url))
        do {
            let challenge = try await ch.next(type: "challenge", timeout: connectTimeout)
            guard let n = challenge["n"]?.string else { throw LinkError.protocolError("challenge") }
            let sig = try signer.sign(try relayAuthData(role: "device", challenge: n))
            try await ch.send([
                "t": "auth", "role": "device", "ticket": credentials.ticket,
                "pub": .string(Base64URL.encode(signer.publicRaw)), "sig": .string(Base64URL.encode(sig)),
            ])
            let ok = try await ch.next(type: "ok", timeout: 10)
            let boxOnline = ok["boxOnline"]?.bool == true
            // Im Heimnetz hängt die Box immer am eingebetteten Relay. Fehlt sie,
            // antwortet dort etwas anderes → Fehlschlag, nächster Weg (Review N2).
            if route.kind == .lan && !boxOnline { throw LinkError.boxOffline }
            let conn = try DeviceConnection(channel: ch, route: route, credentials: credentials, signer: signer)
            await conn.startLoops()
            if boxOnline {
                do {
                    _ = try await conn.startHandshake()
                } catch {
                    await conn.close()
                    throw error
                }
            }
            return conn
        } catch {
            ch.close()
            throw error
        }
    }

    private func startLoops() {
        let sock = channel.socket
        receiveTask = Task { [weak self] in
            while true {
                let text: String
                do {
                    text = try await sock.receive()
                } catch {
                    await self?.finish(error as? LinkError ?? .closed(code: 1006, reason: ""))
                    return
                }
                guard let msg = try? JSONValue.decode(Data(text.utf8)) else { continue }
                await self?.handle(msg)
            }
        }
        keepAliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard let self else { return }
                try? await self.enqueuePing()
            }
        }
    }

    /// Nachricht einreihen (synchron, im Actor). Alles, was rausgeht, läuft
    /// hierüber — auch Relay-Nachrichten, damit die Reihenfolge insgesamt stimmt.
    private func enqueue(_ v: JSONValue) throws {
        guard !isClosed else { throw LinkError.closed(code: 1000, reason: "") }
        guard let text = String(data: try v.encoded(), encoding: .utf8) else { throw LinkError.protocolError("encode") }
        outbox.append(text)
        guard !draining else { return }
        draining = true
        Task { await self.drain() }
    }

    /// Verschlüsselt senden: Versiegeln (Zähler++) und Einreihen ohne Unterbrechung.
    private func enqueueSealed(_ v: JSONValue) throws {
        guard let session else { throw LinkError.boxOffline }
        try enqueue(["t": "data", "d": .string(try session.seal(v))])
    }

    private func drain() async {
        let sock = channel.socket
        while !outbox.isEmpty && !isClosed {
            let text = outbox.removeFirst()
            do {
                try await sock.send(text)
            } catch {
                finish(error as? LinkError ?? .closed(code: 1006, reason: ""))
                break
            }
        }
        draining = false
    }

    private func enqueuePing() throws { try enqueue(["t": "ping"]) }

    /// Handshake starten (beim Verbinden und wenn die Box wieder da ist).
    @discardableResult
    func startHandshake(timeout: TimeInterval = 15) async throws -> JSONValue {
        session = nil
        welcome = nil
        let hs = try DeviceHandshake(boxPublicRaw: boxPublicRaw, signer: signer)
        handshake = hs
        let hello: JSONValue = ["t": "data", "d": .string(Base64URL.encode(try hs.hello().encoded()))]
        readyGen += 1
        let gen = readyGen
        let timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) } catch { return }
            await self?.failReady(LinkError.timeout, gen: gen)
        }
        defer { timer.cancel() }
        // Erst warten, dann senden — sonst könnte die Begrüßung vor dem Warten ankommen.
        return try await withCheckedThrowingContinuation { cont in
            if let old = readyWaiter { old.resume(throwing: LinkError.handshake("superseded")) }
            readyWaiter = cont
            do { try enqueue(hello) } catch { failReady(error) }
        }
    }

    private func failReady(_ e: Error, gen: Int? = nil) {
        if let gen, gen != readyGen { return }
        readyWaiter?.resume(throwing: e)
        readyWaiter = nil
    }

    private func handle(_ m: JSONValue) async {
        switch m["t"]?.string {
        case "mbox":
            mailboxWaiter?.resume(returning: m)
            mailboxWaiter = nil
        case "box_offline":
            session = nil
            welcome = nil
            handshake = nil
            // Wartet ein connect()/Handshake, sofort beenden statt Zeitüberschreitung (Review N4).
            failReady(LinkError.boxOffline)
            failPending(LinkError.boxOffline)
            eventSink.yield(.boxOffline)
        case "box_online":
            Task { try? await self.startHandshake() }
        case "error":
            if m["e"]?.string == "box_offline" {
                failReady(LinkError.boxOffline)
                failPending(LinkError.boxOffline)
            }
        case "data":
            guard let d = m["d"]?.string else { return }
            do {
                if let hs = handshake {
                    let r = try hs.onHs2(try JSONValue.decode(try Base64URL.decode(d)))
                    handshake = nil
                    session = r.session
                    try enqueue(["t": "data", "d": .string(Base64URL.encode(try r.hs3.encoded()))])
                    return
                }
                guard let session else { return }
                let msg = try session.open(d)
                if welcome == nil {
                    guard msg["t"]?.string == "welcome" else { throw LinkError.protocolError("welcome_expected") }
                    welcome = msg
                    let ticket = msg["ticket"]
                    if let ticket, !ticket.isNull { credentials.ticket = ticket }
                    readyWaiter?.resume(returning: msg)
                    readyWaiter = nil
                    eventSink.yield(.connected(welcome: msg, ticket: ticket))
                    return
                }
                switch msg["t"]?.string {
                case "res":
                    let id = msg["id"]?.string ?? ""
                    if let p = pending.removeValue(forKey: id) {
                        p.resume(returning: LinkResponse(status: Int(msg["s"]?.int ?? 0), body: msg["b"] ?? .null))
                    }
                case "live":
                    eventSink.yield(.live(status: msg["status"] ?? .null, ts: msg["ts"]?.string))
                default:
                    eventSink.yield(.message(msg))
                }
            } catch {
                // Entschlüsselung/Protokoll kaputt: Verbindung aufgeben, App verbindet neu.
                failReady(error)
                finish(error as? LinkError ?? .protocolError("\(error)"))
            }
        default:
            break
        }
    }

    private func failPending(_ e: Error) {
        for (_, p) in pending { p.resume(throwing: e) }
        pending.removeAll()
    }

    private func finish(_ error: LinkError?) {
        guard !isClosed else { return }
        isClosed = true
        session = nil
        failReady(error ?? LinkError.closed(code: 1000, reason: ""))
        failPending(error ?? LinkError.closed(code: 1000, reason: ""))
        mailboxWaiter?.resume(throwing: error ?? LinkError.closed(code: 1000, reason: ""))
        mailboxWaiter = nil
        keepAliveTask?.cancel()
        outbox.removeAll()
        eventSink.yield(.closed(error))
        eventSink.finish()
        // Auch bei Schließen durch die Gegenstelle die eigene Seite zumachen
        // (URLSession invalidieren), sonst bleiben Sitzungen liegen (Review M4b).
        receiveTask?.cancel()
        channel.close()
    }

    // MARK: - Öffentliche Aufrufe

    public func request(_ method: String, _ path: String, body: JSONValue? = nil, timeout: TimeInterval = 20) async throws -> LinkResponse {
        guard session != nil, welcome != nil else { throw LinkError.boxOffline }
        let id = String(nextId)
        nextId += 1
        var msg: [String: JSONValue] = ["t": "req", "id": .string(id), "m": .string(method), "p": .string(path)]
        if let body { msg["b"] = body }
        let timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) } catch { return }
            await self?.timeoutRequest(id)
        }
        defer { timer.cancel() }
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            do { try enqueueSealed(.object(msg)) } catch { timeoutRequest(id, error) }
        }
    }

    private func timeoutRequest(_ id: String, _ error: Error = LinkError.timeout) {
        pending.removeValue(forKey: id)?.resume(throwing: error)
    }

    public func subscribe(live: Bool, intervalMs: Int = 2000) async throws {
        try enqueueSealed(["t": "sub", "live": .bool(live), "intervalMs": .int(Int64(intervalMs))])
    }

    /// Briefkasten am Relay: letzter Stand und Ereignisse, entschlüsselt.
    public func fetchMailbox(timeout: TimeInterval = 10) async throws -> [MailboxItem] {
        mailboxGen += 1
        let gen = mailboxGen
        let timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) } catch { return }
            await self?.failMailbox(LinkError.timeout, gen: gen)
        }
        defer { timer.cancel() }
        let res: JSONValue = try await withCheckedThrowingContinuation { cont in
            if let old = mailboxWaiter { old.resume(throwing: LinkError.protocolError("superseded")) }
            mailboxWaiter = cont
            do { try enqueue(["t": "mbox_get"]) } catch { failMailbox(error) }
        }
        let key = try Base64URL.decode(credentials.mailboxKey, length: 32)
        return (res["items"]?.array ?? []).compactMap { it in
            guard let id = it["id"]?.string, let d = it["d"]?.string,
                  let msg = try? openMailbox(key: key, devId: credentials.devId, d: d) else { return nil }
            let ts = Date(timeIntervalSince1970: (it["ts"]?.double ?? 0) / 1000)
            return MailboxItem(id: id, slot: it["slot"]?.string, ts: ts, message: msg)
        }
    }

    private func failMailbox(_ e: Error, gen: Int? = nil) {
        if let gen, gen != mailboxGen { return }
        mailboxWaiter?.resume(throwing: e)
        mailboxWaiter = nil
    }

    public func ackMailbox(_ ids: [String]) async throws {
        try enqueue(["t": "mbox_ack", "ids": .array(ids.map { .string($0) })])
    }

    public func close() {
        finish(nil)
        receiveTask?.cancel()
        channel.close()
    }
}
