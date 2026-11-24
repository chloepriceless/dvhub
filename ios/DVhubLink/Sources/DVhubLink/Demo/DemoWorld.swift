// DemoWorld.swift — die Welt der Demo-Anlage: Sonne, Wetter, Verbrauch und
// Börsenpreise als reine Funktionen der Zeit.
//
// Nichts hier kommt aus dem Netz, und nichts ist Zufall: Derselbe Zeitpunkt
// ergibt immer dieselben Werte — in der App, im Widget und im Test. So passt
// der Leitstand zur Historie, der Markt zum Fahrplan, und ein Tag sieht morgen
// noch so aus wie heute.
//
// Die Anlage lebt in der Zeitzone des Geräts: Die Sonne der Demo steht, wie
// die Uhr des Handys es erwarten lässt. Die Börsenpreise folgen derselben Uhr
// (Mittagstief unter der Sonne, Abendspitze nach Sonnenuntergang).

import Foundation

public struct DemoWorld: Sendable, Equatable {
    /// Kalender der Anlage (Zeitzone des Geräts).
    public let calendar: Calendar
    /// Von diesem Tag an ist das Wetter freundlich: zwei Tage vor dem Start der
    /// Demo. Wer sie ansieht, soll die Anlage arbeiten sehen — und der Akku soll
    /// am ersten Tag nicht von einer grauen Woche leer sein. Die Tage davor
    /// (Historie) tragen das übliche Wetter der Jahreszeit.
    public let brightFrom: Date?
    /// Tagesnummer, an der die Kette der Tagesläufe beginnt (1. Januar, zwei
    /// Jahre vor dem Start der Demo): Von dort an schließt jeder Tag mit dem
    /// Ladestand an, mit dem der Vortag endete (DemoPlant.startSoc).
    public let origin: Int

    public init(calendar: Calendar = .current, startedAt: Date? = nil) {
        self.calendar = calendar
        self.brightFrom = startedAt.map { calendar.startOfDay(for: $0.addingTimeInterval(-2 * 86_400)) }
        let year = startedAt.map { calendar.component(.year, from: $0) } ?? 2026
        self.origin = Self.civilDays(year: year - 2, month: 1, day: 1)
    }

    // MARK: Tag

    public struct Day: Sendable, Equatable {
        public let start: Date
        public let end: Date
        /// Fortlaufende Nummer des Tages (bürgerlicher Kalender der Anlage).
        public let number: Int
        /// 1 = Montag … 7 = Sonntag.
        public let weekday: Int
        /// 0 = tiefster Winter … 1 = Hochsommer.
        public let season: Double
        /// Wetter: Anteil der Leistung eines wolkenlosen Tages (0 … 1).
        public let weather: Double
        /// Preisniveau an der Börse (Wind, Nachfrage): um 1.
        public let priceLevel: Double
        /// Sonnenaufgang, Tageslänge und höchster Sonnenstand in Stunden seit Mitternacht.
        public let sunrise: Double
        public let dayLength: Double
        public let noon: Double
        /// Leistung der Anlage bei wolkenlosem Himmel am Mittag (kW).
        public let clearPeakKw: Double
        /// Zeitzone der Anlage und ihr Abstand zur Weltzeit am Tagesbeginn (Sekunden).
        let zone: TimeZone
        let offsetAtStart: Int

        public var isWeekend: Bool { weekday >= 6 }
        public var isWorkday: Bool { weekday <= 5 }
        /// Sonnig genug, um das Auto mittags aus der Sonne zu laden.
        public var isSunny: Bool { weather >= 0.6 }
        /// Viertelstunden des Tages (96; bei Zeitumstellung 92 oder 100).
        public var slotCount: Int { max(1, Int((end.timeIntervalSince(start) / 900).rounded())) }

        /// Uhrzeit als Stunden seit Mitternacht — nach der Uhr an der Wand: An
        /// Tagen mit Zeitumstellung springt sie mit (23 bzw. 25 Stunden lang).
        public func hour(of date: Date) -> Double {
            let elapsed = date.timeIntervalSince(start)
            guard end.timeIntervalSince(start) != 86_400 else { return elapsed / 3600 }
            return (elapsed + Double(zone.secondsFromGMT(for: date) - offsetAtStart)) / 3600
        }

