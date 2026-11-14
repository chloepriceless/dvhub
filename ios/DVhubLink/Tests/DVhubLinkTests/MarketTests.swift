// MarketTests.swift — Antwortformen von dvhub.online (abgerufen 13.11.2026,
// gekürzt): Preise, Preisprognose (Residuallast-Frühwarnung), Nachrichten.

import XCTest
@testable import DVhubLink

final class MarketTests: XCTestCase {
    private func json(_ s: String) throws -> JSONValue { try JSONValue.decode(Data(s.utf8)) }

    func testOnlinePricesSortDedupeAndConvertToCt() throws {
        let v = try json("""
        {"zone":"DE-LU","count":4,"data":[
          {"ts":"2026-11-13T00:15:00.000Z","price":143.92,"resolution":"15min"},
          {"ts":"2026-11-13T00:00:00.000Z","price":147.14,"resolution":"15min"},
          {"ts":"2026-11-13T00:15:00.000Z","price":143.92,"resolution":"15min"},
          {"ts":"2026-11-13T00:30:00.000Z","price":-12.5,"resolution":"15min"},
          {"ts":"kaputt","price":1}]}
        """)
        let p = OnlinePrices.parse(v)
        XCTAssertEqual(p.count, 3)
        XCTAssertEqual(p[0].ctKwh, 14.714, accuracy: 1e-9)
        XCTAssertEqual(p[2].ctKwh, -1.25, accuracy: 1e-9)
        XCTAssertEqual(p[2].end.timeIntervalSince(p[2].start), 900)
        XCTAssertTrue(OnlinePrices.parse([:]).isEmpty)
    }

    func testMarketDayFollowsGermanTimeNotDeviceZone() throws {
        // 23:00 UTC am 12.11. ist in Deutschland (Winterzeit) schon der 13.11.
        let t = try XCTUnwrap(parseISODate("2026-11-12T23:00:00Z"))
        XCTAssertEqual(MarketTime.key(t), "2026-11-13")
        XCTAssertEqual(MarketTime.day("2026-11-13"), t)
        XCTAssertNil(MarketTime.day("2026-11"))
        // 25.10.2026: Zeitumstellung, der Tag hat 25 Stunden.
        let dst = try XCTUnwrap(MarketTime.day("2026-10-25"))
        XCTAssertEqual(MarketTime.dayEnd(dst).timeIntervalSince(dst), 25 * 3600)
        XCTAssertEqual(MarketTime.dayEnd(t).timeIntervalSince(t), 24 * 3600)
        let pts = (0..<8).map { i in
            PricePoint(start: t.addingTimeInterval(Double(i - 4) * 900), end: t.addingTimeInterval(Double(i - 3) * 900), ctKwh: Double(i), importCtKwh: nil)
        }
        XCTAssertEqual(OnlinePrices.day(pts, t).map(\.ctKwh), [4, 5, 6, 7])
    }

    func testCheapestAndDearestWindow() throws {
        let t = try XCTUnwrap(parseISODate("2026-11-13T00:00:00Z"))
        let prices: [Double] = [9, 8, 2, 1, 1, 2, 9, 12, 12, 12, 12, 3]
        let pts = prices.enumerated().map { i, c in
            PricePoint(start: t.addingTimeInterval(Double(i) * 900), end: t.addingTimeInterval(Double(i + 1) * 900), ctKwh: c, importCtKwh: nil)
        }
        let cheap = try XCTUnwrap(OnlinePrices.window(pts, hours: 1, cheapest: true))
        XCTAssertEqual(cheap.start, t.addingTimeInterval(2 * 900))
        XCTAssertEqual(cheap.averageCt, 1.5, accuracy: 1e-9)
        let dear = try XCTUnwrap(OnlinePrices.window(pts, hours: 1, cheapest: false))
        XCTAssertEqual(dear.start, t.addingTimeInterval(7 * 900))
        XCTAssertEqual(dear.averageCt, 12, accuracy: 1e-9)
        XCTAssertNil(OnlinePrices.window(Array(pts.prefix(2)), hours: 1, cheapest: true))
    }

