// Market.swift — öffentliche Daten von dvhub.online tolerant lesen:
// Day-Ahead-Preise, Preisprognose der nächsten Tage (Residuallast-Frühwarnung)
// und Nachrichten.
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

    /// Beginn des Folgetags — nicht „+ 24 h“: Tage mit Zeitumstellung sind 23 oder 25 Stunden lang.
    public static func dayEnd(_ d: Date) -> Date {
        calendar.date(byAdding: .day, value: 1, to: startOfDay(d)) ?? startOfDay(d).addingTimeInterval(86400)
    }
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
        case .cheap: return L("günstig")
        case .normal: return L("normal")
        case .expensive: return L("teuer")
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

    /// Lage eines Tagesmittels zwischen den Schwellen der Einstufung (P20 = 0,
    /// P80 = 1; kleiner bzw. größer = außerhalb). Die Schwellen kommen aus der
    /// Schnittstelle — vom Tag selbst, sonst vom ersten Prognosetag. Das ist
    /// nur eine Darstellung; die Einstufung bleibt `Day.priceClass`.
    public func position(meanCt: Double, day: Day? = nil) -> Double? {
        guard let t = thresholds(day: day) else { return nil }
        return (meanCt - t.p20) / (t.p80 - t.p20)
    }

    /// Schwellen des üblichen Bereichs in ct/kWh: vom Tag selbst, sonst vom ersten Prognosetag.
    public func thresholds(day: Day? = nil) -> (p20: Double, p80: Double)? {
        let src = (day.flatMap { $0.p20Ct != nil && $0.p80Ct != nil ? $0 : nil }) ?? days.first { $0.p20Ct != nil && $0.p80Ct != nil }
        guard let p20 = src?.p20Ct, let p80 = src?.p80Ct, p80 > p20 else { return nil }
        return (p20, p80)
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
        o.sources = (v["sources"]?.array ?? []).compactMap { s in
            guard let name = s["name"]?.string else { return nil }
            return Source(name: name, url: s["url"]?.string, license: s["license"]?.string)
        }
        return o
    }
}

// MARK: - Tage der Marktansicht

/// Ein Tag der Tagesleiste — fest (Börse) oder Prognose.
public struct MarketDay: Identifiable, Equatable, Sendable {
    public let key: String
    public let date: Date
    public var known: ResidualOutlook.KnownDay?
    public var forecast: ResidualOutlook.Day?
    /// Preise der Börse (nur feste Tage): Viertelstunden aus /api/prices,
    /// ersatzweise die festen Stunden der Prognose-Antwort.
    public var slots: [PricePoint] = []
    /// Die `slots` stammen aus der Prognose-Antwort (Ersatz). Sie können
    /// lückenhaft sein und sind oft Stundenmittel — Tagesmittel und Spanne
    /// kommen dann aus den Tageswerten des Servers, nicht aus diesen Punkten.
    public var slotsAreFallback = false
    /// Lage des Tagesmittels im üblichen Bereich: 0 = untere Schwelle (P20),
    /// 1 = obere (P80) der Prognose; darunter/darüber = außerhalb. Nur Darstellung.
    public var position: Double?
    /// Die Schwellen dazu in ct/kWh (üblicher Bereich), wenn die Prognose sie liefert.
    public var p20Ct: Double?
    public var p80Ct: Double?
    /// Ampel. Prognosetage: die Einstufung der Schnittstelle, unverändert.
    /// Feste Börsentage (heute, morgen) stuft die Schnittstelle nicht ein — für
    /// sie gilt dieselbe Regel auf das echte Tagesmittel der Börse: unter P20
    /// günstig, über P80 teuer, sonst normal (`build`). Ohne Schwellen: keine.
    public var priceClass: PriceClass?
    /// Die Einstufung ist aus Börsenpreisen abgeleitet, nicht aus der Prognose.
    public var classFromExchange: Bool { forecast == nil && priceClass != nil }
    /// Wo im üblichen Bereich das Tagesmittel liegt (für Farbe, Text und Ampel).
    public var zone: PriceBandZone? { position.map(PriceBandZone.init(position:)) }
    public var id: String { key }

