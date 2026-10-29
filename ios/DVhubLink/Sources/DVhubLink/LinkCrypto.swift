// LinkCrypto.swift — Sitzungsschlüssel, Handshakes, Ticket, Briefkasten.
// Bit-genau wie dvhub/services/mobile-link/crypto.js (Prüfwerte:
// dvhub/test/fixtures/mobile-link-vectors.json).

import Foundation
import CryptoKit
import Security

public let protocolVersion: Int64 = 1

enum Labels {
    static let relayAuth = "dvhub-relay-auth-v1"
    static let ticket = "dvhub-ticket-v1"
    static let pairToken = "dvhub-link-pair-token-v1"
    static let handshake = "dvhub-link-hs-v1"
    static let handshakeKeys = "dvhub-link-keys-v1"
    static let pair = "dvhub-link-pair-v1"
    static let pairKeys = "dvhub-link-pair-keys-v1"
    static let mailbox = "dvhub-mbox-v1"
    static let pairCode = "dvhub-pair-code-v1"
}

// MARK: - Grundbausteine

func ephemeral(seed: Data?) throws -> Curve25519.KeyAgreement.PrivateKey {
    if let seed {
        guard seed.count == 32 else { throw LinkError.badLength }
        return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: seed)
    }
    return Curve25519.KeyAgreement.PrivateKey()
}

func randomBytes(_ n: Int) -> Data {
    var d = Data(count: n)
    let status = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
    precondition(status == errSecSuccess, "SecRandomCopyBytes fehlgeschlagen")
    return d
}

func x25519Shared(_ priv: Curve25519.KeyAgreement.PrivateKey, _ peerRaw: Data) throws -> Data {
    guard peerRaw.count == 32,
          let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerRaw),
          let secret = try? priv.sharedSecretFromKeyAgreement(with: pub) else { throw LinkError.badEphemeral }
    let raw = secret.withUnsafeBytes { Data($0) }
    // Punkte kleiner Ordnung liefern lauter Nullen — ablehnen.
    guard raw.contains(where: { $0 != 0 }) else { throw LinkError.badEphemeral }
    return raw
}

func hkdf(ikm: Data, salt: Data, info: String, length: Int) -> Data {
    let key = HKDF<SHA256>.deriveKey(
        inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Data(info.utf8), outputByteCount: length
    )
    return key.withUnsafeBytes { Data($0) }
}

public func aeadSeal(key: Data, nonce: Data, plaintext: Data, aad: Data) throws -> Data {
    let box = try ChaChaPoly.seal(plaintext, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: nonce), authenticating: aad)
    return box.ciphertext + box.tag
}

public func aeadOpen(key: Data, nonce: Data, sealed: Data, aad: Data) throws -> Data {
    guard sealed.count >= 16 else { throw LinkError.decryptFailed }
    do {
        let box = try ChaChaPoly.SealedBox(
            nonce: ChaChaPoly.Nonce(data: nonce),
            ciphertext: sealed.prefix(sealed.count - 16),
            tag: sealed.suffix(16)
        )
        return try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: aad)
    } catch {
        throw LinkError.decryptFailed
    }
}

func counterNonce(_ n: UInt64) -> Data {
    var d = Data(count: 4)
    withUnsafeBytes(of: n.bigEndian) { d.append(contentsOf: $0) }
    return d
}

// MARK: - Sitzung

/// Verschlüsselte Sitzung: je Richtung eigener Schlüssel und Zähler (ab 0),
/// AAD = Transkript. Ein fehlender, doppelter oder vertauschter Rahmen lässt
/// die Entschlüsselung scheitern.
public final class LinkSession {
    let sendKey: Data
    let recvKey: Data
    let aad: Data
    private(set) var sendCounter: UInt64 = 0
    private(set) var recvCounter: UInt64 = 0

    init(sendKey: Data, recvKey: Data, aad: Data) {
        self.sendKey = sendKey
        self.recvKey = recvKey
        self.aad = aad
    }

    public func sealData(_ plaintext: Data) throws -> String {
        let sealed = try aeadSeal(key: sendKey, nonce: counterNonce(sendCounter), plaintext: plaintext, aad: aad)
        sendCounter += 1
        return Base64URL.encode(sealed)
    }

