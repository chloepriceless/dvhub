// Format.swift — Zahlen und Zeiten auf Deutsch. Gemeinsam für App und Widgets.

import Foundation

enum Format {
    static let de = Locale(identifier: "de_DE")

    /// 850 W, 4,2 kW — ohne Vorzeichen.
    static func power(_ w: Double?) -> String {
        guard let w, w.isFinite else { return "–" }
        let a = abs(w)
        if a >= 1000 { return (a / 1000).formatted(.number.precision(.fractionLength(1)).locale(de)) + " kW" }
        return a.formatted(.number.precision(.fractionLength(0)).locale(de)) + " W"
    }

    /// Mit Vorzeichen (für Phasen, Sollwerte): −1,2 kW
    static func signedPower(_ w: Double?) -> String {
        guard let w, w.isFinite else { return "–" }
        return (w < 0 ? "−" : "") + power(w)
    }

    static func energy(_ kwh: Double?) -> String {
        guard let kwh, kwh.isFinite else { return "–" }
        let digits = abs(kwh) >= 100 ? 0 : 1
        return kwh.formatted(.number.precision(.fractionLength(digits)).locale(de)) + " kWh"
    }

    static func percent(_ p: Double?) -> String {
        guard let p, p.isFinite else { return "–" }
        return p.formatted(.number.precision(.fractionLength(0)).locale(de)) + " %"
    }

    static func euro(_ e: Double?) -> String {
        guard let e, e.isFinite else { return "–" }
        return e.formatted(.currency(code: "EUR").locale(de))
    }

    static func ct(_ c: Double?) -> String {
        guard let c, c.isFinite else { return "–" }
        return c.formatted(.number.precision(.fractionLength(1)).locale(de)) + " ct"
    }

    /// 0,5 h, 2 h 15 min
    static func hours(_ h: Double?) -> String {
        guard let h, h.isFinite else { return "–" }
        let total = Int((h * 60).rounded())
        if total < 60 { return "\(total) min" }
        return total % 60 == 0 ? "\(total / 60) h" : "\(total / 60) h \(total % 60) min"
    }

    /// Euro mit Vorzeichen: +3,21 €, −0,84 €
    static func signedEuro(_ e: Double?) -> String {
        guard let e, e.isFinite else { return "–" }
        return (e > 0.004 ? "+" : "") + euro(e).replacingOccurrences(of: "-", with: "−")
    }

    static func number(_ v: Double?, digits: Int = 1) -> String {
        guard let v, v.isFinite else { return "–" }
        return v.formatted(.number.precision(.fractionLength(digits)).locale(de))
    }

    static func time(_ d: Date) -> String {
        d.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(de))
    }

    static func dateTime(_ d: Date) -> String {
        if Calendar.current.isDateInToday(d) { return "heute " + time(d) }
        return d.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(de))
    }

    static func day(_ d: Date) -> String {
        if Calendar.current.isDateInToday(d) { return "Heute" }
        if Calendar.current.isDateInYesterday(d) { return "Gestern" }
        if Calendar.current.isDateInTomorrow(d) { return "Morgen" }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).locale(de))
    }
}
