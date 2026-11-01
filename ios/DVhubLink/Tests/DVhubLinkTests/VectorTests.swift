// VectorTests.swift — Bit-genau gegen dvhub/test/fixtures/mobile-link-vectors.json
// (erzeugt von dvhub/scripts/mobile-link-vectors.mjs, Referenz Node).

import XCTest
import CryptoKit
@testable import DVhubLink

final class VectorTests: XCTestCase {
    static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("dvhub/test/fixtures/mobile-link-vectors.json")

    var v: JSONValue!

    override func setUpWithError() throws {
        v = try JSONValue.decode(try Data(contentsOf: Self.fixtureURL))
        XCTAssertEqual(v["version"]?.int, 1)
    }

    func b(_ s: JSONValue?, _ len: Int? = nil) throws -> Data { try Base64URL.decode(XCTUnwrap(s?.string), length: len) }
    func hex(_ s: JSONValue?) throws -> Data {
        let str = try XCTUnwrap(s?.string)
        var d = Data()
        var i = str.startIndex
        while i < str.endIndex {
            let j = str.index(i, offsetBy: 2)
            d.append(UInt8(str[i..<j], radix: 16)!)
            i = j
        }
        return d
    }

    func boxSigner() throws -> SoftwareSigner { try SoftwareSigner(rawScalar: b(v["keys"]?["boxPrivateRaw"], 32)) }
    func devSigner() throws -> SoftwareSigner { try SoftwareSigner(rawScalar: b(v["keys"]?["devPrivateRaw"], 32)) }

    func testBase64URLStrict() throws {
        XCTAssertEqual(try Base64URL.decode("AQID"), Data([1, 2, 3]))
        XCTAssertEqual(Base64URL.encode(Data([0xfb, 0xff])), "-_8")
        XCTAssertThrowsError(try Base64URL.decode("AQID="))      // Füllzeichen
        XCTAssertThrowsError(try Base64URL.decode("AQ+D"))       // falsches Alphabet
        XCTAssertThrowsError(try Base64URL.decode("A"))          // unmögliche Länge
        XCTAssertThrowsError(try Base64URL.decode("AR"))         // nicht kanonisch (Restbits)
        XCTAssertThrowsError(try Base64URL.decode("AQID", length: 4))
    }

    func testKeysAndIds() throws {
        let box = try boxSigner(), dev = try devSigner()
        XCTAssertEqual(Base64URL.encode(box.publicRaw), v["keys"]?["boxPub"]?.string)
        XCTAssertEqual(Base64URL.encode(dev.publicRaw), v["keys"]?["devPub"]?.string)
        XCTAssertEqual(box.id, v["keys"]?["boxId"]?.string)
        XCTAssertEqual(dev.id, v["keys"]?["devId"]?.string)
    }

    func testFramedAndTranscript() throws {
        let parts: [Field] = [.text("abc"), .text(""), .text("Grüße"), .int(1792674389)]
        XCTAssertEqual(try framed(parts).hex, v["framed"]?["framedHex"]?.string)
        XCTAssertEqual(try transcript(parts).hex, v["framed"]?["transcriptHex"]?.string)
    }

    func testRelayAuth() throws {
        let ra = try XCTUnwrap(v["relayAuth"])
        let n = try XCTUnwrap(ra["challenge"]?.string)
        let boxData = try relayAuthData(role: "box", challenge: n)
        let devData = try relayAuthData(role: "device", challenge: n)
        XCTAssertEqual(boxData.hex, ra["boxDataHex"]?.string)
        XCTAssertEqual(devData.hex, ra["deviceDataHex"]?.string)
        let boxPub = try b(v["keys"]?["boxPub"], 65), devPub = try b(v["keys"]?["devPub"], 65)
        XCTAssertTrue(verifySignature(publicRaw: boxPub, data: boxData, signature: try b(ra["boxSig"], 64)))
        XCTAssertTrue(verifySignature(publicRaw: devPub, data: devData, signature: try b(ra["deviceSig"], 64)))
        XCTAssertFalse(verifySignature(publicRaw: devPub, data: boxData, signature: try b(ra["deviceSig"], 64)))
        // Eigene Signatur prüft auch.
        let own = try devSigner().sign(devData)
        XCTAssertTrue(verifySignature(publicRaw: devPub, data: devData, signature: own))
    }

