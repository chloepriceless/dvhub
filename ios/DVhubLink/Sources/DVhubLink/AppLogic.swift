// AppLogic.swift — Logik, die die App braucht und die sich hier testen lässt:
// verständliche Fehlertexte, Begrüßung übernehmen, Status tolerant lesen,
// Briefkasten-Zustand und Wiederverbindungs-Backoff.

import Foundation

// MARK: - Fehlertexte

public extension LinkError {
    /// Text für die Oberfläche. Gründe vom Relay/von der Box werden nur
    /// übersetzt, wenn sie bekannt sind — fremder Text wird nie angezeigt.
    var userMessage: String {
        switch self {
        case .closed(let code, let reason):
            switch reason {
            case "device_not_allowed": return "Dieses Gerät wurde in DVhub entkoppelt. Bitte neu koppeln."
            case "box_not_allowed": return "Unter der gespeicherten Adresse antwortet eine andere Anlage."
            case "mobile_link_disabled": return "Die Handy-App ist in DVhub ausgeschaltet."
            case "pairing_not_open": return "Dieser QR-Code ist schon verbraucht oder abgelaufen. Bitte in DVhub einen neuen erzeugen."
            case "auth_failed", "auth_timeout": return "Anmeldung abgelehnt. Bitte neu koppeln."
            case "rate_limited", "too_many_devices", "relay_full": return "Das Relay ist gerade ausgelastet. Gleich erneut."
            case "replaced", "shutdown", "box_offline": return "Die Anlage ist gerade nicht verbunden."
            default: break
            }
            switch code {
            case 4002: return "Anmeldung abgelehnt. Bitte neu koppeln."
            case 4003: return "Zugriff nicht erlaubt (Code 4003)."
            case 4008: return "Das Relay hat die Verbindung begrenzt. Gleich erneut."
            case 4011: return "Das Relay startet neu."
            default: return "Verbindung getrennt (Code \(code))."
            }
        case .timeout: return "Keine Antwort (Zeitüberschreitung)."
        case .boxOffline: return "Die Anlage ist gerade nicht verbunden."
        case .relay, .protocolError, .handshake: return "Unerwartete Antwort der Gegenstelle."
        default: return description
        }
    }
}

public func userMessage(for error: Error) -> String {
    if let e = error as? LinkError { return e.userMessage }
    if error is CancellationError { return "Abgebrochen." }
    let ns = error as NSError
    if ns.domain == NSURLErrorDomain { return "Keine Verbindung (Netzwerkfehler \(ns.code))." }
    return "Unbekannter Fehler."
}

// MARK: - Begrüßung übernehmen

public extension LinkCredentials {
    /// Übernimmt Rechte (auch eine leere Liste bzw. Herabstufung), Anlagennamen
    /// und Relay-Adresse aus der Begrüßung der Box. Liefert true, wenn sich
    /// etwas geändert hat (dann speichern).
    @discardableResult
    mutating func apply(welcome: JSONValue) -> Bool {
        var changed = false
        if let list = welcome["perms"]?.array {
            let p = list.compactMap { $0.string }
            if p != perms { perms = p; changed = true }
        }
        if let name = welcome["box"]?["name"]?.string, !name.isEmpty, name != boxName {
            boxName = name
            changed = true
        }
        // null = Relay in DVhub ausgeschaltet; nur ws(s)-Adressen übernehmen.
        if let field = welcome["relay"] {
            if field.isNull {
                if relay != nil { relay = nil; changed = true }
            } else if let r = field.string, r.hasPrefix("wss://") || r.hasPrefix("ws://"), r != relay {
                relay = r
                changed = true
            }
        }
        if let t = welcome["ticket"], !t.isNull, t != ticket {
            ticket = t
            changed = true
        }
        return changed
    }
}

// MARK: - Kompakt-Status

