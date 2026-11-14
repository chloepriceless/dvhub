// Format.swift — Zahlen, Einheiten und Zeiten in der Sprache und Region des
// Geräts, über die Formatter von Foundation. Gemeinsam für App, Widgets,
// Kurzbefehle und Live-Aktivität.

import Foundation

enum Format {
    /// Sprache der App und Region des Geräts; folgt Änderungen in den Einstellungen.
    static var locale: Locale { .autoupdatingCurrent }
    /// Platzhalter für „kein Wert“.
    static let none = "–"

    private static func measurement<U: Dimension>(_ value: Double, _ unit: U, digits: Int) -> String {
        Measurement(value: value, unit: unit)
            .formatted(.measurement(width: .abbreviated, usage: .asProvided,
                                    numberFormatStyle: .number.precision(.fractionLength(digits)).locale(locale)).locale(locale))
    }

    /// 850 W, 4,2 kW — ohne Vorzeichen.
    static func power(_ w: Double?) -> String {
        guard let w, w.isFinite else { return none }
        let a = abs(w)
        return a >= 1000 ? measurement(a / 1000, UnitPower.kilowatts, digits: 1) : measurement(a, UnitPower.watts, digits: 0)
    }

    /// Mit Vorzeichen (für Phasen, Sollwerte): −1,2 kW
    static func signedPower(_ w: Double?) -> String {
        guard let w, w.isFinite else { return none }
        return (w < 0 ? "−" : "") + power(w)
    }

    static func energy(_ kwh: Double?) -> String {
        guard let kwh, kwh.isFinite else { return none }
        return measurement(kwh, UnitEnergy.kilowattHours, digits: abs(kwh) >= 100 ? 0 : 1)
    }

    static func percent(_ p: Double?) -> String {
        guard let p, p.isFinite else { return none }
        return (p / 100).formatted(.percent.precision(.fractionLength(0)).locale(locale))
    }

    static func euro(_ e: Double?) -> String {
        guard let e, e.isFinite else { return none }
        return e.formatted(.currency(code: "EUR").locale(locale))
    }

    /// Cent je Kilowattstunde. Für „ct“ kennt Foundation keine Einheit — die
    /// Zahl kommt vom Formatter, das Kürzel aus dem String-Katalog.
    static func ct(_ c: Double?) -> String {
        guard let c, c.isFinite else { return none }
        return String(localized: "\(number(c)) ct", comment: "Preis in Cent, z. B. 12,3 ct")
    }

    /// 30 Min., 2 Std. 15 Min. — Dauer aus Stunden.
    static func hours(_ h: Double?) -> String {
        guard let h, h.isFinite else { return none }
        let minutes = Int((h * 60).rounded())
        return Duration.seconds(minutes * 60)
            .formatted(.units(allowed: [.hours, .minutes], width: .narrow).locale(locale))
    }

    /// Euro mit Vorzeichen: +3,21 €, −0,84 €
    static func signedEuro(_ e: Double?) -> String {
        guard let e, e.isFinite else { return none }
        if abs(e) < 0.005 { return euro(0) }
        return e.formatted(.currency(code: "EUR").sign(strategy: .always()).locale(locale))
    }

    static func number(_ v: Double?, digits: Int = 1) -> String {
        guard let v, v.isFinite else { return none }
        return v.formatted(.number.precision(.fractionLength(digits)).locale(locale))
    }

    /// Ganze Zahl ohne Tausendertrennung (Kennungen, Codes).
    static func plain(_ n: Int) -> String { String(n) }

    static func time(_ d: Date) -> String {
        d.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
    }

    static func dateTime(_ d: Date) -> String {
        if Calendar.current.isDateInToday(d) { return String(localized: "heute \(time(d))", comment: "Zeitpunkt heute, z. B. heute 14:05") }
        return d.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale))
    }

    /// Kurzes Datum mit Uhrzeit (Widgets, wenn der Stand nicht von heute ist).
    static func shortDateTime(_ d: Date) -> String {
        d.formatted(Date.FormatStyle(date: .numeric, time: .shortened).locale(locale))
    }

    /// „Heute“, „Gestern“, „Morgen“ in der Gerätesprache (Foundation), sonst Wochentag und Datum.
    static func day(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) || cal.isDateInYesterday(d) || cal.isDateInTomorrow(d) {
            let f = DateFormatter()
            f.locale = locale
            f.dateStyle = .medium
            f.timeStyle = .none
            f.doesRelativeDateFormatting = true
            let s = f.string(from: d)
            return s.prefix(1).uppercased() + s.dropFirst()
        }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).locale(locale))
    }
}
