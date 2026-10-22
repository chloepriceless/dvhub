// ConnectionBehaviorTests.swift — Verbindungsverhalten mit gescripteter Gegenstelle
// (Befunde des Fable-Reviews: M4b, N1, N2, N4).

import XCTest
@testable import DVhubLink

final class ConnectionBehaviorTests: XCTestCase {
    let box = SoftwareSigner()
    let dev = SoftwareSigner()

    /// M4b: Schließt die Gegenstelle, muss auch die eigene Seite (URLSession) zugemacht werden.
    func testRemoteCloseClosesOwnSocket() async throws {
        let sock = FakeSocket(initial: [Fixtures.challenge, ["t": "ok", "role": "device", "boxOnline": false]])
        let route = LinkRoute(url: URL(string: "ws://relay.invalid/v1/ws")!, kind: .relay)
        let conn = try await DeviceConnection.connect(credentials: Fixtures.credentials(box: box, dev: dev), signer: dev,
                                                      route: route, socketFactory: { _ in sock })
        sock.remoteClose(code: 4003, reason: "device_not_allowed")
        for await ev in conn.events { if case .closed = ev { break } }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertGreaterThanOrEqual(sock.closeCount, 1, "eigene Seite nicht geschlossen")
    }

    /// N2: Im Heimnetz ist die Box immer am eingebetteten Relay — ok mit
    /// boxOnline:false heißt „falsche Gegenstelle“ → Fehlschlag, weiter zum Relay.
    func testLanWithoutBoxIsFailure() async throws {
        let sock = FakeSocket(initial: [Fixtures.challenge, ["t": "ok", "role": "device", "boxOnline": false]])
        let route = LinkRoute(url: URL(string: "ws://192.168.1.60:8080/api/mobile-link/ws")!, kind: .lan)
        do {
            let c = try await DeviceConnection.connect(credentials: Fixtures.credentials(box: box, dev: dev), signer: dev,
                                                       route: route, socketFactory: { _ in sock })
            await c.close()
            XCTFail("Heimnetz ohne Box darf nicht als Verbindung gelten")
        } catch {
            XCTAssertGreaterThanOrEqual(sock.closeCount, 1)
        }
    }

    /// N4: box_offline während des Handshakes beendet das Warten sofort.
    func testBoxOfflineDuringHandshakeFailsFast() async throws {
        let sock = FakeSocket(initial: [Fixtures.challenge, ["t": "ok", "role": "device", "boxOnline": true]])
        sock.onSend = { msg in msg["t"]?.string == "data" ? [["t": "box_offline"]] : [] }
        let route = LinkRoute(url: URL(string: "ws://relay.invalid/v1/ws")!, kind: .relay)
        let started = Date()
        do {
            let c = try await DeviceConnection.connect(credentials: Fixtures.credentials(box: box, dev: dev), signer: dev,
                                                       route: route, socketFactory: { _ in sock })
            await c.close()
            XCTFail("Handshake ohne Box darf nicht gelingen")
        } catch {
            XCTAssertEqual(error as? LinkError, .boxOffline)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 3, "wartet bis zum Timeout statt sofort")
        XCTAssertGreaterThanOrEqual(sock.closeCount, 1)
    }

    /// N1: Antwortet auf dem ersten Weg eine falsche „Box“ (Signatur passt nicht
    /// zum QR-Code), wird der nächste Weg versucht.
    func testPairingTriesNextRouteAfterForeignBox() async throws {
        let secret = Data(repeating: 9, count: 32)
        let q = "dvhub://pair?v=1&b=\(Base64URL.encode(box.publicRaw))&s=\(Base64URL.encode(secret))&e=4102444800&n=Test&l=evil.invalid%3A1&r=ws%3A%2F%2Fgood.invalid%2Fv1%2Fws"
        let impostor = SoftwareSigner()
        func fakeBox(signer: SoftwareSigner) -> FakeSocket {
            let s = FakeSocket(initial: [Fixtures.challenge])
            var pairBox: (session: LinkSession?, th: Data?) = (nil, nil)
            s.onSend = { msg in
                switch msg["t"]?.string {
                case "auth": return [["t": "ok", "role": "pair", "boxOnline": true]]
                case "data":
                    guard let d = msg["d"]?.string else { return [] }
                    if pairBox.session == nil {
                        // p1 → p2 (wie createPairBox, mit `signer`)
                        let p1 = try! JSONValue.decode(Base64URL.decode(d))
                        let r = try! TestPairBox.answer(p1: p1, boxSigner: signer, boxPublicForTranscript: signer.publicRaw, secret: secret)
                        pairBox = (r.session, r.th)
                        return [["t": "data", "d": .string(Base64URL.encode(try! r.p2.encoded()))]]
                    }
                    _ = try? pairBox.session!.open(d)  // p3
                    let ok: JSONValue = ["t": "p_ok", "dev": .string(self.dev.id), "name": "Gerät", "perms": ["read"],
                                         "box": ["id": .string(signer.id), "name": "Test"], "ticket": ["v": 1],
                                         "mailboxKey": .string(Base64URL.encode(Data(repeating: 1, count: 32)))]
                    return [["t": "data", "d": .string(try! pairBox.session!.seal(["t": "p_wait"]))],
                            ["t": "data", "d": .string(try! pairBox.session!.seal(ok))]]
                default: return []
                }
            }
            return s
        }
        let evil = fakeBox(signer: impostor)
        let good = fakeBox(signer: box)
        let creds = try await pairDevice(qr: q, signer: dev, name: "Gerät", model: "Test", connectTimeout: 2,
                                         socketFactory: { $0.host == "evil.invalid" ? evil : good })
        XCTAssertEqual(creds.boxId, box.id)
        XCTAssertGreaterThanOrEqual(evil.closeCount, 1)
    }
}

/// Box-Seite der Kopplung (Spiegel von createPairBox in crypto.js), nur für Tests.
enum TestPairBox {
    static func answer(p1: JSONValue, boxSigner: SoftwareSigner, boxPublicForTranscript: Data, secret: Data) throws
        -> (p2: JSONValue, session: LinkSession, th: Data) {
        let eD = try Base64URL.decode(p1["e"]!.string!, length: 32)
        let nD = try Base64URL.decode(p1["n"]!.string!, length: 16)
        let eph = try ephemeral(seed: nil)
        let nB = randomBytes(16)
        let th = try transcript([.text(Labels.pair), .int(protocolVersion), .bytes(boxPublicForTranscript),
                                 .bytes(eD), .bytes(nD), .bytes(eph.publicKey.rawRepresentation), .bytes(nB)])
        let salt = Data(HMACHelper.sha256(key: secret, data: th))
        let keys = sessionKeys(ikm: try x25519Shared(eph, eD), salt: salt, info: Labels.pairKeys)
        let p2: JSONValue = ["t": "p2", "e": .string(Base64URL.encode(eph.publicKey.rawRepresentation)),
                             "n": .string(Base64URL.encode(nB)), "sig": .string(Base64URL.encode(try boxSigner.sign(th)))]
        return (p2, LinkSession(sendKey: keys.b2d, recvKey: keys.d2b, aad: th), th)
    }
}

import CryptoKit
enum HMACHelper {
    static func sha256(key: Data, data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }
}