    private let outlookJSON = """
    {"area":"DE","issued_at":"2026-11-13T20:15:00.002349Z","stale":false,"model_version":"rl-1.2.0",
     "weather_run_utc":"2026-11-13T12:00:00Z","method":"Wetter → Residuallast","disclaimer":"ohne Gewähr",
     "classification_rule":"teuer/günstig …","units":{"power":"GW","price":"EUR/MWh"},
     "days":[
       {"date":"2026-11-16","hours":24,"lead_days":2,"wind_gw_mean":12.5,"solar_gw_mean":2,
        "price_eur_mwh":{"p10":220,"p50":270.5,"p90":330,"max_hour_p50":340,"min_hour_p50":190},
        "classification":{"p20":160,"p80":260,"class":"teuer"},
        "residual_load_gw":{"max":52.2,"min":30.2,"mean":44.6},"backtest_mae_eur_mwh":20},
       {"date":"2026-11-15","hours":24,"lead_days":1,"wind_gw_mean":29.1,"solar_gw_mean":3,
        "price_eur_mwh":{"p10":141.2,"p50":175.1,"p90":216.2,"max_hour_p50":221.6,"min_hour_p50":134.7},
        "classification":{"p20":157.76,"p80":265.1,"class":"normal"},
        "residual_load_gw":{"max":25.2,"min":9.2,"mean":18.6},"backtest_mae_eur_mwh":18.1}],
     "hours":[
       {"ts":"2026-11-14T23:00:00Z","load_gw":47.71,"wind_gw":22.52,"solar_gw":0,"lead_days":1,
        "price_eur_mwh":{"p10":166.2,"p50":200.1,"p90":241.2},"residual_load_gw":25.19},
       {"ts":"2026-11-15T00:00:00Z","load_gw":46,"wind_gw":23,"solar_gw":0,"lead_days":1,
        "price_eur_mwh":{"p10":100,"p50":120,"p90":150},"residual_load_gw":23},
       {"ts":"2026-11-15T01:00:00Z","load_gw":45,"wind_gw":24,"solar_gw":0,"lead_days":1,
        "price_eur_mwh":{"p10":90,"p50":110,"p90":140},"residual_load_gw":21}],
     "known_days":[
       {"date":"2026-11-14","hours":[{"ts":"2026-11-13T23:00:00Z","price_eur_mwh":146.28},{"ts":"2026-11-14T00:00:00Z","price_eur_mwh":150}],
        "price_eur_mwh":{"mean":197.72,"min":146.28,"max":263.37},
        "earlier_forecast":{"lead_days":1,"price_eur_mwh":{"p50":147.8},"classification":{"p20":160.38,"p80":265.1,"class":"guenstig"},
          "hours":[{"ts":"2026-11-13T23:00:00Z","p10":92.7,"p50":123.7,"p90":162.9}]}}],
     "explorativ":{"darius":{"label":"Nachbau …, explorativ","rule":"Ampel …","days":[
       {"date":"2026-11-15","ampel":"guenstig","hours":24,"lead_days":1,"rl_peak_gw":20.28,"price_mean_eur_mwh":111.2},
       {"date":"2026-11-16","ampel":"erhoeht","hours":24,"lead_days":2,"rl_peak_gw":44.1,"price_mean_eur_mwh":260.18}]}},
     "sources":[{"url":"https://www.ecmwf.int/en/forecasts/datasets/open-data","name":"ECMWF Open Data","license":"CC BY 4.0"}]}
    """