    func testTicket() throws {
        let t = try XCTUnwrap(v["ticket"])
        let ok = try XCTUnwrap(verifyTicket(t, now: Date(timeIntervalSince1970: 1_800_000_000)))
        XCTAssertEqual(ok.boxId, v["keys"]?["boxId"]?.string)
        XCTAssertEqual(ok.devId, v["keys"]?["devId"]?.string)
        XCTAssertNil(verifyTicket(t, now: Date(timeIntervalSince1970: 4_102_444_800)))  // abgelaufen
        var forged = try XCTUnwrap(t.object)
        forged["dev"] = "AAAAAAAAAAAAAAAAAAAAAA"
        XCTAssertNil(verifyTicket(.object(forged), now: Date(timeIntervalSince1970: 1_800_000_000)))
        // Rund-um: Kodieren und Lesen behält exp als ganze Zahl.
        let re = try JSONValue.decode(try t.encoded())
        XCTAssertEqual(re["exp"], .int(4_102_444_800))
        XCTAssertTrue(String(data: try t.encoded(), encoding: .utf8)!.contains("\"exp\":4102444800"))
    }

    func testPairToken() throws {
        let pt = try XCTUnwrap(v["pairToken"])
        let token = pairRelayToken(secret: try b(pt["secret"], 32))
        XCTAssertEqual(Base64URL.encode(token), pt["token"]?.string)
        XCTAssertEqual(pairTokenHash(token), pt["tokenHash"]?.string)
    }

    func testDeviceHandshake() throws {
        let h = try XCTUnwrap(v["deviceHandshake"])
        let boxPub = try b(v["keys"]?["boxPub"], 65)
        let hs = try DeviceHandshake(
            boxPublicRaw: boxPub, signer: try devSigner(),
            ephSeed: try b(h["ephDeviceSeed"], 32), nonce: Data(repeating: 3, count: 16)
        )
        let hello = hs.hello()
        XCTAssertEqual(hello, h["hs1"])
        let r = try hs.onHs2(try XCTUnwrap(h["hs2"]))
        XCTAssertEqual(r.transcript.hex, h["transcriptHex"]?.string)
        // hs3: Signatur aus der Fixture und die eigene prüfen beide.
        let devPub = try b(v["keys"]?["devPub"], 65)
        let clientData = try transcript([.bytes(r.transcript), .text("client")])
        XCTAssertTrue(verifySignature(publicRaw: devPub, data: clientData, signature: try b(h["hs3"]?["sig"], 64)))
        XCTAssertTrue(verifySignature(publicRaw: devPub, data: clientData, signature: try b(r.hs3["sig"], 64)))
        // Gerät → Box: gleiche Chiffretexte (Zähler 0, 1).
        for item in try XCTUnwrap(h["deviceToBox"]?.array) {
            let pt = Data(try XCTUnwrap(item["plaintext"]?.string).utf8)
            XCTAssertEqual(try r.session.sealData(pt), item["d"]?.string)
        }
        // Box → Gerät: entschlüsselbar.
        for item in try XCTUnwrap(h["boxToDevice"]?.array) {
            let pt = try r.session.openData(try XCTUnwrap(item["d"]?.string))
            XCTAssertEqual(String(data: pt, encoding: .utf8), item["plaintext"]?.string)
        }
        // Zweites Mal dieselbe Nachricht → Zähler passt nicht mehr → Fehler (kein Replay).
        let first = try XCTUnwrap(h["boxToDevice"]?.array?.first?["d"]?.string)
        XCTAssertThrowsError(try r.session.openData(first))
    }

    func testDeviceHandshakeRejectsForeignBox() throws {
        let h = try XCTUnwrap(v["deviceHandshake"])
        let otherBox = SoftwareSigner().publicRaw
        let hs = try DeviceHandshake(boxPublicRaw: otherBox, signer: try devSigner(),
                                     ephSeed: try b(h["ephDeviceSeed"], 32), nonce: Data(repeating: 3, count: 16))
        XCTAssertThrowsError(try hs.onHs2(try XCTUnwrap(h["hs2"]))) { e in
            XCTAssertEqual(e as? LinkError, .boxSignatureInvalid)
        }
    }