    public func openData(_ d: String) throws -> Data {
        let pt = try aeadOpen(key: recvKey, nonce: counterNonce(recvCounter), sealed: try Base64URL.decode(d), aad: aad)
        recvCounter += 1
        return pt
    }

    public func seal(_ value: JSONValue) throws -> String { try sealData(try value.encoded()) }
    public func open(_ d: String) throws -> JSONValue { try JSONValue.decode(try openData(d)) }

    /// Gegenseite derselben Sitzung (nur für Tests).
    func mirrored() -> LinkSession { LinkSession(sendKey: recvKey, recvKey: sendKey, aad: aad) }
}

func sessionKeys(ikm: Data, salt: Data, info: String) -> (d2b: Data, b2d: Data) {
    let okm = hkdf(ikm: ikm, salt: salt, info: info, length: 64)
    return (okm.prefix(32), okm.suffix(32))
}

// MARK: - Relay-Anmeldung, Ticket, Kopplungs-Token

public func relayAuthData(role: String, challenge: String) throws -> Data {
    try framed([.text(Labels.relayAuth), .text(role), .bytes(try Base64URL.decode(challenge, length: 32))])
}

public struct VerifiedTicket: Equatable {
    public let boxId: String
    public let devId: String
}

public func verifyTicket(_ ticket: JSONValue, now: Date = Date()) -> VerifiedTicket? {
    guard ticket["v"]?.int == 1, let dev = ticket["dev"]?.string, let exp = ticket["exp"]?.int,
          let boxB64 = ticket["box"]?.string, let sigB64 = ticket["sig"]?.string,
          let boxPub = try? Base64URL.decode(boxB64, length: 65),
          let sig = try? Base64URL.decode(sigB64, length: 64) else { return nil }
    let boxId = keyId(boxPub)
    guard let data = try? framed([.text(Labels.ticket), .text(boxId), .text(dev), .int(exp)]),
          verifySignature(publicRaw: boxPub, data: data, signature: sig),
          Double(exp) > now.timeIntervalSince1970 else { return nil }
    return VerifiedTicket(boxId: boxId, devId: dev)
}

public func pairRelayToken(secret: Data) -> Data {
    hkdf(ikm: secret, salt: Data(), info: Labels.pairToken, length: 32)
}

public func pairTokenHash(_ token: Data) -> String { Base64URL.encode(sha256(token)) }

// MARK: - Handshake gekoppeltes Gerät

public final class DeviceHandshake {
    let boxPublicRaw: Data
    let signer: LinkSigner
    let eph: Curve25519.KeyAgreement.PrivateKey
    let nonce: Data
    private var done = false

    public init(boxPublicRaw: Data, signer: LinkSigner, ephSeed: Data? = nil, nonce: Data? = nil) throws {
        self.boxPublicRaw = boxPublicRaw
        self.signer = signer
        self.eph = try ephemeral(seed: ephSeed)
        self.nonce = nonce ?? randomBytes(16)
    }

    public func hello() -> JSONValue {
        [
            "t": "hs1", "v": .int(protocolVersion), "dev": .string(signer.id),
            "e": .string(Base64URL.encode(eph.publicKey.rawRepresentation)), "n": .string(Base64URL.encode(nonce)),
        ]
    }

    public func onHs2(_ msg: JSONValue) throws -> (hs3: JSONValue, session: LinkSession, transcript: Data) {
        guard !done else { throw LinkError.handshake("state") }
        guard msg["t"]?.string == "hs2", let e = msg["e"]?.string, let n = msg["n"]?.string, let s = msg["sig"]?.string else {
            throw LinkError.handshake("unexpected")
        }
        let eB = try Base64URL.decode(e, length: 32)
        let nB = try Base64URL.decode(n, length: 16)
        let th = try transcript([
            .text(Labels.handshake), .int(protocolVersion), .bytes(boxPublicRaw), .bytes(signer.publicRaw),
            .bytes(eph.publicKey.rawRepresentation), .bytes(nonce), .bytes(eB), .bytes(nB),
        ])
        guard verifySignature(publicRaw: boxPublicRaw, data: th, signature: try Base64URL.decode(s, length: 64)) else {
            throw LinkError.boxSignatureInvalid
        }
        let keys = sessionKeys(ikm: try x25519Shared(eph, eB), salt: th, info: Labels.handshakeKeys)
        done = true
        let clientSig = try signer.sign(try transcript([.bytes(th), .text("client")]))
        return (
            ["t": "hs3", "sig": .string(Base64URL.encode(clientSig))],
            LinkSession(sendKey: keys.d2b, recvKey: keys.b2d, aad: th),
            th
        )
    }
}

