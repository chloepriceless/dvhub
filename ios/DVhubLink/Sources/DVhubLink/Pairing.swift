// Pairing.swift — QR-Inhalt lesen, Zugangsdaten, Kopplung.

import Foundation

public let pairPrefix = "dvhub://pair?"
public let lanPath = "/api/mobile-link/ws"

/// Inhalt des Kopplungs-QR-Codes (dvhub/services/mobile-link/qr.js):
/// `dvhub://pair?v=1&b=<Box-Schlüssel>&s=<Geheimnis>&e=<Ablauf>&n=<Name>&l=<host:port,…>&r=<Relay-URL>`
/// in URLSearchParams-Kodierung (`+` = Leerzeichen, %-Kodierung). `l` und `r` können fehlen.
public struct PairPayload: Equatable {
    public let boxPublicRaw: Data
    public let secret: Data
    public let name: String
    public let lan: [String]
    public let relay: String?
    public let expires: Date

    public var boxId: String { keyId(boxPublicRaw) }

    /// Wie URLSearchParams: Paare an `&`, Schlüssel/Wert am ersten `=`, `+` → Leerzeichen.
    static func searchParams(_ query: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in query.split(separator: "&", omittingEmptySubsequences: true) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            func dec(_ s: Substring) -> String {
                let plus = s.replacingOccurrences(of: "+", with: " ")
                return plus.removingPercentEncoding ?? plus
            }
            let key = dec(parts[0])
            if out[key] == nil { out[key] = parts.count > 1 ? dec(parts[1]) : "" }  // erster Wert gilt (URLSearchParams.get)
        }
        return out
    }

    static func validHost(_ h: String) -> Bool {
        guard (1...255).contains(h.utf8.count) else { return false }
        return h.utf8.allSatisfy { c in
            (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39)
                || c == 0x2E || c == 0x2D || c == 0x5B || c == 0x5D || c == 0x3A
        }
    }

    public init(_ text: String) throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(pairPrefix) else { throw LinkError.notAPairingCode }
        let q = Self.searchParams(String(trimmed.dropFirst(pairPrefix.count)))
        guard q["v"] == String(protocolVersion) else { throw LinkError.versionUnsupported }
        boxPublicRaw = try Base64URL.decode(q["b"] ?? "", length: 65)
        secret = try Base64URL.decode(q["s"] ?? "", length: 32)
        name = q["n"] ?? ""
        lan = (q["l"] ?? "").split(separator: ",").map(String.init).filter(Self.validHost).map { "ws://\($0)\(lanPath)" }
        if let r = q["r"], r.hasPrefix("ws://") || r.hasPrefix("wss://") { relay = r } else { relay = nil }
        expires = Date(timeIntervalSince1970: Double(q["e"] ?? "") ?? 0)
    }
}

/// Dauerhafte Zugangsdaten zu einer Anlage (im Schlüsselbund gespeichert).
public struct LinkCredentials: Codable, Equatable, Identifiable {
    public var v: Int = 1
    public var boxPub: String
    public var boxId: String
    public var boxName: String
    public var devId: String
    public var name: String
    public var perms: [String]
    public var ticket: JSONValue
    public var mailboxKey: String
    public var relay: String?
    public var lan: [String]
    /// Verweis auf den Geräteschlüssel im Schlüsselbund.
    public var keyRef: String?

    public var id: String { boxId }
    public var canControl: Bool { perms.contains("control") }

    /// Wege in der Reihenfolge: Heimnetz zuerst, dann Relay.
    public var routes: [LinkRoute] {
        lan.compactMap { URL(string: $0) }.map { LinkRoute(url: $0, kind: .lan) }
            + (relay.flatMap(URL.init(string:)).map { [LinkRoute(url: $0, kind: .relay)] } ?? [])
    }
}

public struct LinkRoute: Equatable, Sendable {
    public enum Kind: String, Sendable { case lan, relay }
    public let url: URL
    public let kind: Kind
}

/// Koppeln: verbindet sich mit dem QR-Geheimnis, wartet auf die Freigabe in
/// DVhub und liefert die Zugangsdaten. `onWait` meldet „wartet auf Freigabe“.
public func pairDevice(
    qr: String,
    signer: LinkSigner,
    name: String,
    model: String,
    url: URL? = nil,
    connectTimeout: TimeInterval = 4,
    waitTimeout: TimeInterval = 300,
    socketFactory: @escaping (URL) -> LinkSocket = { URLSessionLinkSocket(url: $0) },
    onWait: ((_ code: String) -> Void)? = nil
) async throws -> LinkCredentials {
    let p = try PairPayload(qr)
    var candidates: [URL] = []
    if let url { candidates = [url] } else {
        candidates = p.lan.compactMap(URL.init(string:)) + (p.relay.flatMap(URL.init(string:)).map { [$0] } ?? [])
    }
    guard !candidates.isEmpty else { throw LinkError.noRoute }
    let token = Base64URL.encode(pairRelayToken(secret: p.secret))

    var lastError: Error = LinkError.noRoute
    for target in candidates {
        let ch = RelayChannel(socket: socketFactory(target))
        do {
            let challenge = try await ch.next(type: "challenge", timeout: connectTimeout)
            _ = challenge
            try await ch.send(["t": "auth", "role": "pair", "box": .string(p.boxId), "token": .string(token)])
            _ = try await ch.next(type: "ok", timeout: 10)
        } catch {
            lastError = error
            ch.close()
            continue
        }
        defer { ch.close() }
        let hs = try PairHandshake(boxPublicRaw: p.boxPublicRaw, secret: p.secret, signer: signer)
        try await ch.send(["t": "data", "d": .string(Base64URL.encode(try hs.hello().encoded()))])
        let p2msg = try await ch.next(type: "data", timeout: 15)
        guard let p2d = p2msg["d"]?.string else { throw LinkError.protocolError("p2") }
        let (session, p3, _, code) = try hs.onP2(try JSONValue.decode(try Base64URL.decode(p2d)), name: name, model: model)
        try await ch.send(["t": "data", "d": .string(try session.seal(p3))])
        let deadline = Date().addingTimeInterval(waitTimeout)
        while true {
            let left = deadline.timeIntervalSinceNow
            guard left > 0 else { throw LinkError.timeout }
            let m = try await ch.next(type: "data", timeout: left)
            guard let d = m["d"]?.string else { continue }
            let msg = try session.open(d)
            switch msg["t"]?.string {
            case "p_wait": onWait?(code)
            case "p_denied": throw LinkError.pairingDenied
            case "p_ok":
                guard let dev = msg["dev"]?.string, let ticket = msg["ticket"], let mk = msg["mailboxKey"]?.string else {
                    throw LinkError.protocolError("p_ok")
                }
                guard dev == signer.id else { throw LinkError.protocolError("dev_mismatch") }
                return LinkCredentials(
                    boxPub: Base64URL.encode(p.boxPublicRaw),
                    boxId: p.boxId,
                    boxName: msg["box"]?["name"]?.string ?? p.name,
                    devId: dev,
                    name: msg["name"]?.string ?? name,
                    perms: (msg["perms"]?.array ?? []).compactMap { $0.string },
                    ticket: ticket,
                    mailboxKey: mk,
                    relay: msg["relay"]?.string ?? p.relay,
                    lan: p.lan
                )
            default: continue
            }
        }
    }
    throw lastError
}