    func testPairHandshake() throws {
        let h = try XCTUnwrap(v["pairHandshake"])
        let boxPub = try b(v["keys"]?["boxPub"], 65)
        let dev = try devSigner()
        let hs = try PairHandshake(
            boxPublicRaw: boxPub, secret: try b(h["secret"], 32), signer: dev,
            ephSeed: try b(h["ephDeviceSeed"], 32), nonce: Data(repeating: 7, count: 16)
        )
        XCTAssertEqual(hs.hello(), h["p1"])
        let r = try hs.onP2(try XCTUnwrap(h["p2"]), name: "Chrissis iPhone", model: "iPhone Duo")
        XCTAssertEqual(r.transcript.hex, h["transcriptHex"]?.string)
        XCTAssertEqual(r.code, h["code"]?.string)
        XCTAssertEqual(r.code.count, 6)
        // Box-Sicht: p3 aus der Fixture mit dem Gegen-Schlüssel öffnen.
        let box = r.session.mirrored()
        let p3 = try box.open(try XCTUnwrap(h["p3d"]?.string))
        XCTAssertEqual(p3["pub"]?.string, v["keys"]?["devPub"]?.string)
        XCTAssertEqual(p3["name"]?.string, "Chrissis iPhone")
        XCTAssertEqual(p3["model"]?.string, "iPhone Duo")
        let pairClient = try transcript([.bytes(r.transcript), .text("pair-client")])
        XCTAssertTrue(verifySignature(publicRaw: dev.publicRaw, data: pairClient, signature: try b(p3["sig"], 64)))
        XCTAssertTrue(verifySignature(publicRaw: dev.publicRaw, data: pairClient, signature: try b(r.p3["sig"], 64)))
        // Box → Gerät (p_wait).
        let item = try XCTUnwrap(h["boxToDevice"]?.array?.first)
        let pt = try r.session.openData(try XCTUnwrap(item["d"]?.string))
        XCTAssertEqual(String(data: pt, encoding: .utf8), item["plaintext"]?.string)
    }

    func testPairHandshakeWrongSecretCannotDecrypt() throws {
        let h = try XCTUnwrap(v["pairHandshake"])
        let hs = try PairHandshake(
            boxPublicRaw: try b(v["keys"]?["boxPub"], 65), secret: Data(repeating: 1, count: 32), signer: try devSigner(),
            ephSeed: try b(h["ephDeviceSeed"], 32), nonce: Data(repeating: 7, count: 16)
        )
        let r = try hs.onP2(try XCTUnwrap(h["p2"]), name: "x", model: "y")
        XCTAssertThrowsError(try r.session.openData(try XCTUnwrap(h["boxToDevice"]?.array?.first?["d"]?.string)))
    }

    func testMailbox() throws {
        let m = try XCTUnwrap(v["mailbox"])
        let key = try b(m["key"], 32)
        let devId = try XCTUnwrap(m["devId"]?.string)
        let msg = try openMailbox(key: key, devId: devId, d: try XCTUnwrap(m["d"]?.string))
        XCTAssertEqual(msg, try JSONValue.decode(Data(try XCTUnwrap(m["plaintext"]?.string).utf8)))
        XCTAssertThrowsError(try openMailbox(key: key, devId: "anderesGeraet", d: try XCTUnwrap(m["d"]?.string)))
        let again = try sealMailbox(key: key, devId: devId, value: ["t": "event"])
        XCTAssertEqual(try openMailbox(key: key, devId: devId, d: again)["t"]?.string, "event")
    }

    func testRawAead() throws {
        let a = try XCTUnwrap(v["aead"])
        let sealed = try aeadSeal(key: try b(a["key"], 32), nonce: try hex(a["nonceHex"]),
                                  plaintext: Data(try XCTUnwrap(a["plaintext"]?.string).utf8), aad: try hex(a["aadHex"]))
        XCTAssertEqual(sealed.hex, a["sealedHex"]?.string)
    }

    func testQrExample() throws {
        let p = try PairPayload(try XCTUnwrap(v["qrExample"]?.string))
        let e = try XCTUnwrap(v["qrExampleParsed"])
        XCTAssertEqual(Base64URL.encode(p.boxPublicRaw), e["box"]?.string)
        XCTAssertEqual(Base64URL.encode(p.secret), e["secret"]?.string)
        XCTAssertEqual(p.boxId, v["keys"]?["boxId"]?.string)
        XCTAssertEqual(p.name, e["name"]?.string)                       // „DVhub+Test“ → „DVhub Test“
        XCTAssertEqual(p.lan, (e["lan"]?.array ?? []).compactMap { $0.string })
        XCTAssertEqual(p.relay, e["relay"]?.string)
        XCTAssertEqual(p.expires.timeIntervalSince1970, e["exp"]?.double)
        XCTAssertThrowsError(try PairPayload("https://example.org"))
        XCTAssertThrowsError(try PairPayload("dvhub://pair?v=2&b=x&s=y"))
        // Ohne l und r: kein Weg, aber gültig.
        let minimal = try PairPayload("dvhub://pair?v=1&b=\(e["box"]!.string!)&s=\(e["secret"]!.string!)&e=1&n=X")
        XCTAssertTrue(minimal.lan.isEmpty)
        XCTAssertNil(minimal.relay)
        // Unsinnige Hosts und Relay-Schemata werden verworfen.
        let odd = try PairPayload("dvhub://pair?v=1&b=\(e["box"]!.string!)&s=\(e["secret"]!.string!)&e=1&l=a%2Fb%2Cok.local&r=http%3A%2F%2Fx")
        XCTAssertEqual(odd.lan, ["ws://ok.local/api/mobile-link/ws"])
        XCTAssertNil(odd.relay)
    }
}