// MARK: - Kopplung per QR-Geheimnis

public final class PairHandshake {
    let boxPublicRaw: Data
    let secret: Data
    let signer: LinkSigner
    let eph: Curve25519.KeyAgreement.PrivateKey
    let nonce: Data
    private var done = false

    public init(boxPublicRaw: Data, secret: Data, signer: LinkSigner, ephSeed: Data? = nil, nonce: Data? = nil) throws {
        self.boxPublicRaw = boxPublicRaw
        self.secret = secret
        self.signer = signer
        self.eph = try ephemeral(seed: ephSeed)
        self.nonce = nonce ?? randomBytes(16)
    }

    public func hello() -> JSONValue {
        [
            "t": "p1", "v": .int(protocolVersion),
            "e": .string(Base64URL.encode(eph.publicKey.rawRepresentation)), "n": .string(Base64URL.encode(nonce)),
        ]
    }

    /// Liefert die Sitzung, den Vergleichscode und `p3` (erste verschlüsselte Nachricht).
    public func onP2(_ msg: JSONValue, name: String, model: String) throws -> (session: LinkSession, p3: JSONValue, transcript: Data, code: String) {
        guard !done else { throw LinkError.handshake("state") }
        guard msg["t"]?.string == "p2", let e = msg["e"]?.string, let n = msg["n"]?.string, let s = msg["sig"]?.string else {
            throw LinkError.handshake("unexpected")
        }
        let eB = try Base64URL.decode(e, length: 32)
        let nB = try Base64URL.decode(n, length: 16)
        let th = try transcript([
            .text(Labels.pair), .int(protocolVersion), .bytes(boxPublicRaw), .bytes(eph.publicKey.rawRepresentation), .bytes(nonce), .bytes(eB), .bytes(nB),
        ])
        guard verifySignature(publicRaw: boxPublicRaw, data: th, signature: try Base64URL.decode(s, length: 64)) else {
            throw LinkError.boxSignatureInvalid
        }
        let salt = Data(HMAC<SHA256>.authenticationCode(for: th, using: SymmetricKey(data: secret)))
        let keys = sessionKeys(ikm: try x25519Shared(eph, eB), salt: salt, info: Labels.pairKeys)
        done = true
        let sig = try signer.sign(try transcript([.bytes(th), .text("pair-client")]))
        let p3: JSONValue = [
            "t": "p3",
            "pub": .string(Base64URL.encode(signer.publicRaw)),
            "sig": .string(Base64URL.encode(sig)),
            "name": .string(String(name.prefix(64))),
            "model": .string(String(model.prefix(64))),
        ]
        return (LinkSession(sendKey: keys.d2b, recvKey: keys.b2d, aad: th), p3, th, try pairCode(transcript: th))
    }
}

/// Vergleichscode der Kopplung (6 Ziffern): App und DVhub-Oberfläche zeigen
/// denselben Code — stimmt er überein, hat niemand dazwischen gekoppelt.
public func pairCode(transcript th: Data) throws -> String {
    let h = sha256(try framed([.text(Labels.pairCode), .bytes(th)]))
    let n = h.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    let s = String(n % 1_000_000)
    return String(repeating: "0", count: 6 - s.count) + s
}

// MARK: - Briefkasten

public func openMailbox(key: Data, devId: String, d: String) throws -> JSONValue {
    let buf = try Base64URL.decode(d)
    guard buf.count >= 12 + 16 else { throw LinkError.decryptFailed }
    let pt = try aeadOpen(
        key: key, nonce: buf.prefix(12), sealed: buf.dropFirst(12),
        aad: try framed([.text(Labels.mailbox), .text(devId)])
    )
    return try JSONValue.decode(pt)
}

/// Nur für Tests und Werkzeuge: Briefkasten-Eintrag verschlüsseln wie die Box.
public func sealMailbox(key: Data, devId: String, value: JSONValue) throws -> String {
    let nonce = randomBytes(12)
    let sealed = try aeadSeal(key: key, nonce: nonce, plaintext: try value.encoded(), aad: try framed([.text(Labels.mailbox), .text(devId)]))
    return Base64URL.encode(nonce + sealed)
}
