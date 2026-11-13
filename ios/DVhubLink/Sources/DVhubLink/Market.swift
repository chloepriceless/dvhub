// Market.swift — öffentliche Daten von dvhub.online tolerant lesen:
// Day-Ahead-Preise, Residuallast-Frühwarnung (Prognose, Bilanz) und Nachrichten.
// Schema: https://dvhub.online/openapi.json (Stand 13.11.2026). Die App ruft
// diese Dienste direkt per HTTPS ab — nicht über die Box.
//
// Preise kommen in EUR/MWh; die Oberfläche rechnet in ct/kWh (÷ 10).

import Foundation

// MARK: - Marktzeit

public enum MarketTime {
    /// Die Börse (Gebotszone DE-LU) rechnet in deutscher Ortszeit — Tagesgrenzen
    /// folgen ihr, nicht der Zeitzone des Handys.
    public static let zone = TimeZone(identifier: "Europe/Berlin") ?? .current

    public static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = zone
        c.locale = Locale(identifier: "de_DE")
        c.firstWeekday = 2
        return c
    }()

    /// „2026-11-15“ → Mitternacht deutscher Zeit.
    public static func day(_ key: String) -> Date? {
        let p = key.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3, key.count == 10 else { return nil }
        return calendar.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }

    public static func key(_ d: Date) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    public static func startOfDay(_ d: Date) -> Date { calendar.startOfDay(for: d) }
}

// MARK: - Day-Ahead-Preise (/api/prices)

public enum OnlinePrices {
    /// `data[]` mit `ts` (ISO) und `price` (EUR/MWh). Reihenfolge und doppelte
    /// Zeitstempel sind egal; die Slot-Länge folgt aus `resolution` bzw. dem Abstand.
    public static func parse(_ v: JSONValue) -> [PricePoint] {
        var raw: [(Date, Double, Double?)] = []
        for r in v["data"]?.array ?? [] {
            guard let d = parseISODate(r["ts"]?.string), let eur = r["price"]?.number else { continue }
            let len: Double? = switch r["resolution"]?.string {
            case "15min": 900
            case "60min", "1h", "hour": 3600
            default: nil
            }
            raw.append((d, eur, len))
        }
        raw.sort { $0.0 < $1.0 }
        var seen = Set<Date>()
        raw = raw.filter { seen.insert($0.0).inserted }
        let step = Double(PriceSeries.typicalStepMs(raw.map { Int64($0.0.timeIntervalSince1970 * 1000) })) / 1000
        return raw.enumerated().map { i, item in
            var len = item.2 ?? step
            if i + 1 < raw.count { len = min(len, raw[i + 1].0.timeIntervalSince(item.0)) }
            return PricePoint(start: item.0, end: item.0.addingTimeInterval(len), ctKwh: item.1 / 10, importCtKwh: nil)
        }
    }

    /// Slots eines Börsentags (deutsche Ortszeit).
    public static func day(_ points: [PricePoint], _ day: Date) -> [PricePoint] {
        let start = MarketTime.startOfDay(day)
        guard let end = MarketTime.calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        return points.filter { $0.start >= start && $0.start < end }
    }

    /// Günstigstes bzw. teuerstes zusammenhängendes Fenster der Länge `hours`.
    public static func window(_ points: [PricePoint], hours: Double, cheapest: Bool) -> (start: Date, end: Date, averageCt: Double)? {
        guard let first = points.first else { return nil }
        let step = first.end.timeIntervalSince(first.start)
        guard step > 0 else { return nil }
        let n = max(1, Int((hours * 3600 / step).rounded()))
        guard points.count >= n else { return nil }
        var best: (Int, Double)?
        var sum = points[0..<n].reduce(0) { $0 + $1.ctKwh }
        for i in 0...(points.count - n) {
            if i > 0 { sum += points[i + n - 1].ctKwh - points[i - 1].ctKwh }
            // Nur lückenlose Fenster.
            guard abs(points[i + n - 1].end.timeIntervalSince(points[i].start) - Double(n) * step) < 1 else { continue }
            if best == nil || (cheapest ? sum < best!.1 : sum > best!.1) { best = (i, sum) }
        }
        guard let best else { return nil }
        return (points[best.0].start, points[best.0 + n - 1].end, best.1 / Double(n))
    }
}

