// DemoMarketTests.swift — öffentliche Daten der Demo (Preise, Prognose,
// Beispielmeldungen): Die App liest sie mit demselben Code wie die Antworten
// von dvhub.online, und sie passen zu den Preisen, mit denen die Anlage rechnet.

import XCTest
@testable import DVhubLink

final class DemoMarketTests: XCTestCase {
    let start = demoDate(2026, 11, 24, 10)
    var world: DemoWorld { DemoWorld(calendar: demoCalendar(), startedAt: start) }
    var market: DemoMarket { DemoMarket(world: world) }

    func testPricesCoverTodayAndTomorrowInQuarterHours() throws {
        let now = demoDate(2026, 11, 24, 14, 10)
        let today = MarketTime.startOfDay(now)
        let iso = ISO8601DateFormatter()
        let from = today.addingTimeInterval(-86_400), to = today.addingTimeInterval(2 * 86_400)
        let body = try XCTUnwrap(market.respond(path: "api/prices", query: ["start": iso.string(from: from), "end": iso.string(from: to)], now: now))
        let points = OnlinePrices.parse(body)
        XCTAssertEqual(points.count, 3 * 96)
        XCTAssert(points.allSatisfy { $0.end.timeIntervalSince($0.start) == 900 })
        let day = OnlinePrices.day(points, today)
        XCTAssertEqual(day.count, 96)
        XCTAssertEqual(OnlinePrices.day(points, today.addingTimeInterval(86_400 + 3600)).count, 96, "morgen steht schon fest")
        XCTAssertNotNil(PriceSeries.current(points, at: now))
        let stats = try XCTUnwrap(PriceSeries.stats(day))
        // Abendspitze nach 17 Uhr, Tief um die Mittagszeit.
        let cal = MarketTime.calendar
        XCTAssert((17...20).contains(cal.component(.hour, from: stats.max.start)), "Hoch um \(stats.max.start)")
        XCTAssert((11...15).contains(cal.component(.hour, from: stats.min.start)), "Tief um \(stats.min.start)")
        XCTAssert((4...16).contains(stats.average))
        // Dieselben Preise wie in der Anlage (Status der Box).
        var plant = DemoPlant(state: .init(startedAt: start), calendar: demoCalendar())
        let box = PriceSeries.from(status: plant.respond("GET", "/api/status", now: now).body)
        for p in day {
            XCTAssertEqual(box.first { $0.start == p.start }?.ctKwh ?? .nan, p.ctKwh, accuracy: 0.011)
        }
        XCTAssertEqual(market.respond(path: "api/prices/tomorrow-status", now: now)?["status"]?.string, "available")
        XCTAssertNil(market.respond(path: "api/irgendwas", now: now))
    }

