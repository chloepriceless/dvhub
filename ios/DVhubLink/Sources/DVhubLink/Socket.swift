// Socket.swift — WebSocket zum Relay (bzw. zum eingebetteten Relay der Box).

import Foundation

public protocol LinkSocket: AnyObject {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close(code: Int, reason: String)
}

public final class URLSessionLinkSocket: NSObject, LinkSocket, URLSessionWebSocketDelegate, @unchecked Sendable {
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private let lock = NSLock()
    private var closeInfo: (Int, String)?

    public init(url: URL) {
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = 2 * 1024 * 1024
        task.resume()
    }

    public func send(_ text: String) async throws {
        do { try await task.send(.string(text)) } catch { throw mapped(error) }
    }

    public func receive() async throws -> String {
        do {
            switch try await task.receive() {
            case .string(let s): return s
            case .data: throw LinkError.protocolError("binary_frame")
            @unknown default: throw LinkError.protocolError("unknown_frame")
            }
        } catch let e as LinkError {
            throw e
        } catch {
            throw mapped(error)
        }
    }

    public func close(code: Int = 1000, reason: String = "") {
        task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: Data(reason.utf8))
        session.finishTasksAndInvalidate()
    }

    private func mapped(_ error: Error) -> Error {
        lock.lock(); defer { lock.unlock() }
        if let (code, reason) = closeInfo { return LinkError.closed(code: code, reason: reason) }
        let code = task.closeCode.rawValue
        if code != 0 {
            let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            return LinkError.closed(code: code, reason: reason)
        }
        return error
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        lock.lock(); defer { lock.unlock() }
        closeInfo = (closeCode.rawValue, reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
    }
}

/// Wartet höchstens `seconds` auf `operation`. `onTimeout` muss die Operation
/// beenden (z. B. Socket schließen) — die Task-Gruppe wartet auf alle Kinder.
public func withTimeout<T: Sendable>(_ seconds: TimeInterval, onTimeout: @escaping @Sendable () -> Void = {},
                                     _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            onTimeout()
            throw LinkError.timeout
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw LinkError.timeout }
        return first
    }
}

/// JSON-Nachrichten über einem Socket, mit Warten auf einen bestimmten Typ.
/// Nur für den sequentiellen Teil (Anmeldung, Kopplung); danach liest
/// `DeviceConnection` selbst.
final class RelayChannel: @unchecked Sendable {
    let socket: LinkSocket

    init(socket: LinkSocket) { self.socket = socket }

    func send(_ value: JSONValue) async throws {
        guard let text = String(data: try value.encoded(), encoding: .utf8) else { throw LinkError.protocolError("encode") }
        try await socket.send(text)
    }

    func next(type: String, timeout: TimeInterval) async throws -> JSONValue {
        let sock = socket
        return try await withTimeout(timeout, onTimeout: { sock.close(code: 1000, reason: "timeout") }) {
            while true {
                let text = try await sock.receive()
                guard let msg = try? JSONValue.decode(Data(text.utf8)) else { continue }
                if msg["t"]?.string == "error", type != "error" {
                    if msg["e"]?.string == "box_offline" { throw LinkError.boxOffline }
                    continue
                }
                if msg["t"]?.string == type { return msg }
            }
        }
    }

    func close() { socket.close(code: 1000, reason: "bye") }
}