    func testOutlookDaysBandClassificationAndHours() throws {
        let o = try XCTUnwrap(ResidualOutlook.from(try json(outlookJSON)))
        XCTAssertEqual(o.days.map(\.key), ["2026-11-15", "2026-11-16"]) // sortiert
        let d = o.days[0]
        XCTAssertEqual(d.band.p50, 17.51, accuracy: 1e-9)
        XCTAssertEqual(d.band.p10, 14.12, accuracy: 1e-9)
        XCTAssertEqual(d.priceClass, .normal)
        XCTAssertEqual(d.p80Ct ?? 0, 26.51, accuracy: 1e-9)
        XCTAssertEqual(d.residualMeanGw, 18.6)
        XCTAssertEqual(d.backtestMaeCt ?? 0, 1.81, accuracy: 1e-9)
        XCTAssertEqual(o.nextExpensiveDay?.key, "2026-11-16")
        XCTAssertNil(o.nextCheapDay)
        // Ausgabezeit mit Mikrosekunden wird gelesen.
        XCTAssertEqual(o.issuedAt?.timeIntervalSince1970 ?? 0, parseISODate("2026-11-13T20:15:00Z")!.timeIntervalSince1970, accuracy: 0.01)
        XCTAssertFalse(o.isStale(now: parseISODate("2026-11-14T10:00:00Z")!))
        XCTAssertTrue(o.isStale(now: parseISODate("2026-11-14T15:00:00Z")!))
        // Feste Stunden zuerst, dann Prognose; feste Stunde trägt die frühere Prognose.
        XCTAssertEqual(o.hours.count, 5)
        XCTAssertEqual(o.hours[0].knownCt ?? 0, 14.628, accuracy: 1e-9)
        XCTAssertEqual(o.hours[0].earlierP50Ct ?? 0, 12.37, accuracy: 1e-9)
        XCTAssertNil(o.hours[0].band)
        XCTAssertEqual(o.hours[2].band?.p50 ?? 0, 20.01, accuracy: 1e-9)
        XCTAssertEqual(o.hours[2].residualGw, 25.19)
        // 23:00 UTC gehört zum deutschen 15.11.
        XCTAssertEqual(o.hours(on: "2026-11-15").count, 3)
        XCTAssertEqual(o.extremeHours(on: "2026-11-15", count: 1, cheapest: true).first?.ct ?? 0, 11, accuracy: 1e-9)
        XCTAssertEqual(o.extremeHours(on: "2026-11-15", count: 1, cheapest: false).first?.ct ?? 0, 20.01, accuracy: 1e-9)
        let k = try XCTUnwrap(o.knownDays.first)
        XCTAssertEqual(k.meanCt, 19.772, accuracy: 1e-9)
        XCTAssertEqual(k.earlierClass, .cheap)
        XCTAssertEqual(k.earlierP50Ct ?? 0, 14.78, accuracy: 1e-9)
        // Lage im üblichen Bereich (p20 15,776 / p80 26,51 ct): 0 = P20, 1 = P80.
        XCTAssertEqual(o.position(meanCt: 15.776) ?? -1, 0, accuracy: 1e-9)
        XCTAssertEqual(o.position(meanCt: 26.51) ?? -1, 1, accuracy: 1e-9)
        XCTAssertEqual(o.position(meanCt: 17.51, day: o.days[0]) ?? -1, (17.51 - 15.776) / (26.51 - 15.776), accuracy: 1e-9)
        // Schwellen des Tages selbst (zweiter Tag: p20 16 / p80 26 ct), nicht die des ersten.
        XCTAssertEqual(o.position(meanCt: 21, day: o.days[1]) ?? -1, 0.5, accuracy: 1e-9)
        XCTAssertLessThan(o.position(meanCt: 12) ?? 0, 0)
        XCTAssertGreaterThan(o.position(meanCt: 30) ?? 0, 1)
        // Die Einstufung selbst bleibt die der Schnittstelle.
        XCTAssertEqual(o.days[0].priceClass, .normal)
        XCTAssertEqual(o.sources.first?.license, "CC BY 4.0")
    }

