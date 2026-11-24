// PlantConnection.swift — was die App von einer Verbindung zur Anlage braucht.
//
// Zwei Umsetzungen:
//   • `DeviceConnection` — die echte Anlage: Heimnetz oder Relay, Ende zu Ende
//     verschlüsselt (DeviceConnection.swift),
//   • `DemoConnection` — die eingebaute Beispielanlage: rechnet alles im Gerät,
//     öffnet nie eine Netzverbindung (Demo/DemoConnection.swift).
// Die App spricht nur mit diesem Protokoll. Ob dahinter eine Anlage oder die
// Demo steht, entscheidet sich an genau einer Stelle: dort, wo die Verbindung
// entsteht.

import Foundation

public protocol PlantConnection: AnyObject, Sendable {
    /// Ereignisse der Verbindung: Begrüßung, Live-Werte, Abbruch.
    nonisolated var events: AsyncStream<LinkEvent> { get }
    nonisolated var route: LinkRoute { get }
    /// Die Sitzung steht (die Anlage hat sich gemeldet).
    var isSessionReady: Bool { get async }

    func subscribe(live: Bool, intervalMs: Int) async throws
    func fetchMailbox(timeout: TimeInterval) async throws -> [MailboxItem]
    func ackMailbox(_ ids: [String]) async throws
    func request(_ method: String, _ path: String, body: JSONValue?, timeout: TimeInterval) async throws -> LinkResponse
    func close() async
}

public extension PlantConnection {
    /// Anfrage mit der üblichen Frist (20 s).
    func request(_ method: String, _ path: String, body: JSONValue? = nil) async throws -> LinkResponse {
        try await request(method, path, body: body, timeout: 20)
    }

    func fetchMailbox() async throws -> [MailboxItem] { try await fetchMailbox(timeout: 10) }
}

extension DeviceConnection: PlantConnection {}