// MARK: - Residuallast-Frühwarnung (/v1/residual-load/outlook)

public enum PriceClass: String, Sendable, Equatable {
    case cheap = "guenstig", normal, expensive = "teuer"

    public var title: String {
        switch self {
        case .cheap: return "günstig"
        case .normal: return "normal"
        case .expensive: return "teuer"
        }
    }
}

public struct ResidualOutlook: Equatable, Sendable {
    public struct Band: Equatable, Sendable {
        public let p10: Double, p50: Double, p90: Double
    }

    /// Prognosetag. Preise in ct/kWh (Börse, ohne Netzentgelte, Steuern, Abgaben).
    public struct Day: Equatable, Sendable, Identifiable {
        public let key: String
        public let date: Date
        public let leadDays: Int
        public let band: Band
        public let minHourCt: Double?
        public let maxHourCt: Double?
        public let priceClass: PriceClass?
        /// Schwellen der Einstufung (20-%- und 80-%-Quantil der letzten 28 Tage).
        public let p20Ct: Double?
        public let p80Ct: Double?
        public let windGw: Double?
        public let solarGw: Double?
        public let residualMinGw: Double?
        public let residualMeanGw: Double?
        public let residualMaxGw: Double?
        public let backtestMaeCt: Double?
        public var id: String { key }
    }

    /// Tag mit feststehenden Day-Ahead-Preisen, daneben die frühere Prognose.
    public struct KnownDay: Equatable, Sendable, Identifiable {
        public let key: String
        public let date: Date
        public let meanCt: Double
        public let minCt: Double?
        public let maxCt: Double?
        public let earlierP50Ct: Double?
        public let earlierClass: PriceClass?
        public let earlierLeadDays: Int?
        public var id: String { key }
    }

    public struct Hour: Equatable, Sendable, Identifiable {
        public let start: Date
        /// nil: Stunde mit festem Börsenpreis (dann `knownCt`).
        public let band: Band?
        public let knownCt: Double?
        /// Frühere Prognose für eine inzwischen feste Stunde.
        public let earlierP50Ct: Double?
        public let residualGw: Double?
        public let windGw: Double?
        public let solarGw: Double?
        public let loadGw: Double?
        public var id: Date { start }
        /// Mitte der Prognose bzw. fester Preis.
        public var ct: Double? { knownCt ?? band?.p50 }
    }

    public struct DariusDay: Equatable, Sendable, Identifiable {
        public let key: String
        public let date: Date
        /// guenstig | normal | erhoeht | hoch
        public let ampel: String
        public let peakGw: Double?
        public let priceCt: Double?
        public var id: String { key }

        public var title: String {
            switch ampel {
            case "guenstig": return "günstig"
            case "erhoeht": return "erhöht"
            default: return ampel
            }
        }
    }

    public struct Source: Equatable, Sendable, Identifiable {
        public let name: String
        public let url: String?
        public let license: String?
        public var id: String { name }
    }

    public var issuedAt: Date?
    public var weatherRun: Date?
    public var serverStale = false
    public var modelVersion: String?
    public var method: String?
    public var disclaimer: String?
    public var classificationRule: String?
    public var priceLevelBasis: String?
    public var attribution: String?
    public var days: [Day] = []
    public var knownDays: [KnownDay] = []
    /// Stunden: erst die festen Tage, dann die Prognose — lückenlos sortiert.
    public var hours: [Hour] = []
    public var dariusLabel: String?
    public var dariusRule: String?
    public var darius: [DariusDay] = []
    public var sources: [Source] = []

    /// Wie auf der Webseite: älter als 18 Stunden gilt als überholt.
    public func isStale(now: Date = Date()) -> Bool {
        if serverStale { return true }
        guard let issuedAt else { return true }
        return now.timeIntervalSince(issuedAt) > 18 * 3600
    }

    /// Stunden eines Börsentags.
    public func hours(on key: String) -> [Hour] {
        guard let start = MarketTime.day(key), let end = MarketTime.calendar.date(byAdding: .day, value: 1, to: start) else { return [] }
        return hours.filter { $0.start >= start && $0.start < end }
    }

