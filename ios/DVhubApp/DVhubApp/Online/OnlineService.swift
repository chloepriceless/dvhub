// OnlineService.swift — öffentliche Dienste von dvhub.online (Day-Ahead-Preise,
// Residuallast-Frühwarnung, Nachrichten). Direkt per HTTPS, nicht über die Box.
// Es geht nichts Persönliches mit: keine Cookies, keine Kennung, keine Anlagendaten.

import Foundation
import Observation
import DVhubLink

enum Online {
    static let base = URL(string: "https://dvhub.online")!
    static let maxBytes = 2 * 1024 * 1024

    enum Failure: Error { case status(Int), tooLarge, notJSON }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 15
        c.timeoutIntervalForResource = 30
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.httpAdditionalHeaders = ["Accept": "application/json", "User-Agent": "DVhub-iOS"]
        return URLSession(configuration: c)
    }()

    static func get(_ path: String, query: [URLQueryItem] = []) async throws -> JSONValue {
        var comps = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        let (data, resp) = try await session.data(from: comps.url!)
        guard let http = resp as? HTTPURLResponse else { throw Failure.notJSON }
        guard http.statusCode == 200 else { throw Failure.status(http.statusCode) }
        guard data.count <= maxBytes else { throw Failure.tooLarge }
        guard let v = try? JSONValue.decode(data) else { throw Failure.notJSON }
        return v
    }

    static func message(_ error: Error) -> String {
        switch error {
        case Failure.status(let s): return String(localized: "dvhub.online antwortet mit HTTP \(s).")
        case Failure.tooLarge, Failure.notJSON: return String(localized: "Unerwartete Antwort von dvhub.online.")
        default:
            if (error as NSError).domain == NSURLErrorDomain { return String(localized: "dvhub.online ist gerade nicht erreichbar.") }
            return String(localized: "Abruf fehlgeschlagen.")
        }
    }

    // Zwischenspeicher: letzte gute Antwort je Dienst, damit die Ansicht auch
    // ohne Netz etwas zeigt (mit Zeitangabe).
    private static func cacheURL(_ name: String) -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("online-\(name).json")
    }

    static func cached(_ name: String) -> (JSONValue, Date)? {
        guard let url = cacheURL(name), let data = try? Data(contentsOf: url), let v = try? JSONValue.decode(data),
              let at = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date else { return nil }
        return (v, at)
    }

    static func store(_ name: String, _ v: JSONValue) {
        guard let url = cacheURL(name), let data = try? v.encoded() else { return }
        try? data.write(to: url, options: .atomic)
    }
}

// MARK: - Markt

@MainActor
@Observable
final class MarketStore {
    private(set) var prices: [PricePoint] = []
    private(set) var pricesAt: Date?
    private(set) var tomorrowStatus: String?
    private(set) var outlook: ResidualOutlook?
    private(set) var outlookAt: Date?
    private(set) var loading = false
    private(set) var priceError: String?
    private(set) var outlookError: String?

    init() {
        if let (v, at) = Online.cached("prices") { prices = OnlinePrices.parse(v); pricesAt = at }
        if let (v, at) = Online.cached("outlook") { outlook = ResidualOutlook.from(v); outlookAt = at }
    }

    func prices(on day: Date) -> [PricePoint] { OnlinePrices.day(prices, day) }
    var today: Date { MarketTime.startOfDay(Date()) }
    var tomorrow: Date { MarketTime.calendar.date(byAdding: .day, value: 1, to: today) ?? today }
    var hasTomorrow: Bool { prices(on: tomorrow).count >= 20 }
    var currentPrice: PricePoint? { PriceSeries.current(prices) }

    /// Abrufen, wenn die Daten älter sind als `maxAge` Sekunden (oder `force`).
    func refresh(force: Bool = false, maxAge: TimeInterval = 600) async {
        guard !loading else { return }
        let stalePrices = force || pricesAt.map { Date().timeIntervalSince($0) > maxAge } ?? true
            || prices(on: today).isEmpty
        let staleOutlook = force || outlookAt.map { Date().timeIntervalSince($0) > max(maxAge, 1800) } ?? true
        guard stalePrices || staleOutlook else { return }
        loading = true
        defer { loading = false }
        if stalePrices { await loadPrices() }
        if staleOutlook { await loadOutlook() }
    }

