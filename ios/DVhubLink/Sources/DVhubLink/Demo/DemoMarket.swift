// DemoMarket.swift — öffentliche Daten für die Demo: Day-Ahead-Preise,
// Preisprognose der nächsten Tage und Beispielmeldungen, in der Form von
// dvhub.online (siehe Market.swift). Die App liest sie mit demselben Code wie
// die echten Antworten — nur kommt hier nichts aus dem Netz.
//
// Die Preise sind dieselben, mit denen die Demo-Anlage rechnet (DemoWorld):
// Was der Markt zeigt, passt zu Fahrplan, Historie und Leitstand.

import Foundation

public struct DemoMarket: Sendable {
    public let world: DemoWorld

    public init(world: DemoWorld) { self.world = world }

    /// Antwort auf einen Abruf bei dvhub.online; nil = diesen Dienst kennt die Demo nicht.
    public func respond(path: String, query: [String: String] = [:], now: Date = Date()) -> JSONValue? {
        switch path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) {
        case "api/prices":
            let today = MarketTime.startOfDay(now)
            let start = parseISODate(query["start"]) ?? today
            let end = parseISODate(query["end"]) ?? MarketTime.dayEnd(MarketTime.dayEnd(today))
            return prices(from: start, to: end)
        case "api/prices/tomorrow-status": return ["status": "available"]
        case "v1/residual-load/outlook": return outlook(now: now)
        case "api/news": return news(limit: Int(query["limit"] ?? "") ?? 30, offset: Int(query["offset"] ?? "") ?? 0, now: now)
        default: return nil
        }
    }

    static func iso(_ d: Date) -> String { d.formatted(Date.ISO8601FormatStyle()) }
    static func eurMwh(_ ct: Double) -> JSONValue { .double((ct * 100).rounded() / 10) }

    // MARK: Day-Ahead-Preise

    /// Viertelstunden von `start` bis `end` (höchstens zehn Tage).
    public func prices(from start: Date, to end: Date) -> JSONValue {
        var rows: [JSONValue] = []
        var t = Date(timeIntervalSince1970: (start.timeIntervalSince1970 / 900).rounded(.up) * 900)
        let last = min(end, start.addingTimeInterval(10 * 86_400))
        while t < last {
            rows.append(["ts": .string(Self.iso(t)), "price": Self.eurMwh(world.spotCt(at: t)), "resolution": "15min"])
            t = t.addingTimeInterval(900)
        }
        return ["data": .array(rows), "bzn": "DE-LU", "demo": true]
    }

    // MARK: Preisprognose der nächsten Tage

    struct DayStats {
        let start: Date
        let key: String
        /// Stundenmittel in ct/kWh.
        let hours: [(Date, Double)]
        var mean: Double { hours.isEmpty ? 0 : hours.reduce(0) { $0 + $1.1 } / Double(hours.count) }
        var low: Double { hours.map(\.1).min() ?? 0 }
        var high: Double { hours.map(\.1).max() ?? 0 }
    }

    /// Börsentag (deutsche Zeit) in Stundenmitteln.
    func stats(_ start: Date) -> DayStats {
        let end = MarketTime.dayEnd(start)
        var hours: [(Date, Double)] = []
        var t = start
        while t < end {
            let quarter = (0..<4).map { world.spotCt(at: t.addingTimeInterval(Double($0) * 900)) }
            hours.append((t, quarter.reduce(0, +) / 4))
            t = t.addingTimeInterval(3600)
        }
        return DayStats(start: start, key: MarketTime.key(start), hours: hours)
    }

    static func quantile(_ sorted: [Double], _ q: Double) -> Double {
        guard let first = sorted.first, let last = sorted.last else { return 0 }
        let pos = q * Double(sorted.count - 1)
        let i = Int(pos.rounded(.down))
        guard i + 1 < sorted.count else { return last }
        return i < 0 ? first : sorted[i] + (sorted[i + 1] - sorted[i]) * (pos - Double(i))
    }

    static func priceClass(_ mean: Double, p20: Double, p80: Double) -> String {
        mean < p20 ? PriceClass.cheap.rawValue : (mean > p80 ? PriceClass.expensive.rawValue : PriceClass.normal.rawValue)
    }

    public func outlook(now: Date) -> JSONValue {
        let cal = MarketTime.calendar
        let today = MarketTime.startOfDay(now)
        func start(_ offset: Int) -> Date { cal.date(byAdding: .day, value: offset, to: today) ?? today.addingTimeInterval(Double(offset) * 86_400) }

        // Üblicher Bereich: 20-%- und 80-%-Quantil der Tagesmittel der letzten vier Wochen.
        let recent = (1...28).map { stats(start(-$0)).mean }.sorted()
        let p20 = Self.quantile(recent, 0.2), p80 = Self.quantile(recent, 0.8)

        /// Abweichung einer Prognose `lead` Tage im Voraus vom späteren Börsenpreis (fest je Tag).
        func bias(_ s: DayStats, lead: Int) -> Double {
            let n = world.day(containing: s.start.addingTimeInterval(43_200)).number
            return 1 + (DemoWorld.unit(n, 21) - 0.5) * 0.045 * Double(lead)
        }

        let known: [JSONValue] = [0, 1].map { offset in
            let s = stats(start(offset))
            let b = bias(s, lead: 2)
            return [
                "date": .string(s.key),
                "price_eur_mwh": ["mean": Self.eurMwh(s.mean), "min": Self.eurMwh(s.low), "max": Self.eurMwh(s.high)],
                "hours": .array(s.hours.map { ["ts": .string(Self.iso($0.0)), "price_eur_mwh": Self.eurMwh($0.1)] }),
                "earlier_forecast": [
                    "lead_days": 2, "price_eur_mwh": ["p50": Self.eurMwh(s.mean * b)],
                    "classification": ["class": .string(Self.priceClass(s.mean * b, p20: p20, p80: p80))],
                    "hours": .array(s.hours.map { ["ts": .string(Self.iso($0.0)), "p50": Self.eurMwh($0.1 * b)] }),
                ],
            ]
        }

        var days: [JSONValue] = [], hours: [JSONValue] = []
        for lead in 2...8 {
            let s = stats(start(lead))
            let b = bias(s, lead: lead)
            let d = world.day(containing: s.start.addingTimeInterval(43_200))
            let mean = s.mean * b
            let band = 0.6 + 0.3 * Double(lead)
            // Wind, Sonne und Last im Netz — passend zum Preisniveau des Tages.
            let wind = max(3, 34 - 32 * (d.priceLevel - 0.62) / 0.98)
            let solar = d.weather * (6 + 26 * d.season)
            let load = d.isWeekend ? 46.0 : 55.0
            let residual = load - wind - solar * 0.35
            days.append([
                "date": .string(s.key), "lead_days": .int(Int64(lead)),
                "price_eur_mwh": ["p10": Self.eurMwh(mean - band), "p50": Self.eurMwh(mean), "p90": Self.eurMwh(mean + band),
                                  "min_hour_p50": Self.eurMwh(s.low * b), "max_hour_p50": Self.eurMwh(s.high * b)],
                "classification": ["class": .string(Self.priceClass(mean, p20: p20, p80: p80)), "p20": Self.eurMwh(p20), "p80": Self.eurMwh(p80)],
                "wind_gw_mean": DemoPlant.num(wind, 1), "solar_gw_mean": DemoPlant.num(solar * 0.3, 1),
                "residual_load_gw": ["min": DemoPlant.num(residual - 9, 1), "mean": DemoPlant.num(residual, 1), "max": DemoPlant.num(residual + 11, 1)],
                "backtest_mae_eur_mwh": DemoPlant.num(9 + 2.5 * Double(lead), 1),
            ])
            for (i, h) in s.hours.enumerated() {
                let p50 = h.1 * b
                let spread = 0.8 + 0.4 * Double(lead) + 0.06 * abs(p50)
                let sun = DemoWorld.bump(Double(i), 12.5, 2.6) * solar
                hours.append([
                    "ts": .string(Self.iso(h.0)),
                    "price_eur_mwh": ["p10": Self.eurMwh(p50 - spread), "p50": Self.eurMwh(p50), "p90": Self.eurMwh(p50 + spread)],
                    "residual_load_gw": DemoPlant.num(load - wind - sun, 1), "wind_gw": DemoPlant.num(wind, 1),
                    "solar_gw": DemoPlant.num(sun, 1), "load_gw": DemoPlant.num(load, 1),
                ])
            }
        }

        // Die Prognose kommt alle drei Stunden neu.
        let issued = Date(timeIntervalSince1970: floor(now.timeIntervalSince1970 / 10_800) * 10_800)
        return [
            "issued_at": .string(Self.iso(issued)), "weather_run_utc": .string(Self.iso(issued.addingTimeInterval(-5400))),
            "stale": false, "model_version": "demo", "days": .array(days), "known_days": .array(known), "hours": .array(hours),
            "sources": [],
        ]
    }

    // MARK: Beispielmeldungen

    struct Sample {
        let source: String
        /// Systemsymbol als Bild der Meldung.
        let symbol: String
        let title: String
        let excerpt: String
        /// Uhrzeit der Meldung und wie viele Tage sie zurückliegt.
        let hour: Double
        let daysAgo: Int
    }

    /// Meldungen der Demo. Sie sind als Beispiele gekennzeichnet (Quelle) und
    /// erklären, was es in der Demo zu sehen gibt — keine echte Redaktion wird nachgeahmt.
    static var samples: [Sample] {
        let market = L("Beispiel · Markt"), practice = L("Beispiel · Praxis"), tech = L("Beispiel · Technik")
        return [
            Sample(source: market, symbol: "sun.max.trianglebadge.exclamationmark.fill", title: L("Sonniger Mittag drückt den Börsenpreis ins Minus"),
                   excerpt: L("An sonnigen Tagen fällt der Day-Ahead-Preis um die Mittagszeit unter null. Die Demo-Anlage lädt dann den Akku und setzt die Einspeisung aus – zu sehen im Markt und im Leitstand."),
                   hour: 7.2, daysAgo: 0),
            Sample(source: practice, symbol: "battery.100percent.bolt", title: L("Abendspitze: Wann sich Einspeisen aus dem Akku lohnt"),
                   excerpt: L("Am frühen Abend ist Strom an der Börse am teuersten. Der Fahrplan zeigt, wie viel Akku dafür frei ist – und was für die Nacht bleiben muss."),
                   hour: 11.75, daysAgo: 0),
            Sample(source: tech, symbol: "exclamationmark.octagon.fill", title: L("Not-Halt in zwei Schritten: So bleibt die Anlage in der Hand"),
                   excerpt: L("Unter Mehr → Steuern hält DVhub alle eigenen Vorgaben an. In der Demo lässt sich das gefahrlos ausprobieren: Geschaltet wird nichts."),
                   hour: 16.3, daysAgo: 1),
            Sample(source: practice, symbol: "bolt.car.fill", title: L("E-Auto: Mindest-Ladestand zur Abfahrt, der Rest wenn es günstig ist"),
                   excerpt: L("Mit Wochenplan und Einmal-Ziel plant DVhub das Laden um Preise und Sonne herum. „Sofort laden“ geht jederzeit und ist im Energiefluss sofort zu sehen."),
                   hour: 9.4, daysAgo: 1),
            Sample(source: market, symbol: "wind", title: L("Residuallast: Was die Ampel der nächsten Tage sagt"),
                   excerpt: L("Wenig Wind und wenig Sonne machen Strom teuer. Die Tageskarten im Markt zeigen, wo das Tagesmittel im üblichen Bereich der letzten vier Wochen liegt."),
                   hour: 18.1, daysAgo: 2),
            Sample(source: tech, symbol: "square.grid.2x2.fill", title: L("Widgets und Sperrbildschirm: Akkustand auf einen Blick"),
                   excerpt: L("Akku, Erzeugung, Netz und Tagesergebnis stehen als Widget bereit – in der Demo mit den Werten der Beispielanlage."),
                   hour: 8.0, daysAgo: 2),
            Sample(source: practice, symbol: "chart.bar.xaxis", title: L("Historie lesen: Autarkie, Eigenverbrauch und das Ergebnis des Tages"),
                   excerpt: L("Tag, Woche, Monat und Jahr zeigen, woher der Strom kam, wohin der Solarstrom ging und was die Anlage verdient oder gekostet hat."),
                   hour: 14.5, daysAgo: 4),
            Sample(source: market, symbol: "arrow.up.arrow.down", title: L("Dynamischer Tarif: Einspeisung und Bezug in einem Bild"),
                   excerpt: L("Balken zeigen, was die Einspeisung bringt, die Linie, was der Bezug kostet. Der Abstand ist die Spanne, mit der ein Akku arbeiten kann."),
                   hour: 10.2, daysAgo: 5),
        ]
    }

    /// Wo „mehr“ zu lesen ist: die öffentliche Nachrichtenseite.
    public static let newsURL = "https://dvhub.online/nachrichten"

    public func news(limit: Int, offset: Int, now: Date) -> JSONValue {
        let today = world.calendar.startOfDay(for: now)
        let all: [JSONValue] = Self.samples.enumerated().map { i, s in
            // Die Meldung erscheint täglich zur selben Uhrzeit: heute, wenn die Zeit schon erreicht ist, sonst gestern.
            var at = today.addingTimeInterval(s.hour * 3600)
            if at > now { at = at.addingTimeInterval(-86_400) }
            at = at.addingTimeInterval(-Double(s.daysAgo) * 86_400)
            return ["title": .string(s.title), "excerpt": .string(s.excerpt), "link": .string("\(Self.newsURL)?beispiel=\(i + 1)"),
                    "source_name": .string(s.source), "published_at": .string(Self.iso(at)), "image": .string(NewsItem.symbolPrefix + s.symbol)]
        }.sorted { ($0["published_at"]?.string ?? "") > ($1["published_at"]?.string ?? "") }
        let page = Array(all.dropFirst(max(0, offset)).prefix(max(0, limit)))
        return ["items": .array(page), "total": .int(Int64(all.count)), "offset": .int(Int64(max(0, offset))), "available": true, "demo": true]
    }
}
