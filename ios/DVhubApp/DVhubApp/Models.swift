// Models.swift — Anzeige-Modelle aus den Daten der Box.

import Foundation
import DVhubLink

// LiveStatus (Kompakt-Status, tolerant gelesen) liegt im Paket DVhubLink (AppLogic.swift).

struct SeriesPoint: Identifiable, Equatable {
    let key: String
    let date: Date
    let value: Double
    var id: String { "\(key)|\(date.timeIntervalSince1970)" }
}

enum ISO {
    static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        return fractional.date(from: s) ?? plain.date(from: s)
    }
    static func string(_ d: Date) -> String { fractional.string(from: d) }
}

// Format (Zahlen/Zeiten) liegt in Shared/Format.swift — auch für die Widgets.

// MARK: - Abrufe bei der Box

enum BoxData {
    struct Failure: Error { let message: String }

    static let powerKeys = ["pv_total_w", "load_power_w", "self_consumption_w", "grid_import_w", "grid_export_w", "battery_power_w"]
    static let socKey = "battery_soc_pct"
    static let dayKeys = powerKeys + [socKey]

    static func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
    }

    /// Messreihen aus /api/telemetry/series. 300 s: Die Box fasst in
    /// 5-Minuten-Mittel zusammen (rund 1 500 Zeilen am Tag). Mit 900 käme jeder
    /// 5-s-Messwert und sprengte den Kanal. Bleibt das leer, gibt es an dem Tag
    /// nur grobe Werte (z. B. VRM-Import, 15 min) — dann diese holen.
    static func series(_ c: SystemController, keys: [String], start: Date, end: Date) async -> Result<[SeriesPoint], Failure> {
        let base = "/api/telemetry/series?keys=\(keys.joined(separator: ","))&start=\(enc(ISO.string(start)))&end=\(enc(ISO.string(end)))&maxResolution="
        do {
            var r = try await c.request("GET", base + "300")
            if r.status == 200, r.body["ok"]?.bool != false, (r.body["data"]?.array ?? []).isEmpty {
                r = try await c.request("GET", base + "900")
            }
            // Bricht die Datenbank mitten im Strom ab, bleibt es bei HTTP 200,
            // aber ok:false — dann keine halben Kurven zeigen.
            guard r.status == 200, r.body["ok"]?.bool != false, let rows = r.body["data"]?.array else {
                switch r.status {
                case 200: return .failure(Failure(message: String(localized: "Verlauf unvollständig: \(r.body["error"]?.string ?? String(localized: "Fehler in der Anlage")).")))
                case 503: return .failure(Failure(message: String(localized: "Die Anlage hat keine Messwert-Datenbank.")))
                case 413: return .failure(Failure(message: String(localized: "Der Verlauf ist für die Übertragung zu groß.")))
                case 429: return .failure(Failure(message: String(localized: "Gerade zu viele Anfragen. Bitte gleich noch einmal.")))
                default: return .failure(Failure(message: String(localized: "Verlauf nicht verfügbar (HTTP \(r.status)).")))
                }
            }
            return .success(rows.compactMap { row in
                guard let key = row["key"]?.string, let d = ISO.parse(row["ts"]?.string), let v = row["value"]?.double else { return nil }
                return SeriesPoint(key: key, date: d, value: v)
            })
        } catch {
            return .failure(Failure(message: userMessage(for: error)))
        }
    }

    enum HistoryResult {
        case ok(HistorySummary)
        case proRequired
        case failed(String)
    }

    static func history(_ c: SystemController, view: HistoryPeriod, date: Date) async -> HistoryResult {
        let param = HistorySummary.dateParam(date)
        do {
            let r = try await c.request("GET", "/api/history/summary?view=\(view.rawValue)&date=\(param)&lean=1")
            if HistorySummary.isProRequired(status: r.status, body: r.body) { return .proRequired }
            switch r.status {
            case 200:
                guard let s = HistorySummary.from(r.body, view: view, date: param) else { return .failed(String(localized: "Unerwartete Antwort der Anlage.")) }
                return .ok(s)
            case 503: return .failed(String(localized: "Die Anlage hat keine Messwert-Datenbank."))
            // Ältere DVhub-Stände kennen lean=1 nicht und schicken alles.
            case 413: return .failed(String(localized: "Die Auswertung ist für die Übertragung zu groß. Ein neuerer DVhub-Stand schickt sie schlanker."))
            case 429: return .failed(String(localized: "Gerade zu viele Anfragen. Bitte gleich noch einmal."))
            default: return .failed(String(localized: "Historie nicht verfügbar (HTTP \(r.status))."))
            }
        } catch {
            return .failed(userMessage(for: error))
        }
    }
}
