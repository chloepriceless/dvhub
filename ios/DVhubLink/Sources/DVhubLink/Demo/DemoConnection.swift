// DemoConnection.swift — die „Verbindung“ zur Demo-Anlage.
//
// `DemoBox` hält die Beispielanlage samt Zustand und beantwortet Anfragen, wie
// es sonst die DVhub-Box tut. `DemoConnection` ist die Verbindung dorthin: Sie
// erfüllt dasselbe Protokoll wie die echte (`PlantConnection`), meldet
// Begrüßung und Live-Werte — und öffnet nie eine Netzverbindung. Es gibt hier
// keinen Socket, keine Adresse und keinen Schlüssel.

import Foundation

/// Die Box der Demo-Anlage. Ein Exemplar je Programm: App, Kurzbefehle und
/// Verbindungen sprechen mit demselben Zustand.
public actor DemoBox {
    public nonisolated let world: DemoWorld
    private var plant: DemoPlant
    private let clock: @Sendable () -> Date
    private let onChange: (@Sendable (DemoPlant.State) -> Void)?

    /// `onChange` meldet jeden geänderten Zustand (zum Speichern).
    public init(state: DemoPlant.State, calendar: Calendar = .current, clock: @escaping @Sendable () -> Date = { Date() },
                onChange: (@Sendable (DemoPlant.State) -> Void)? = nil) {
        let plant = DemoPlant(state: state, calendar: calendar)
        self.plant = plant
        self.world = plant.world
        self.clock = clock
        self.onChange = onChange
    }

    public var state: DemoPlant.State { plant.state }

    /// Führt `work` an der Anlage aus und meldet einen geänderten Zustand zum Speichern.
    private func with<T>(_ work: (inout DemoPlant, Date) -> T) -> T {
        let before = plant.state
        let result = work(&plant, clock())
        if plant.state != before { onChange?(plant.state) }
        return result
    }

    /// Anfrage wie an die Box (`GET /api/status`, `POST /api/ev` …).
    public func request(_ method: String, _ path: String, body: JSONValue? = nil) -> LinkResponse {
        with { plant, now in plant.respond(method, path, body: body, now: now) }
    }

    /// Kompakt-Status jetzt (Live-Wert). Vorher erledigt sich, was die Zeit erledigt
    /// (abgelaufenes „Sofort laden“, Regel am Stopp-Stand) — auch ohne Anfrage der App.
    public func status() -> (status: JSONValue, at: Date) {
        with { plant, now in
            plant.settle(at: now)
            return (plant.compactStatus(at: now), now)
        }
    }

    public func live() -> DemoPlant.Live {
        with { plant, now in
            plant.settle(at: now)
            return plant.live(at: now)
        }
    }

    public func mailbox() -> [MailboxItem] { plant.mailbox() }
}

public actor DemoConnection: PlantConnection {
    public nonisolated let events: AsyncStream<LinkEvent>
    public nonisolated let route = LinkRoute(url: URL(string: "demo://anlage")!, kind: .demo)
    private let sink: AsyncStream<LinkEvent>.Continuation
    private let box: DemoBox
    /// Kurze Bedenkzeit je Anfrage — wie eine Box im Heimnetz, damit Ladeanzeigen zu sehen sind.
    private let latency: Duration
    private var ticker: Task<Void, Never>?
    private var closed = false

    public init(box: DemoBox, name: String, latency: Duration = .milliseconds(90)) {
        self.box = box
        self.latency = latency
        var sink: AsyncStream<LinkEvent>.Continuation!
        events = AsyncStream(bufferingPolicy: .bufferingNewest(64)) { sink = $0 }
        self.sink = sink
        // Die Begrüßung liegt sofort bereit — wie bei einer Box, die schon verbunden ist.
        sink.yield(.connected(welcome: [
            "perms": ["read", "control"],
            "box": ["name": .string(name), "version": .string(DemoPlant.version)],
        ], ticket: nil))
    }

    public var isSessionReady: Bool { !closed }

    /// Live-Werte im Takt `intervalMs` (mindestens eine halbe Sekunde); der erste kommt sofort.
    public func subscribe(live: Bool, intervalMs: Int) {
        ticker?.cancel()
        ticker = nil
        guard live, !closed else { return }
        let step = Duration.milliseconds(max(500, intervalMs))
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.tick()
                do { try await Task.sleep(for: step) } catch { return }
            }
        }
    }

    private func tick() async {
        let s = await box.status()
        guard !closed else { return }
        sink.yield(.live(status: s.status, ts: s.status["ts"]?.string))
    }

    public func fetchMailbox(timeout: TimeInterval) async throws -> [MailboxItem] {
        guard !closed else { throw LinkError.closed(code: 1000, reason: "") }
        return await box.mailbox()
    }

    /// Die Demo hebt ihre Meldungen selbst auf — nichts zu quittieren.
    public func ackMailbox(_ ids: [String]) {}

    public func request(_ method: String, _ path: String, body: JSONValue?, timeout: TimeInterval) async throws -> LinkResponse {
        guard !closed else { throw LinkError.boxOffline }
        // Wie bei der echten Verbindung bricht eine abgebrochene Aufgabe die Anfrage nicht ab
        // (sonst meldete eine Seite beim Verlassen „Abgebrochen“).
        if latency > .zero { try? await Task.sleep(for: latency) }
        guard !closed else { throw LinkError.boxOffline }
        return await box.request(method, path, body: body)
    }

    public func close() {
        guard !closed else { return }
        closed = true
        ticker?.cancel()
        ticker = nil
        sink.yield(.closed(nil))
        sink.finish()
    }
}

public extension LinkCredentials {
    /// Die Demo-Anlage in der Anlagenliste. Sie trägt keine Wege, kein Ticket und keinen Schlüssel:
    /// Über sie lässt sich nichts erreichen außer der Demo.
    static func demo(name: String) -> LinkCredentials {
        LinkCredentials(boxPub: "", boxId: DemoPlant.boxId, boxName: name, devId: "demo", name: "", perms: ["read", "control"],
                        ticket: .null, mailboxKey: "", relay: nil, lan: [], keyRef: nil)
    }

    var isDemo: Bool { boxId == DemoPlant.boxId }
}