    public init(key: String, date: Date, known: ResidualOutlook.KnownDay? = nil, forecast: ResidualOutlook.Day? = nil, slots: [PricePoint] = []) {
        self.key = key
        self.date = date
        self.known = known
        self.forecast = forecast
        self.slots = slots
    }

    public var isFixed: Bool { forecast == nil }
    public var meanCt: Double? {
        if let f = forecast { return f.band.p50 }
        if slotsAreFallback, let k = known { return k.meanCt }
        if let s = PriceSeries.stats(slots) { return s.average }
        return known?.meanCt
    }
    /// Spanne: Band der Prognose bzw. Tagestief bis Tageshoch.
    public var rangeCt: (Double, Double)? {
        if let f = forecast { return (f.band.p10, f.band.p90) }
        if slotsAreFallback, let k = known, let lo = k.minCt, let hi = k.maxCt { return (lo, hi) }
        if let s = PriceSeries.stats(slots) { return (s.min.ctKwh, s.max.ctKwh) }
        if let k = known, let lo = k.minCt, let hi = k.maxCt { return (lo, hi) }
        return nil
    }
    /// Länge eines Preisabschnitts in Sekunden (900 = Viertelstunde, 3600 = Stunde).
    public var slotSeconds: TimeInterval? {
        slots.map { $0.end.timeIntervalSince($0.start) }.filter { $0 > 0 }.min()
    }
    /// Die Preise decken den Tag nur teilweise ab (Ersatz-Stunden mit Lücken).
    public var slotsIncomplete: Bool {
        guard slotsAreFallback, let step = slotSeconds else { return false }
        return Double(slots.count) * step < 23 * 3600
    }

    /// Heute, morgen (sobald fest) und die Prognosetage.
    /// `prices(day)` liefert die Viertelstunden von /api/prices für einen Tag.
    public static func build(today: Date, tomorrow: Date, prices: (Date) -> [PricePoint], outlook: ResidualOutlook?) -> [MarketDay] {
        var out: [String: MarketDay] = [:]
        let todayKey = MarketTime.key(today)
        for d in [today, tomorrow] {
            let slots = prices(d)
            if !slots.isEmpty { out[MarketTime.key(d)] = MarketDay(key: MarketTime.key(d), date: d, slots: slots) }
        }
        for k in outlook?.knownDays ?? [] where k.key >= todayKey {
            var day = out[k.key] ?? MarketDay(key: k.key, date: k.date)
            day.known = k
            // Ohne Viertelstunden von /api/prices: die festen Preise aus der Prognose-Antwort.
            if day.slots.isEmpty {
                day.slots = fallbackSlots(outlook?.hours(on: k.key) ?? [])
                day.slotsAreFallback = !day.slots.isEmpty
            }
            out[k.key] = day
        }
        for f in outlook?.days ?? [] where f.key >= todayKey && out[f.key] == nil {
            out[f.key] = MarketDay(key: f.key, date: f.date, forecast: f)
        }
        return out.values.sorted { $0.date < $1.date }.map { d in
            var d = d
            let t = outlook?.thresholds(day: d.forecast)
            d.p20Ct = t?.p20
            d.p80Ct = t?.p80
            d.position = d.meanCt.flatMap { outlook?.position(meanCt: $0, day: d.forecast) }
            // Prognosetag: nur die Einstufung der Schnittstelle (fehlt sie, bleibt die Ampel aus).
            d.priceClass = d.forecast != nil ? d.forecast?.priceClass : d.position.map(PriceClass.init(position:))
            return d
        }
    }

