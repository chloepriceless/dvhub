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

struct PlanRow: Identifiable, Equatable {
    let date: Date
    let socPct: Double?
    let pvKw: Double
    let feedInKw: Double
    var id: Date { date }
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

enum Format {
    static let de = Locale(identifier: "de_DE")

    /// 850 W, 4,2 kW — ohne Vorzeichen.
    static func power(_ w: Double?) -> String {
        guard let w else { return "–" }
        let a = abs(w)
        if a >= 1000 { return (a / 1000).formatted(.number.precision(.fractionLength(1)).locale(de)) + " kW" }
        return a.formatted(.number.precision(.fractionLength(0)).locale(de)) + " W"
    }

    static func percent(_ p: Double?) -> String {
        guard let p else { return "–" }
        return p.formatted(.number.precision(.fractionLength(0)).locale(de)) + " %"
    }

    static func euro(_ e: Double?) -> String {
        guard let e else { return "–" }
        return e.formatted(.currency(code: "EUR").locale(de))
    }

    static func time(_ d: Date) -> String {
        d.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(de))
    }

    static func dateTime(_ d: Date) -> String {
        if Calendar.current.isDateInToday(d) { return "heute " + time(d) }
        return d.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(de))
    }
}