/// Kompakt-Status (live und im Briefkasten). Vorzeichen wie in DVhub: Akku
/// + = Laden. Tolerant: Ein Feld mit unerwartetem Typ wird nil, der Rest bleibt.
public struct LiveStatus: Equatable, Sendable {
    public var ts: String?
    public var soc: Double?
    public var batteryPowerW: Double?
    public var pvTotalW: Double?
    public var gridSetpointW: Double?
    public var gridImportW: Double?
    public var gridExportW: Double?
    public var loadW: Double?
    public var minSocPct: Double?
    public var alarmsActive: Int?
    public var alarmsSeverity: Int?
    public var alarmsStale: Bool?
    public var emergencyStop: Bool?
    public var telemetryFrozen: Bool?
    public var todayNetEur: Double?
    public var todayRevenueEur: Double?
    public var todayCostEur: Double?
    public var version: String?
    public var controls: Controls?

    public struct Controls: Equatable, Sendable {
        public var dv: DV?
        public var negativePrice: NegativePrice?
        public var feedInLimit: FeedInLimit?
        public var p14a: P14a?
        public struct DV: Equatable, Sendable { public var curtailed: Bool?; public var limitPct: Double? }
        public struct NegativePrice: Equatable, Sendable { public var protection: Bool?; public var active: Bool? }
        public struct FeedInLimit: Equatable, Sendable { public var limitW: Double?; public var blocked: Bool? }
        public struct P14a: Equatable, Sendable { public var active: Bool?; public var limitW: Double? }
    }

    public init() {}

    public static func from(_ v: JSONValue) -> LiveStatus? {
        guard v.object != nil else { return nil }
        var s = LiveStatus()
        s.ts = v["ts"]?.string
        s.soc = num(v["soc"])
        s.batteryPowerW = num(v["batteryPowerW"])
        s.pvTotalW = num(v["pvTotalW"])
        s.gridSetpointW = num(v["gridSetpointW"])
        s.gridImportW = num(v["gridImportW"])
        s.gridExportW = num(v["gridExportW"])
        s.loadW = num(v["loadW"])
        s.minSocPct = num(v["minSocPct"])
        s.alarmsActive = int(v["alarmsActive"])
        s.alarmsSeverity = int(v["alarmsSeverity"])
        s.alarmsStale = bool(v["alarmsStale"])
        s.emergencyStop = bool(v["emergencyStop"])
        s.telemetryFrozen = bool(v["telemetryFrozen"])
        s.todayNetEur = num(v["todayNetEur"])
        s.todayRevenueEur = num(v["todayRevenueEur"])
        s.todayCostEur = num(v["todayCostEur"])
        s.version = v["version"]?.string
        if let c = v["controls"], c.object != nil {
            var ctl = Controls()
            if let d = c["dv"], d.object != nil { ctl.dv = .init(curtailed: bool(d["curtailed"]), limitPct: num(d["limitPct"])) }
            if let n = c["negativePrice"], n.object != nil { ctl.negativePrice = .init(protection: bool(n["protection"]), active: bool(n["active"])) }
            if let f = c["feedInLimit"], f.object != nil { ctl.feedInLimit = .init(limitW: num(f["limitW"]), blocked: bool(f["blocked"])) }
            if let p = c["p14a"], p.object != nil { ctl.p14a = .init(active: bool(p["active"]), limitW: num(p["limitW"])) }
            s.controls = ctl
        }
        return s
    }

    static func num(_ v: JSONValue?) -> Double? {
        guard let v else { return nil }
        if let d = v.double, d.isFinite { return d }
        if let s = v.string, let d = Double(s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")), d.isFinite { return d }
        return nil
    }

    static func int(_ v: JSONValue?) -> Int? {
        guard let d = num(v), d == d.rounded(), abs(d) < 1e9 else { return nil }
        return Int(d)
    }

    static func bool(_ v: JSONValue?) -> Bool? {
        guard let v else { return nil }
        if let b = v.bool { return b }
        if let d = v.double { return d == 1 ? true : (d == 0 ? false : nil) }
        switch v.string?.lowercased() {
        case "true", "1": return true
        case "false", "0": return false
        default: return nil
        }
    }
}

// MARK: - Briefkasten

public struct MailboxEvent: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let at: Date
    public let kind: String
    public let alarmsActive: Int
    public let alarmsSeverity: Int
    public let emergencyStop: Bool