    private func loadPrices() async {
        // Gestern bis übermorgen 00:00 (deutsche Zeit): gestern für den Rückblick,
        // morgen, sobald die Auktion durch ist (~13 Uhr).
        let cal = MarketTime.calendar
        let start = cal.date(byAdding: .day, value: -1, to: today) ?? today
        let end = cal.date(byAdding: .day, value: 2, to: today) ?? today
        let iso = ISO8601DateFormatter()
        do {
            let v = try await Online.get("api/prices", query: [
                URLQueryItem(name: "start", value: iso.string(from: start)),
                URLQueryItem(name: "end", value: iso.string(from: end)),
            ])
            let parsed = OnlinePrices.parse(v)
            guard !parsed.isEmpty else { priceError = String(localized: "dvhub.online liefert gerade keine Preise."); return }
            prices = parsed
            pricesAt = Date()
            priceError = nil
            Online.store("prices", v)
        } catch {
            priceError = Online.message(error)
        }
        if let st = try? await Online.get("api/prices/tomorrow-status") {
            tomorrowStatus = st["status"]?.string
        }
    }

    private func loadOutlook() async {
        do {
            let v = try await Online.get("v1/residual-load/outlook")
            guard let o = ResidualOutlook.from(v) else { outlookError = String(localized: "Unerwartete Antwort von dvhub.online."); return }
            outlook = o
            outlookAt = Date()
            outlookError = nil
            Online.store("outlook", v)
        } catch {
            outlookError = Online.message(error)
        }
    }
}

// MARK: - Nachrichten

@MainActor
@Observable
final class NewsStore {
    private(set) var items: [NewsItem] = []
    private(set) var total = 0
    private(set) var loading = false
    private(set) var error: String?
    private(set) var loadedAt: Date?
    /// Zeitpunkt der neuesten Meldung, die schon gesehen wurde (für den Punkt am Reiter).
    private(set) var lastSeen: Date? = UserDefaults.standard.object(forKey: "news.lastSeen") as? Date
    static let pageSize = 30

    init() {
        if let (v, at) = Online.cached("news"), let p = NewsPage.from(v) { items = p.items; total = p.total; loadedAt = at }
    }

    var hasMore: Bool { items.count < total }
    var unseenCount: Int {
        guard let lastSeen else { return 0 }
        return items.filter { ($0.publishedAt ?? .distantPast) > lastSeen }.count
    }

    func markSeen() {
        guard let newest = items.compactMap(\.publishedAt).max(), newest != lastSeen else { return }
        lastSeen = newest
        UserDefaults.standard.set(newest, forKey: "news.lastSeen")
    }

    func refresh(force: Bool = false) async {
        if !force, let loadedAt, Date().timeIntervalSince(loadedAt) < 900, !items.isEmpty { return }
        await load(offset: 0)
    }

    func loadMore() async {
        guard hasMore, !loading else { return }
        await load(offset: items.count)
    }

    private func load(offset: Int) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let v = try await Online.get("api/news", query: [
                URLQueryItem(name: "limit", value: String(Self.pageSize)),
                URLQueryItem(name: "offset", value: String(offset)),
            ])
            guard let page = NewsPage.from(v), page.available else { error = String(localized: "Die Nachrichten sind gerade nicht verfügbar."); return }
            total = page.total
            if offset == 0 {
                items = page.items
                loadedAt = Date()
                Online.store("news", v)
                if lastSeen == nil { markSeen() }
            } else {
                let known = Set(items.map(\.id))
                let fresh = page.items.filter { !known.contains($0.id) }
                // Kommt nichts Neues, nicht endlos weiterblättern.
                if fresh.isEmpty { total = items.count } else { items += fresh }
            }
            error = nil
        } catch {
            self.error = Online.message(error)
        }
    }
}
