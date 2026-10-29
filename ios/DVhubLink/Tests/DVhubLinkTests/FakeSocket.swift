// FakeSocket.swift — gescriptete Gegenstelle für Tests ohne Netz.

import Foundation
@testable import DVhubLink

final class FakeSocket: LinkSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [String] = []
    private var waiters: [CheckedContinuation<String, Error>] = []
    private var closedError: LinkError?
    private(set) var sent: [JSONValue] = []
    private(set) var closeCount = 0
    /// Antworten auf eine gesendete Nachricht.
    var onSend: (JSONValue) -> [JSONValue] = { _ in [] }

    init(initial: [JSONValue] = []) {
        inbox = initial.map { String(data: try! $0.encoded(), encoding: .utf8)! }
    }

    func push(_ v: JSONValue) {
        let text = String(data: try! v.encoded(), encoding: .utf8)!
        lock.lock()
        if !waiters.isEmpty {
            let w = waiters.removeFirst()
            lock.unlock()
            w.resume(returning: text)
            return
        }
        inbox.append(text)
        lock.unlock()
    }

    /// Gegenstelle schließt (Relay/Box).
    func remoteClose(code: Int = 4000, reason: String = "") {
        lock.lock()
        closedError = .closed(code: code, reason: reason)
        let ws = waiters
        waiters.removeAll()
        lock.unlock()
        for w in ws { w.resume(throwing: LinkError.closed(code: code, reason: reason)) }
    }

    func send(_ text: String) async throws {
        let v = try JSONValue.decode(Data(text.utf8))
        lock.lock()
        if let e = closedError { lock.unlock(); throw e }
        sent.append(v)
        lock.unlock()
        for r in onSend(v) { push(r) }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            lock.lock()
            if !inbox.isEmpty {
                let t = inbox.removeFirst()
                lock.unlock()
                cont.resume(returning: t)
            } else if let e = closedError {
                lock.unlock()
                cont.resume(throwing: e)
            } else {
                waiters.append(cont)
                lock.unlock()
            }
        }
    }

    func close(code: Int, reason: String) {
        lock.lock()
        closeCount += 1
        lock.unlock()
        remoteClose(code: code, reason: reason)
    }

    var sentTypes: [String] {
        lock.lock(); defer { lock.unlock() }
        return sent.compactMap { $0["t"]?.string }
    }
}

enum Fixtures {
    static let challenge: JSONValue = ["t": "challenge", "n": .string(Base64URL.encode(Data(repeating: 7, count: 32))), "relay": "fake", "v": 1]

    static func credentials(box: SoftwareSigner, dev: SoftwareSigner, lan: [String] = [], relay: String? = "ws://relay.invalid/v1/ws") -> LinkCredentials {
        LinkCredentials(
            boxPub: Base64URL.encode(box.publicRaw), boxId: box.id, boxName: "Test", devId: dev.id, name: "Gerät",
            perms: ["read"], ticket: ["v": 1], mailboxKey: Base64URL.encode(Data(repeating: 0, count: 32)),
            relay: relay, lan: lan
        )
    }
}