    func testOutlookBuildsTheDayCards() throws {
        let now = demoDate(2026, 11, 24, 14, 10)
        let outlook = try XCTUnwrap(ResidualOutlook.from(try XCTUnwrap(market.respond(path: "v1/residual-load/outlook", now: now))))
        XCTAssertFalse(outlook.isStale(now: now))
        XCTAssertEqual(outlook.knownDays.map(\.key), ["2026-11-24", "2026-11-25"])
        XCTAssertEqual(outlook.days.map(\.key), (26...30).map { "2026-11-\($0)" } + ["2026-12-01", "2026-12-02"])
        XCTAssertEqual(outlook.days.map(\.leadDays), Array(2...8))
        let t = try XCTUnwrap(outlook.thresholds())
        XCTAssertLessThan(t.p20, t.p80)
        XCTAssert((3...12).contains(t.p20) && (6...20).contains(t.p80), "üblicher Bereich \(t)")
        for d in outlook.days {
            XCTAssertNotNil(d.priceClass)
            XCTAssertLessThan(d.band.p10, d.band.p50)
            XCTAssertLessThan(d.band.p50, d.band.p90)
            XCTAssertEqual(outlook.hours(on: d.key).count, 24)
            XCTAssert(outlook.hours(on: d.key).allSatisfy { $0.band != nil })
        }
        XCTAssertEqual(outlook.hours(on: "2026-11-24").count, 24)
        XCTAssert(outlook.hours(on: "2026-11-24").allSatisfy { $0.knownCt != nil })

        // Die Tagesleiste des Markts: heute, morgen und sieben Prognosetage — alle mit Lage und Ampel.
        let prices = OnlinePrices.parse(try XCTUnwrap(market.respond(path: "api/prices", now: now)))
        let today = MarketTime.startOfDay(now), tomorrow = MarketTime.dayEnd(today)
        let days = MarketDay.build(today: today, tomorrow: tomorrow, prices: { OnlinePrices.day(prices, $0) }, outlook: outlook)
        XCTAssertEqual(days.count, 9)
        XCTAssertEqual(days.filter(\.isFixed).count, 2)
        XCTAssert(days.allSatisfy { $0.priceClass != nil && $0.position != nil && $0.meanCt != nil })
        XCTAssertEqual(days[0].slots.count, 96)
        // Über vier Wochen kommen günstige, normale und teure Tage vor.
        var seen = Set<String>()
        for offset in 0..<28 {
            let o = try XCTUnwrap(ResidualOutlook.from(market.outlook(now: now.addingTimeInterval(Double(offset) * 86_400))))
            o.days.compactMap(\.priceClass).forEach { seen.insert($0.rawValue) }
        }
        XCTAssertEqual(seen, ["guenstig", "normal", "teuer"])
    }

    func testNewsAreMarkedAsExamples() throws {
        let now = demoDate(2026, 11, 24, 14, 10)
        let page = try XCTUnwrap(NewsPage.from(try XCTUnwrap(market.respond(path: "api/news", query: ["limit": "30", "offset": "0"], now: now))))
        XCTAssertEqual(page.items.count, 8)
        XCTAssertEqual(page.total, 8)
        XCTAssert(page.available)
        XCTAssertEqual(Set(page.items.map(\.id)).count, 8)
        for item in page.items {
            // Je nach Sprache des Testlaufs deutsch oder englisch.
            XCTAssert(item.source.hasPrefix("Beispiel") || item.source.hasPrefix("Example"), "als Beispiel gekennzeichnet: \(item.source)")
            XCTAssertFalse(item.title.isEmpty)
            XCTAssertFalse(item.excerpt.isEmpty)
            XCTAssertEqual(item.linkURL?.host, "dvhub.online")
            XCTAssertNil(item.imageURL, "keine Bilder aus dem Netz")
            XCTAssertNotNil(item.symbolName, "ein Systemsymbol als Bild")
            XCTAssertLessThanOrEqual(try XCTUnwrap(item.publishedAt), now)
        }
        XCTAssertEqual(page.items.map { $0.publishedAt ?? .distantPast }, page.items.map { $0.publishedAt ?? .distantPast }.sorted(by: >), "neueste zuerst")
        XCTAssertGreaterThan(Set(page.items.map(\.source)).count, 1, "mehrere Quellen für den Filter")
        // Zeiten bleiben stehen, solange keine neue Meldung fällig ist (sonst zählte jede Aktualisierung als „neu“).
        let later = try XCTUnwrap(NewsPage.from(market.news(limit: 30, offset: 0, now: now.addingTimeInterval(900))))
        XCTAssertEqual(later.items.map(\.publishedAt), page.items.map(\.publishedAt))
        // Blättern.
        let rest = try XCTUnwrap(NewsPage.from(market.news(limit: 30, offset: 8, now: now)))
        XCTAssert(rest.items.isEmpty)
        XCTAssertEqual(try XCTUnwrap(NewsPage.from(market.news(limit: 3, offset: 6, now: now))).items.count, 2)
    }
}