    /// Die `n` günstigsten bzw. teuersten Stunden eines Tages laut Prognose (▼/▲).
    public func extremeHours(on key: String, count n: Int = 4, cheapest: Bool) -> [Hour] {
        let h = hours(on: key).filter { $0.ct != nil }
        let sorted = h.sorted { cheapest ? $0.ct! < $1.ct! : $0.ct! > $1.ct! }
        return Array(sorted.prefix(n)).sorted { $0.start < $1.start }
    }

    /// Nächster als teuer eingestufter Prognosetag (für die Frühwarnung).
    public var nextExpensiveDay: Day? { days.first { $0.priceClass == .expensive } }
    public var nextCheapDay: Day? { days.first { $0.priceClass == .cheap } }

    static func ct(_ v: JSONValue?) -> Double? { v?.number.map { $0 / 10 } }

    static func band(_ v: JSONValue?) -> Band? {
        guard let p50 = ct(v?["p50"]) else { return nil }
        return Band(p10: ct(v?["p10"]) ?? p50, p50: p50, p90: ct(v?["p90"]) ?? p50)
    }

    public static func from(_ v: JSONValue) -> ResidualOutlook? {
        guard v.object != nil, v["days"]?.array != nil else { return nil }
        var o = ResidualOutlook()
        o.issuedAt = parseISODate(v["issued_at"]?.string) ?? parseLooseISO(v["issued_at"]?.string)
        o.weatherRun = parseISODate(v["weather_run_utc"]?.string)
        o.serverStale = v["stale"]?.bool ?? false
        o.modelVersion = v["model_version"]?.string
        o.method = v["method"]?.string
        o.disclaimer = v["disclaimer"]?.string
        o.classificationRule = v["classification_rule"]?.string
        o.priceLevelBasis = v["price_level_basis"]?.string
        o.attribution = v["attribution"]?.string
        o.days = (v["days"]?.array ?? []).compactMap { d in
            guard let key = d["date"]?.string, let date = MarketTime.day(key), let band = band(d["price_eur_mwh"]) else { return nil }
            return Day(key: key, date: date, leadDays: Int(d["lead_days"]?.number ?? 0), band: band,
                       minHourCt: ct(d["price_eur_mwh"]?["min_hour_p50"]), maxHourCt: ct(d["price_eur_mwh"]?["max_hour_p50"]),
                       priceClass: d["classification"]?["class"]?.string.flatMap(PriceClass.init(rawValue:)),
                       p20Ct: ct(d["classification"]?["p20"]), p80Ct: ct(d["classification"]?["p80"]),
                       windGw: d["wind_gw_mean"]?.number, solarGw: d["solar_gw_mean"]?.number,
                       residualMinGw: d["residual_load_gw"]?["min"]?.number, residualMeanGw: d["residual_load_gw"]?["mean"]?.number,
                       residualMaxGw: d["residual_load_gw"]?["max"]?.number, backtestMaeCt: ct(d["backtest_mae_eur_mwh"]))
        }.sorted { $0.date < $1.date }
        var hours: [Date: Hour] = [:]
        for d in v["known_days"]?.array ?? [] {
            guard let key = d["date"]?.string, let date = MarketTime.day(key), let mean = ct(d["price_eur_mwh"]?["mean"]) else { continue }
            let ef = d["earlier_forecast"]
            o.knownDays.append(KnownDay(key: key, date: date, meanCt: mean, minCt: ct(d["price_eur_mwh"]?["min"]), maxCt: ct(d["price_eur_mwh"]?["max"]),
                                        earlierP50Ct: ct(ef?["price_eur_mwh"]?["p50"]),
                                        earlierClass: ef?["classification"]?["class"]?.string.flatMap(PriceClass.init(rawValue:)),
                                        earlierLeadDays: ef?["lead_days"]?.number.map { Int($0) }))
            var earlier: [Date: Double] = [:]
            for h in ef?["hours"]?.array ?? [] {
                if let t = parseISODate(h["ts"]?.string), let p = ct(h["p50"]) { earlier[t] = p }
            }
            for h in d["hours"]?.array ?? [] {
                guard let t = parseISODate(h["ts"]?.string), let p = ct(h["price_eur_mwh"]) else { continue }
                hours[t] = Hour(start: t, band: nil, knownCt: p, earlierP50Ct: earlier[t], residualGw: nil, windGw: nil, solarGw: nil, loadGw: nil)
            }
        }
        o.knownDays.sort { $0.date < $1.date }
        for h in v["hours"]?.array ?? [] {
            guard let t = parseISODate(h["ts"]?.string), hours[t] == nil else { continue }
            hours[t] = Hour(start: t, band: band(h["price_eur_mwh"]), knownCt: nil, earlierP50Ct: nil,
                            residualGw: h["residual_load_gw"]?.number, windGw: h["wind_gw"]?.number,
                            solarGw: h["solar_gw"]?.number, loadGw: h["load_gw"]?.number)
        }
        o.hours = hours.values.sorted { $0.start < $1.start }
        let dar = v["explorativ"]?["darius"]
        o.dariusLabel = dar?["label"]?.string
        o.dariusRule = dar?["rule"]?.string
        o.darius = (dar?["days"]?.array ?? []).compactMap { d in
            guard let key = d["date"]?.string, let date = MarketTime.day(key), let ampel = d["ampel"]?.string else { return nil }
            return DariusDay(key: key, date: date, ampel: ampel, peakGw: d["rl_peak_gw"]?.number, priceCt: ct(d["price_mean_eur_mwh"]))
        }.sorted { $0.date < $1.date }
        o.sources = (v["sources"]?.array ?? []).compactMap { s in
            guard let name = s["name"]?.string else { return nil }
            return Source(name: name, url: s["url"]?.string, license: s["license"]?.string)
        }
        return o
    }
}