        /// Zeitpunkt zu einer Uhrzeit dieses Tages (Stunden seit Mitternacht).
        public func date(atHour hour: Double) -> Date {
            let plain = start.addingTimeInterval(hour * 3600)
            guard end.timeIntervalSince(start) != 86_400 else { return plain }
            return plain.addingTimeInterval(-Double(zone.secondsFromGMT(for: plain) - offsetAtStart))
        }

        /// „HH:MM“ nach der Uhr der Anlage (Tagesende → 00:00).
        public func clock(of date: Date) -> String {
            let minutes = Int((hour(of: date) * 60).rounded())
            return String(format: "%02d:%02d", (minutes / 60) % 24, minutes % 60)
        }
    }

    /// Tage seit dem 1.1.1970 nach dem bürgerlichen Kalender.
    static func civilDays(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /// Gleichverteilte Zahl in 0 ..< 1 — fest für `n` und `salt`.
    static func unit(_ n: Int, _ salt: UInt64) -> Double {
        var z = UInt64(bitPattern: Int64(n)) &* 0x9E37_79B9_7F4A_7C15 &+ salt &* 0xD1B5_4A32_D192_ED03
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Double(z >> 11) / 9_007_199_254_740_992
    }

    static func bump(_ h: Double, _ mu: Double, _ sigma: Double) -> Double {
        let d = (h - mu) / sigma
        return exp(-d * d / 2)
    }

    public func day(containing date: Date) -> Day {
        let start = calendar.startOfDay(for: date)
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start.addingTimeInterval(86_400)
        let c = calendar.dateComponents([.year, .month, .day], from: start)
        let number = Self.civilDays(year: c.year ?? 1970, month: c.month ?? 1, day: c.day ?? 1)
        // 1.1.1970 war ein Donnerstag.
        let weekday = ((number % 7) + 7 + 3) % 7 + 1
        let doy = Double(calendar.ordinality(of: .day, in: .year, for: start) ?? 1)
        let season = (cos(2 * .pi * (doy - 172) / 365.25) + 1) / 2

        // Wetter: im Winter meist grau mit einzelnen klaren Tagen, im Sommer meist freundlich.
        let u = Self.unit(number, 1)
        let low = 0.08 + 0.17 * season
        var weather = low + (1 - low) * pow(u, 2.2 - 1.3 * season)
        if let brightFrom, start >= brightFrom { weather = max(weather, 0.74 + 0.24 * Self.unit(number, 2)) }

        // Preisniveau: mehrtägige Wellen (Wind) plus Tagesrauschen; im Winter höher, am Wochenende niedriger.
        var level = 1.04 + 0.26 * sin(2 * .pi * Double(number) / 8.7 + 1.3) + 0.22 * (Self.unit(number, 3) - 0.5) + 0.10 * (1 - season)
        if weekday >= 6 { level *= 0.9 }
        level = max(0.62, min(1.6, level))

        let dayLength = 7.9 + 8.5 * season
        let dst = calendar.timeZone.daylightSavingTimeOffset(for: start.addingTimeInterval(43_200)) / 3600
        let noon = 12.35 + dst
        return Day(start: start, end: end, number: number, weekday: weekday, season: season, weather: weather, priceLevel: level,
                   sunrise: noon - dayLength / 2, dayLength: dayLength, noon: noon, clearPeakKw: DemoPlant.kwp * (0.40 + 0.36 * season),
                   zone: calendar.timeZone, offsetAtStart: calendar.timeZone.secondsFromGMT(for: start))
    }

    public func day(after day: Day, by days: Int = 1) -> Day {
        // Mittags ansetzen: So landet der Schritt auch über eine Zeitumstellung im richtigen Tag.
        let anchor = day.start.addingTimeInterval(43_200)
        return self.day(containing: calendar.date(byAdding: .day, value: days, to: anchor) ?? anchor.addingTimeInterval(Double(days) * 86_400))
    }

    // MARK: Erzeugung und Verbrauch (kW)

    /// Leistung der Photovoltaik zur Stunde `hour` des Tages.
    public func pvKw(_ day: Day, hour: Double) -> Double {
        let x = (hour - day.sunrise) / day.dayLength
        guard x > 0, x < 1 else { return 0 }
        let shape = pow(sin(.pi * x), 1.25)
        // Wolken: träge Schwankung, bei grauem Himmel stärker.
        let p1 = Self.unit(day.number, 5) * 2 * .pi, p2 = Self.unit(day.number, 6) * 2 * .pi
        let clouds = 1 + (0.10 * sin(hour * 3.1 + p1) + 0.05 * sin(hour * 11.3 + p2)) * (1.25 - day.weather)
        return max(0, day.clearPeakKw * shape * day.weather * clouds)
    }

    /// Verbrauch des Hauses ohne E-Auto: Grundlast, Morgen und Abend, Wärmepumpe, Geräte.
    public func houseKw(_ day: Day, hour: Double) -> Double {
        var kw = 0.26
        if day.isWeekend {
            kw += 0.45 * Self.bump(hour, 8.8, 1.1) + 0.45 * Self.bump(hour, 12.8, 1.1) + 0.80 * Self.bump(hour, 19.0, 1.8)
        } else {
            kw += 0.50 * Self.bump(hour, 7.1, 0.9) + 0.30 * Self.bump(hour, 12.7, 1.0) + 0.85 * Self.bump(hour, 19.3, 1.7)
        }
        kw += heatPumpKw(day, hour: hour)
        // Kochen
        if hour >= 18.25, hour < 18.75 { kw += 1.7 }
        if day.isWeekend, hour >= 12.25, hour < 12.75 { kw += 1.5 }
        // Spülmaschine: mittags oder abends
        let dish = Self.unit(day.number, 7) < 0.5 ? 13.25 : 20.5
        if hour >= dish, hour < dish + 0.5 { kw += 1.9 } else if hour >= dish + 0.5, hour < dish + 1.25 { kw += 0.35 }
        // Waschmaschine: an knapp jedem zweiten Tag
        if Self.unit(day.number, 8) < 0.45 {
            if hour >= 10.5, hour < 11.0 { kw += 2.0 } else if hour >= 11.0, hour < 12.0 { kw += 0.25 }
        }
        return kw
    }

    /// Warmwasser-Wärmepumpe: läuft im Winter öfter (in Takten), im Sommer am Mittag aus der Sonne.
    public func heatPumpKw(_ day: Day, hour: Double) -> Double {
        let winter = 1 - day.season
        let phase = Self.unit(day.number, 4) * 2 * .pi
        var kw = winter * 0.32 * (0.55 + 0.45 * sin(2 * .pi * hour / 2.4 + phase)) * (hour < 6 ? 0.8 : 1)
        if hour >= 12.5, hour < 13.5 { kw += 0.5 * day.season }
        return max(0, kw)
    }

    // MARK: E-Auto

    /// Fahrt an Werktagen von 07:00 bis 08:30; sie kostet diesen Anteil des Akkus.
    public static let evTripPct = 7.0
    public static let evBatteryKwh = 60.0
    public static let evAwayFrom = 7.0, evAwayUntil = 8.5
    static let evNoonStart = 11.5, evNoonKw = 4.2, evNoonHours = 1.0
    static let evNightStart = 2.0, evNightKw = 8.4, evNightHours = 0.5

    /// Ladeleistung, die der Plan für das Auto vorsieht (kW): an sonnigen
    /// Werktagen mittags aus der Sonne, sonst in der Nacht darauf zum günstigen Preis.
    public func evPlanKw(_ day: Day, hour: Double, previous: Day) -> Double {
        if day.isWorkday, day.isSunny, hour >= Self.evNoonStart, hour < Self.evNoonStart + Self.evNoonHours { return Self.evNoonKw }
        if previous.isWorkday, !previous.isSunny, hour >= Self.evNightStart, hour < Self.evNightStart + Self.evNightHours { return Self.evNightKw }
        return 0
    }

    /// Das Auto ist unterwegs (nicht angesteckt).
    public func evAway(_ day: Day, hour: Double) -> Bool {
        day.isWorkday && hour >= Self.evAwayFrom && hour < Self.evAwayUntil
    }

    /// Ladestand des Autos nach Plan, bezogen auf das Ziel `target` (%).
    public func evSocPct(_ day: Day, hour: Double, previous: Day, target: Double) -> Double {
        let trip = Self.evTripPct
        var soc = target
        if previous.isWorkday, !previous.isSunny {
            // Die Fahrt von gestern wird erst in dieser Nacht nachgeladen.
            if hour < Self.evNightStart { soc = target - trip } else if hour < Self.evNightStart + Self.evNightHours {
                soc = target - trip + trip * (hour - Self.evNightStart) / Self.evNightHours
            }
        }
        guard day.isWorkday, hour >= Self.evAwayFrom else { return soc }
        if hour < Self.evAwayUntil { return target - trip * (hour - Self.evAwayFrom) / (Self.evAwayUntil - Self.evAwayFrom) }
        guard day.isSunny, hour >= Self.evNoonStart else { return target - trip }
        return hour < Self.evNoonStart + Self.evNoonHours ? target - trip + trip * (hour - Self.evNoonStart) / Self.evNoonHours : target
    }

    // MARK: Börse und Tarif (ct/kWh)

    /// Aufschläge des dynamischen Tarifs der Demo-Anlage.
    public static let markupCt = 1.5, gridChargesCt = 9.1, leviesCt = 4.2, vatPct = 19.0

    /// Day-Ahead-Preis der Viertelstunde, in der `hour` liegt.
    public func spotCt(_ day: Day, hour: Double) -> Double {
        let slot = Int(floor(hour * 4))
        let h = (Double(slot) + 0.5) / 4
        let base: Double
        if day.isWeekend {
            base = 7.0 + 3.0 * Self.bump(h, 9.0, 1.8) + 8.0 * Self.bump(h, 18.8, 1.8)
        } else {
            base = 7.2 + 5.5 * Self.bump(h, 7.6, 1.5) + 9.5 * Self.bump(h, 18.6, 1.7) + 1.2 * Self.bump(h, 21.5, 2.0)
        }
        // Solarstrom drückt den Preis um die Mittagszeit — an sonnigen Tagen bis unter null,
        // an jedem zweiten Tag (viel Wind dazu) deutlich tiefer.
        let depth = pow(day.weather, 1.2) * (10.5 + 1.5 * day.season) * (day.number % 2 == 0 ? 1.25 : 0.8) * (day.isWeekend ? 1.15 : 1)
        let dip = depth * Self.bump(h, day.noon + 0.6, 0.9 + day.dayLength * 0.05)
        let jitter = (Self.unit(day.number &* 131 &+ slot, 9) - 0.5) * 0.7
        return (max(-13, day.priceLevel * base - dip + jitter) * 100).rounded() / 100
    }

    /// Eigener Bezugspreis brutto: Börse plus Aufschläge, Netzentgelte, Umlagen und Mehrwertsteuer.
    public static func importCt(spot: Double) -> Double {
        ((spot + markupCt + gridChargesCt + leviesCt) * (1 + vatPct / 100) * 100).rounded() / 100
    }

    public func spotCt(at date: Date) -> Double {
        let d = day(containing: date)
        return spotCt(d, hour: d.hour(of: date))
    }

    /// „HH:MM“ eines Zeitpunkts nach der Uhr der Anlage.
    public func clock(_ date: Date) -> String { day(containing: date).clock(of: date) }

    /// Minuten seit Mitternacht nach der Uhr der Anlage.
    public func minuteOfDay(_ date: Date) -> Int {
        Int(day(containing: date).hour(of: date) * 60 + 1e-6)
    }
}
