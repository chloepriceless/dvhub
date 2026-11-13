// WidgetSnapshot.swift — letzter Live-Stand für die Widgets. Die App schreibt
// ihn in den Container der App-Gruppe; das Widget liest nur.
//
// Die Gruppen-ID kommt aus der Info.plist (`DVhubAppGroup`, aus der Bundle-ID
// abgeleitet, siehe Config/App.xcconfig). Ohne App-Gruppe — z. B. mit einem
// kostenlosen Personal Team, das diese Fähigkeit nicht bekommt — gibt es keinen
// Container: Die App schreibt dann nichts, das Widget zeigt einen Hinweis.

import Foundation

struct WidgetSnapshot: Codable, Equatable {
    var boxName: String
    var at: Date
    var soc: Double?
    var pvW: Double?
    var loadW: Double?
    var gridImportW: Double?
    var gridExportW: Double?
    var batteryW: Double?
    var todayNetEur: Double?
    var todayRevenueEur: Double?
    var todayCostEur: Double?
    var emergencyStop: Bool?
    var alarmsActive: Int?

    /// Beispielwerte für die Widget-Galerie und Vorschauen.
    static let sample = WidgetSnapshot(
        boxName: "Meine Anlage", at: Date(), soc: 68, pvW: 5400, loadW: 900, gridImportW: 0, gridExportW: 3100,
        batteryW: 1400, todayNetEur: 3.21, todayRevenueEur: 4.05, todayCostEur: 0.84, emergencyStop: false, alarmsActive: 0)
}

enum SharedStore {
    static let widgetKindStatus = "DVhubStatusWidget"
    static let widgetKindMoney = "DVhubMoneyWidget"
    private static let fileName = "widget-snapshot.json"

    /// Gruppen-ID aus der Info.plist; leer, wenn ohne App-Gruppe gebaut.
    static var groupId: String? {
        guard let id = Bundle.main.object(forInfoDictionaryKey: "DVhubAppGroup") as? String,
              !id.isEmpty, !id.contains("$(") else { return nil }
        return id
    }

    /// Container der App-Gruppe — nil, wenn die Signatur keine App-Gruppe hat.
    static var containerURL: URL? {
        guard let id = groupId else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
    }

    static var isAvailable: Bool { containerURL != nil }

    static func read() -> WidgetSnapshot? {
        guard let url = containerURL?.appendingPathComponent(fileName),
              let data = try? Data(contentsOf: url) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return try? dec.decode(WidgetSnapshot.self, from: data)
    }

    @discardableResult
    static func write(_ s: WidgetSnapshot) -> Bool {
        guard let url = containerURL?.appendingPathComponent(fileName) else { return false }
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        guard let data = try? enc.encode(s) else { return false }
        // Nur bei entsperrtem Gerät lesbar wäre zu streng: das Widget rendert auch
        // gesperrt. Inhalt sind Anzeigewerte, keine Schlüssel.
        return (try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil
    }

    static func clear() {
        guard let url = containerURL?.appendingPathComponent(fileName) else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