/// ISO-Zeit mit mehr als drei Nachkommastellen („…00.002349Z“), die
/// ISO8601DateFormatter nicht liest: Bruchteil abschneiden.
public func parseLooseISO(_ s: String?) -> Date? {
    guard let s else { return nil }
    if let d = parseISODate(s) { return d }
    guard let dot = s.firstIndex(of: ".") else { return nil }
    let tail = s[dot...].drop { $0 == "." || $0.isNumber }
    return parseISODate(String(s[..<dot]) + tail)
}

// MARK: - Bilanz der Frühwarnung (/v1/residual-load/score)

public struct ResidualScore: Equatable, Sendable {
    public struct Metrics: Equatable, Sendable {
        public var maeCt: Double?
        public var classAccuracy: Double?
        public var expensiveRecall: Double?
        public var storageCapture: Double?
        public var bandCoverage: Double?

        static func from(_ v: JSONValue?) -> Metrics {
            Metrics(maeCt: v?["mae_eur_mwh"]?.number.map { $0 / 10 }, classAccuracy: v?["class_accuracy"]?.number,
                    expensiveRecall: v?["expensive_recall"]?.number, storageCapture: v?["storage_capture"]?.number,
                    bandCoverage: v?["band_coverage"]?.number)
        }
    }

    public struct Lead: Equatable, Sendable, Identifiable {
        public let leadDays: Int
        /// Live gezählte Tage seit Start der Bilanz.
        public let liveDays: Int
        public let lowData: Bool
        public let live: Metrics
        public let backtest: Metrics
        public var id: Int { leadDays }
        /// Solange live zu wenige Tage vorliegen, zählt der Rückblick.
        public var shown: Metrics { lowData ? backtest : live }
    }

    public struct Comparison: Equatable, Sendable, Identifiable {
        public struct Row: Equatable, Sendable, Identifiable {
            public let leadDays: Int
            public let liveDays: Int
            public let ours: Metrics
            public let other: Metrics
            public var id: Int { leadDays }
        }
        public let key: String
        public let label: String
        public let note: String?
        public let url: String?
        /// Nur zum Vergleich, nicht Teil der Prüfung (EpexPredictor, Darius-Nachbau).
        public let explorative: Bool
        public let rows: [Row]
        public var id: String { key }
        public var hasLiveData: Bool { rows.contains { $0.liveDays > 0 } }
    }