    /// Ohne /api/prices: Das Diagramm bekommt die festen Stunden der Prognose-Antwort,
    /// Tagesmittel und Spanne bleiben aber die Tageswerte des Servers.
    func testMarketDaysFallBackToKnownHoursButKeepServerDayValues() throws {
        let o = try XCTUnwrap(ResidualOutlook.from(try json(outlookJSON)))
        let today = try XCTUnwrap(MarketTime.day("2026-11-14"))
        let tomorrow = try XCTUnwrap(MarketTime.day("2026-11-15"))
        let days = MarketDay.build(today: today, tomorrow: tomorrow, prices: { _ in [] }, outlook: o)
        XCTAssertEqual(days.map(\.key), ["2026-11-14", "2026-11-15", "2026-11-16"])
        let d = days[0]
        XCTAssertTrue(d.isFixed)
        XCTAssertTrue(d.slotsAreFallback)
        XCTAssertEqual(d.slots.map(\.ctKwh), [14.628, 15])
        XCTAssertEqual(d.slotSeconds, 3600)
        XCTAssertTrue(d.slotsIncomplete) // nur 2 von 24 Stunden
        // Mittel und Spanne vom Server (197,72 / 146,28 / 263,37 EUR/MWh), nicht aus den 2 Stunden.
        XCTAssertEqual(d.meanCt ?? 0, 19.772, accuracy: 1e-9)
        XCTAssertEqual(d.rangeCt?.0 ?? 0, 14.628, accuracy: 1e-9)
        XCTAssertEqual(d.rangeCt?.1 ?? 0, 26.337, accuracy: 1e-9)
        XCTAssertEqual(d.position ?? -1, (19.772 - 15.776) / (26.51 - 15.776), accuracy: 1e-9)
        XCTAssertFalse(days[1].isFixed)
        XCTAssertEqual(days[1].meanCt ?? 0, 17.51, accuracy: 1e-9)

        // Mit Viertelstunden von /api/prices gelten diese — kein Ersatz.
        let q = (0..<96).map { i in
            PricePoint(start: today.addingTimeInterval(Double(i) * 900), end: today.addingTimeInterval(Double(i + 1) * 900), ctKwh: Double(i % 4), importCtKwh: nil)
        }
        let withPrices = MarketDay.build(today: today, tomorrow: tomorrow, prices: { $0 == today ? q : [] }, outlook: o)
        XCTAssertFalse(withPrices[0].slotsAreFallback)
        XCTAssertEqual(withPrices[0].slots.count, 96)
        XCTAssertEqual(withPrices[0].slotSeconds, 900)
        XCTAssertEqual(withPrices[0].meanCt ?? 0, 1.5, accuracy: 1e-9)
    }