    /// Feste Preise der Prognose-Antwort als Abschnitte. Die Länge folgt dem
    /// kleinsten Abstand der Zeitstempel (Stunden oder Viertelstunden), nie
    /// mehr als eine Stunde — so überlappen Viertelstunden-Werte nicht.
    static func fallbackSlots(_ hours: [ResidualOutlook.Hour]) -> [PricePoint] {
        let known = hours.filter { $0.knownCt != nil }.sorted { $0.start < $1.start }
        var step: TimeInterval = 3600
        for (a, b) in zip(known, known.dropFirst()) {
            let gap = b.start.timeIntervalSince(a.start)
            if gap > 0 { step = min(step, gap) }
        }
        return known.compactMap { h in
            h.knownCt.map { PricePoint(start: h.start, end: h.start.addingTimeInterval(step), ctKwh: $0, importCtKwh: nil) }
        }
    }
}

extension PriceClass {
    /// Regel der Schnittstelle auf eine Lage angewandt: Tagesmittel unter der
    /// unteren Schwelle (P20) günstig, über der oberen (P80) teuer, sonst normal.
    public init(position p: Double) {
        self = p < 0 ? .cheap : (p > 1 ? .expensive : .normal)
    }
}

/// Lage eines Tagesmittels im üblichen Bereich (P20 … P80) in fünf Stufen —
/// eine Darstellung der Lage, keine zweite Einstufung.
public enum PriceBandZone: String, Sendable, Equatable, CaseIterable {
    /// Unter P20 bzw. über P80.
    case below, above
    /// Im Bereich: unteres Drittel, Mitte, oberes Drittel.
    case low, middle, high

    public init(position p: Double) {
        if p < 0 { self = .below }
        else if p > 1 { self = .above }
        else if p < 1.0 / 3 { self = .low }
        else if p > 2.0 / 3 { self = .high }
        else { self = .middle }
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

// MARK: - Nachrichten (/api/news)

public struct NewsItem: Hashable, Sendable, Identifiable, Codable {
    public let title: String
    public let excerpt: String
    public let link: String
    public let source: String
    public let publishedAt: Date?
    public let image: String?
    public var id: String { link }

    /// Artikel-Link in Safari öffnen: http wie https erlaubt (nutzer-initiiert,
    /// SFSafariViewController; javascript:/data: o. ä. werden abgewiesen). Bilder
    /// dagegen nur https — fremde Bilder nie unverschlüsselt in den App-Prozess laden.
    public var linkURL: URL? { Self.webURL(link) }
    public var imageURL: URL? { image.flatMap(Self.httpsURL) }

    /// Systemsymbol statt eines Bildes („symbol:<Name>“) — so bebildert die Demo
    /// ihre Beispielmeldungen, ohne etwas aus dem Netz zu laden. Nur Namen aus
    /// Buchstaben, Ziffern und Punkten.
    public var symbolName: String? {
        guard let image, image.hasPrefix(Self.symbolPrefix) else { return nil }
        let name = String(image.dropFirst(Self.symbolPrefix.count))
        return !name.isEmpty && name.count <= 60 && name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == ".") }) ? name : nil
    }

    public static let symbolPrefix = "symbol:"

    static func httpsURL(_ s: String) -> URL? {
        guard let u = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines)), u.scheme?.lowercased() == "https", u.host?.isEmpty == false else { return nil }
        return u
    }

    /// http ODER https — für Artikel-Links, die der Nutzer extern in Safari öffnet.
    /// Quellen wie top50-solar liefern http-Links; die Artikel sollen trotzdem
    /// erscheinen (sonst fehlen die neuesten Meldungen in der Liste).
    static func webURL(_ s: String) -> URL? {
        guard let u = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http",
              u.host?.isEmpty == false else { return nil }
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
                  NewsItem.webURL(link) != nil, seen.insert(link).inserted else { return nil }
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
        // &amp; zuletzt: sonst würde aus „&amp;lt;“ erst „&lt;“ und dann „<“.
        for (a, b) in [("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "), ("&shy;", ""), ("&amp;", "&")] {
            t = t.replacingOccurrences(of: a, with: b)
        }
        return t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