    public var since: String?
    public var rule: String?
    public var lowDataDays: Int?
    public var backtestPeriod: String?
    public var definitions: [String: String] = [:]
    public var leads: [Lead] = []
    public var comparisons: [Comparison] = []

    public static func from(_ v: JSONValue) -> ResidualScore? {
        guard v.object != nil, let leads = v["leads"]?.array else { return nil }
        var s = ResidualScore()
        s.since = v["since"]?.string
        s.rule = v["rule"]?.string
        s.lowDataDays = v["low_data_days"]?.number.map { Int($0) }
        s.backtestPeriod = v["backtest"]?["period"]?.string
        for (k, d) in v["definitions"]?.object ?? [:] { if let t = d.string { s.definitions[k] = t } }
        s.leads = leads.compactMap { l in
            guard let lead = l["lead_days"]?.number else { return nil }
            return Lead(leadDays: Int(lead), liveDays: Int(l["n_days"]?.number ?? 0), lowData: l["low_data"]?.bool ?? true,
                        live: .from(l), backtest: .from(l["backtest"]))
        }.sorted { $0.leadDays < $1.leadDays }
        s.comparisons = (v["comparisons"]?.object ?? [:]).compactMap { key, c in
            guard let label = c["label"]?.string else { return nil }
            let rows = (c["leads"]?.array ?? []).compactMap { l -> Comparison.Row? in
                guard let lead = l["lead_days"]?.number else { return nil }
                return .init(leadDays: Int(lead), liveDays: Int(l["n_days"]?.number ?? 0), ours: .from(l["ours"]), other: .from(l["other"] ?? l["eos"]))
            }.sorted { $0.leadDays < $1.leadDays }
            return Comparison(key: key, label: label, note: c["note"]?.string, url: c["url"]?.string,
                              explorative: c["explorative"]?.bool ?? true, rows: rows)
        }.sorted { ($0.explorative ? 1 : 0, $0.key) < ($1.explorative ? 1 : 0, $1.key) }
        return s
    }
}

// MARK: - Nachrichten (/api/news)

public struct NewsItem: Equatable, Sendable, Identifiable, Codable {
    public let title: String
    public let excerpt: String
    public let link: String
    public let source: String
    public let publishedAt: Date?
    public let image: String?
    public var id: String { link }

    /// Nur https — fremde Bilder und Artikel nie unverschlüsselt laden.
    public var linkURL: URL? { Self.httpsURL(link) }
    public var imageURL: URL? { image.flatMap(Self.httpsURL) }

    static func httpsURL(_ s: String) -> URL? {
        guard let u = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines)), u.scheme?.lowercased() == "https", u.host?.isEmpty == false else { return nil }
        return u
    }
}

public struct NewsPage: Equatable, Sendable {
    public let items: [NewsItem]
    public let total: Int
    public let offset: Int
    public let available: Bool

    public static func from(_ v: JSONValue) -> NewsPage? {
        guard v.object != nil, let rows = v["items"]?.array else { return nil }
        var seen = Set<String>()
        let items = rows.compactMap { r -> NewsItem? in
            guard let title = r["title"]?.string.map(clean), !title.isEmpty, let link = r["link"]?.string,
                  NewsItem.httpsURL(link) != nil, seen.insert(link).inserted else { return nil }
            var excerpt = clean(r["excerpt"]?.string ?? "")
            if excerpt == title { excerpt = "" }
            return NewsItem(title: title, excerpt: excerpt, link: link, source: clean(r["source_name"]?.string ?? ""),
                            publishedAt: parseISODate(r["published_at"]?.string), image: r["image"]?.string)
        }
        return NewsPage(items: items, total: Int(v["total"]?.number ?? Double(items.count)),
                        offset: Int(v["offset"]?.number ?? 0), available: v["available"]?.bool ?? true)
    }

    /// RSS-Texte: HTML-Reste, Zeichenreferenzen und Leerraum glätten.
    static func clean(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        for (a, b) in [("&amp;", "&"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "), ("&shy;", "")] {
            t = t.replacingOccurrences(of: a, with: b)
        }
        return t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