    /// Liefert die Prognose-Antwort Viertelstunden, überlappen die Abschnitte nicht.
    /// Heute und morgen stuft die Schnittstelle nicht ein (die Prognose beginnt
    /// danach). Die Ampel folgt dann derselben Regel aus den Börsenpreisen;
    /// Prognosetage behalten die Einstufung der Schnittstelle.
    func testFixedDaysAreClassifiedFromExchangePrices() throws {
        // Schwellen wie am 14.11.2026: P20 151,21 und P80 265,1 EUR/MWh.
        let o = try XCTUnwrap(ResidualOutlook.from(try json("""
        {"days":[
          {"date":"2026-11-16","lead_days":1,"price_eur_mwh":{"p10":125.3,"p50":160.6,"p90":202.7},"classification":{"p20":151.21,"p80":265.1,"class":"normal"}},
          {"date":"2026-11-17","lead_days":2,"price_eur_mwh":{"p10":175.6,"p50":211.3,"p90":257.2},"classification":{"p20":151.21,"p80":265.1,"class":"normal"}},
          {"date":"2026-11-18","lead_days":3,"price_eur_mwh":{"p10":250,"p50":262,"p90":290},"classification":{"p20":151.21,"p80":265.1,"class":"teuer"}}]}
        """)))
        let today = try XCTUnwrap(MarketTime.day("2026-11-14"))
        let tomorrow = try XCTUnwrap(MarketTime.day("2026-11-15"))
        func flat(_ day: Date, _ ct: Double) -> [PricePoint] {
            (0..<96).map { PricePoint(start: day.addingTimeInterval(Double($0) * 900), end: day.addingTimeInterval(Double($0 + 1) * 900), ctKwh: ct, importCtKwh: nil) }
        }
        var prices: [Date: [PricePoint]] = [today: flat(today, 19.772), tomorrow: flat(tomorrow, 13.97)]
        var days = MarketDay.build(today: today, tomorrow: tomorrow, prices: { prices[$0] ?? [] }, outlook: o)
        XCTAssertEqual(days.map(\.key), ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"])
        // Heute 19,8 ct: im üblichen Bereich → normal, Lage 41 %.
        XCTAssertEqual(days[0].priceClass, .normal)
        XCTAssertTrue(days[0].classFromExchange)
        XCTAssertEqual(days[0].zone, .middle)
        XCTAssertEqual(days[0].p20Ct ?? 0, 15.121, accuracy: 1e-9)
        XCTAssertEqual(days[0].p80Ct ?? 0, 26.51, accuracy: 1e-9)
        // Morgen 14,0 ct: unter P20 (15,1 ct) → günstig.
        XCTAssertEqual(days[1].priceClass, .cheap)
        XCTAssertTrue(days[1].classFromExchange)
        XCTAssertEqual(days[1].zone, .below)
        // Montag 16,06 ct: knapp über P20 → normal, aber nahe günstig (Lage 8 %).
        XCTAssertEqual(days[2].priceClass, .normal)
        XCTAssertFalse(days[2].classFromExchange)
        XCTAssertEqual(days[2].position ?? -1, 0.082, accuracy: 0.001)
        XCTAssertEqual(days[2].zone, .low)
        XCTAssertEqual(days[3].zone, .middle)
        // Prognosetag: die Einstufung der Schnittstelle gilt, auch wenn die Lage (97 %) noch im Bereich liegt.
        XCTAssertEqual(days[4].priceClass, .expensive)
        XCTAssertEqual(days[4].zone, .high)

        // Über P80 (26,51 ct) → teuer; knapp über P20 normal (die Schwelle selbst: testPriceBandZones).
        prices[today] = flat(today, 27)
        prices[tomorrow] = flat(tomorrow, 15.2)
        days = MarketDay.build(today: today, tomorrow: tomorrow, prices: { prices[$0] ?? [] }, outlook: o)
        XCTAssertEqual(days[0].priceClass, .expensive)
        XCTAssertEqual(days[0].zone, .above)
        XCTAssertEqual(days[1].priceClass, .normal)

        // Ohne Prognose gibt es keine Schwellen: keine Ampel, keine Lage.
        let alone = MarketDay.build(today: today, tomorrow: tomorrow, prices: { prices[$0] ?? [] }, outlook: nil)
        XCTAssertEqual(alone.count, 2)
        XCTAssertNil(alone[0].priceClass)
        XCTAssertNil(alone[0].zone)
        XCTAssertFalse(alone[0].classFromExchange)
    }

    func testPriceBandZones() {
        XCTAssertEqual(PriceBandZone(position: -0.01), .below)
        XCTAssertEqual(PriceBandZone(position: 0), .low)
        XCTAssertEqual(PriceBandZone(position: 0.33), .low)
        XCTAssertEqual(PriceBandZone(position: 0.5), .middle)
        XCTAssertEqual(PriceBandZone(position: 0.67), .high)
        XCTAssertEqual(PriceBandZone(position: 1), .high)
        XCTAssertEqual(PriceBandZone(position: 1.01), .above)
        XCTAssertEqual(PriceClass(position: 0), .normal)
        XCTAssertEqual(PriceClass(position: 1), .normal)
        XCTAssertEqual(PriceClass(position: -0.001), .cheap)
        XCTAssertEqual(PriceClass(position: 1.001), .expensive)
    }

    func testFallbackSlotsFollowTimestampSpacing() throws {
        let t0 = try XCTUnwrap(parseISODate("2026-11-14T00:00:00Z"))
        func hour(_ i: Int) -> ResidualOutlook.Hour {
            ResidualOutlook.Hour(start: t0.addingTimeInterval(Double(i) * 900), band: nil, knownCt: Double(i), earlierP50Ct: nil,
                                 residualGw: nil, windGw: nil, solarGw: nil, loadGw: nil)
        }
        let slots = MarketDay.fallbackSlots((0..<8).map(hour))
        XCTAssertEqual(slots.count, 8)
        XCTAssertTrue(slots.allSatisfy { $0.end.timeIntervalSince($0.start) == 900 })
    }

    func testOutlookRejectsForeignShapes() throws {
        XCTAssertNil(ResidualOutlook.from(["error": "nope"]))
        XCTAssertNil(ResidualOutlook.from("text"))
        // Unbekannte Einstufung bleibt nil, der Tag bleibt.
        let o = ResidualOutlook.from(try json(#"{"days":[{"date":"2026-11-15","lead_days":1,"price_eur_mwh":{"p50":100},"classification":{"class":"neu"}}]}"#))
        XCTAssertEqual(o?.days.count, 1)
        XCTAssertNil(o?.days.first?.priceClass)
        XCTAssertEqual(o?.days.first?.band.p10, 10)
        XCTAssertNil(o?.position(meanCt: 10)) // ohne Schwellen keine Lage
        XCTAssertTrue(o?.isStale() ?? false) // ohne Ausgabezeit: überholt
    }

    func testNewsCleansTextAndDropsUnsafeLinks() throws {
        let p = try XCTUnwrap(NewsPage.from(try json("""
        {"available":true,"total":4541,"limit":4,"offset":8,"items":[
          {"title":"Speicher &amp; Netz: <b>neue</b>  Regeln","excerpt":"Kurz&nbsp;gesagt","link":"https://www.pv-magazine.de/a","source_name":"pv magazine","published_at":"2026-11-13T17:44:30.000Z","image":"http://unsicher.example/b.jpg"},
          {"title":"Doppelt","excerpt":"","link":"https://www.pv-magazine.de/a","source_name":"pv magazine","published_at":null,"image":null},
          {"title":"Unsicher","excerpt":"","link":"http://example.org/x","source_name":"x"},
          {"title":"Skript","excerpt":"","link":"javascript:alert(1)","source_name":"x"},
          {"title":"Gleich","excerpt":"Gleich","link":"https://example.org/y","source_name":"y","image":"https://example.org/y.jpg"}]}
        """)))
        XCTAssertEqual(p.total, 4541)
        XCTAssertEqual(p.offset, 8)
        XCTAssertEqual(p.items.map(\.title), ["Speicher & Netz: neue Regeln", "Gleich"])
        XCTAssertEqual(p.items[0].excerpt, "Kurz gesagt")
        XCTAssertNil(p.items[0].imageURL) // http-Bild wird nicht geladen
        XCTAssertEqual(p.items[0].publishedAt, parseISODate("2026-11-13T17:44:30Z"))
        XCTAssertEqual(p.items[1].excerpt, "") // Auszug = Titel → leer
        XCTAssertNotNil(p.items[1].imageURL)
        XCTAssertNil(NewsPage.from(["error": "x"]))
        // Doppelt maskierter Text bleibt Text und wird nicht zu einem Tag.
        XCTAssertEqual(NewsPage.clean("A&amp;lt;b&amp;gt; &amp; B"), "A&lt;b&gt; & B")
    }
}
