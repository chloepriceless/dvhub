// MarketTests.swift — Antwortformen von dvhub.online (abgerufen 13.11.2026,
// gekürzt): Preise, Residuallast-Frühwarnung, Bilanz, Nachrichten.

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
        "classification":{"p20":157.76,"p80":265.1,"class":"teuer"},
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
        XCTAssertEqual(o.darius.map(\.title), ["günstig", "erhöht"])
        XCTAssertEqual(o.darius[1].priceCt ?? 0, 26.018, accuracy: 1e-9)
        XCTAssertEqual(o.sources.first?.license, "CC BY 4.0")
    }

    func testOutlookRejectsForeignShapes() throws {
        XCTAssertNil(ResidualOutlook.from(["error": "nope"]))
        XCTAssertNil(ResidualOutlook.from("text"))
        // Unbekannte Einstufung bleibt nil, der Tag bleibt.
        let o = ResidualOutlook.from(try json(#"{"days":[{"date":"2026-11-15","lead_days":1,"price_eur_mwh":{"p50":100},"classification":{"class":"neu"}}]}"#))
        XCTAssertEqual(o?.days.count, 1)
        XCTAssertNil(o?.days.first?.priceClass)
        XCTAssertEqual(o?.days.first?.band.p10, 10)
        XCTAssertTrue(o?.isStale() ?? false) // ohne Ausgabezeit: überholt
    }

    func testScoreUsesBacktestWhileLiveDataIsThin() throws {
        let s = try XCTUnwrap(ResidualScore.from(try json("""
        {"since":"2026-11-14","low_data_days":14,"rule":"Je Ausgabetag …","definitions":{"mae_eur_mwh":"mittlerer Betrag"},
         "backtest":{"period":"Prüfjahr Nov. 2025 – Nov. 2026"},
         "leads":[
          {"lead_days":2,"n_days":20,"mae_eur_mwh":25,"class_accuracy":0.7,"expensive_recall":0.6,"storage_capture":0.95,"band_coverage":0.81,"low_data":false,
           "backtest":{"mae_eur_mwh":20,"class_accuracy":0.711,"expensive_recall":0.636,"storage_capture":0.961,"band_coverage":0.801}},
          {"lead_days":1,"n_days":0,"mae_eur_mwh":null,"low_data":true,
           "backtest":{"mae_eur_mwh":18.2,"class_accuracy":0.743,"expensive_recall":0.721,"storage_capture":0.966,"band_coverage":0.795}}],
         "comparisons":{
          "epex":{"label":"EpexPredictor (b3nn0)","explorative":true,"note":"Explorativ: nur zum Vergleich","url":"https://github.com/b3nn0/EpexPredictor",
            "leads":[{"lead_days":1,"n_days":3,"ours":{"mae_eur_mwh":18},"other":{"mae_eur_mwh":21}}]},
          "eos_hw":{"label":"EOS-eigene Prognose (Holt-Winters)","explorative":false,
            "leads":[{"lead_days":1,"n_days":0,"ours":{"mae_eur_mwh":null},"other":{"mae_eur_mwh":null}}]}}}
        """)))
        XCTAssertEqual(s.leads.map(\.leadDays), [1, 2])
        XCTAssertEqual(s.leads[0].shown.maeCt ?? 0, 1.82, accuracy: 1e-9) // Rückblick
        XCTAssertEqual(s.leads[1].shown.maeCt ?? 0, 2.5, accuracy: 1e-9)  // live
        XCTAssertEqual(s.leads[1].shown.bandCoverage, 0.81)
        // Geprüfte Vergleiche zuerst, explorative danach und als solche markiert.
        XCTAssertEqual(s.comparisons.map(\.key), ["eos_hw", "epex"])
        XCTAssertTrue(s.comparisons[1].explorative)
        XCTAssertTrue(s.comparisons[1].hasLiveData)
        XCTAssertFalse(s.comparisons[0].hasLiveData)
        XCTAssertEqual(s.comparisons[1].rows[0].other.maeCt ?? 0, 2.1, accuracy: 1e-9)
        XCTAssertNil(ResidualScore.from(["x": 1]))
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
    }
}