    public var text: String { Self.text(alarms: alarmsActive, emergencyStop: emergencyStop) }

    public static func text(alarms: Int, emergencyStop: Bool) -> String {
        var parts: [String] = []
        if emergencyStop { parts.append("Not-Halt aktiv") }
        if alarms > 0 { parts.append(alarms == 1 ? "1 Alarm aktiv" : "\(alarms) Alarme aktiv") }
        return parts.isEmpty ? "Alles wieder normal" : parts.joined(separator: " · ")
    }
}

/// Was die App aus dem Briefkasten übernommen hat. Wird gespeichert, bevor
/// quittiert wird — so geht kein Ereignis verloren (Fable-Review M2). Frische
/// zählt nur nach dem verschlüsselten `ts`; das Relay kann alte, gültige
/// Einträge erneut ausliefern.
public struct MailboxState: Codable, Equatable, Sendable {
    public var latest: JSONValue?
    public var latestAt: Date?
    public var events: [MailboxEvent] = []
    public var newestEventAt: Date?
    public static let maxEvents = 50

    public init() {}

    /// Übernimmt neue Einträge und liefert die IDs, die quittiert werden dürfen
    /// (übernommene und veraltete Ereignisse; den letzten Stand nie).
    public mutating func merge(_ items: [MailboxItem]) -> [String] {
        var ack: [String] = []
        for item in items {
            let at = parseISODate(item.message["ts"]?.string)
            if item.slot == "latest" {
                if let at, let status = item.message["status"], status.object != nil, latestAt.map({ at > $0 }) ?? true {
                    latest = status
                    latestAt = at
                }
                continue
            }
            ack.append(item.id)
            guard let at, item.message["t"]?.string == "event" else { continue }
            if let newest = newestEventAt, at <= newest { continue }
            let m = item.message
            events.append(MailboxEvent(
                id: "\(Int(at.timeIntervalSince1970 * 1000))-\(item.id)", at: at,
                kind: m["kind"]?.string ?? "event",
                alarmsActive: LiveStatus.int(m["alarmsActive"]) ?? 0,
                alarmsSeverity: LiveStatus.int(m["alarmsSeverity"]) ?? 0,
                emergencyStop: LiveStatus.bool(m["emergencyStop"]) ?? false
            ))
        }
        events.sort { $0.at > $1.at }
        if events.count > Self.maxEvents { events.removeLast(events.count - Self.maxEvents) }
        if let newest = events.first?.at, newestEventAt.map({ newest > $0 }) ?? true { newestEventAt = newest }
        return ack
    }
}

public func parseISODate(_ s: String?) -> Date? {
    guard let s else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

// MARK: - Wiederverbinden

/// Wartezeit vor dem nächsten Versuch (1, 2, 4 … 30 s). Eine Verbindung, die
/// nach weniger als `stableAfter` Sekunden wieder endet, zählt wie ein
/// Fehlschlag — sonst hämmert die App im Sekundentakt (Fable-Review N3).
public struct ReconnectBackoff: Sendable {
    public var current: UInt64 = 0
    public let maxSeconds: UInt64 = 30
    public let stableAfter: TimeInterval = 10

    public init() {}

    public mutating func afterFailure() -> UInt64 {
        current = current == 0 ? 1 : min(current * 2, maxSeconds)
        return current
    }

    public mutating func afterConnection(lasted seconds: TimeInterval) -> UInt64 {
        if seconds >= stableAfter { current = 0; return afterFailure() }
        return afterFailure()
    }
}
