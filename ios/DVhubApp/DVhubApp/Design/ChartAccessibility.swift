// ChartAccessibility.swift — Diagramme für VoiceOver (Audio Graphs).
//
// Swift Charts liest Marken einzeln vor. Mit einem `AXChartDescriptor` kann
// VoiceOver das Diagramm zusätzlich als Ganzes beschreiben und als Tonfolge
// abspielen (Rotor „Audiograph“). Diese Bausteine bauen den Deskriptor aus
// denselben Reihen, die auch gezeichnet werden.

import SwiftUI
import Accessibility

/// Reihen über der Zeit (Linien, Flächen, Preisbalken).
struct TimeSeriesDescriptor: AXChartDescriptorRepresentable {
    struct Series {
        let name: String
        let points: [(Date, Double)]
    }

    let title: String
    var summary: String? = nil
    let yTitle: String
    let series: [Series]
    /// Wert in Worten, z. B. „4,2 kW“.
    let format: (Double) -> String
    /// Mehr Punkte braucht kein Ohr; hält den Deskriptor klein.
    static let maxPoints = 150

    func makeChartDescriptor() -> AXChartDescriptor {
        let thinned = series.map { s -> Series in
            guard s.points.count > Self.maxPoints else { return s }
            let step = Double(s.points.count) / Double(Self.maxPoints)
            return Series(name: s.name, points: (0..<Self.maxPoints).map { s.points[Int(Double($0) * step)] })
        }
        let xs = thinned.flatMap { $0.points.map { $0.0.timeIntervalSince1970 } }
        let ys = thinned.flatMap { $0.points.map(\.1) }
        let x0 = xs.min() ?? 0, x1 = max(xs.max() ?? 1, x0 + 1)
        let y0 = min(0, ys.min() ?? 0), y1 = max(ys.max() ?? 1, y0 + 0.001)
        let xAxis = AXNumericDataAxisDescriptor(title: String(localized: "Zeit"), range: x0...x1, gridlinePositions: []) {
            Format.dateTime(Date(timeIntervalSince1970: $0))
        }
        let yAxis = AXNumericDataAxisDescriptor(title: yTitle, range: y0...y1, gridlinePositions: [], valueDescriptionProvider: format)
        return AXChartDescriptor(title: title, summary: summary, xAxis: xAxis, yAxis: yAxis, additionalAxes: [], series: thinned.map { s in
            AXDataSeriesDescriptor(name: s.name, isContinuous: true, dataPoints: s.points.map { AXDataPoint(x: $0.0.timeIntervalSince1970, y: $0.1) })
        })
    }
}

/// Balken je Zeitraum (Tage einer Woche, Monate eines Jahres).
struct CategoryDescriptor: AXChartDescriptorRepresentable {
    struct Series {
        let name: String
        let values: [Double]
    }

    let title: String
    var summary: String? = nil
    let xTitle: String
    let yTitle: String
    /// Beschriftung je Balken, in Reihenfolge.
    let categories: [String]
    let series: [Series]
    let format: (Double) -> String

    func makeChartDescriptor() -> AXChartDescriptor {
        let ys = series.flatMap(\.values)
        let y0 = min(0, ys.min() ?? 0), y1 = max(ys.max() ?? 1, y0 + 0.001)
        let xAxis = AXCategoricalDataAxisDescriptor(title: xTitle, categoryOrder: categories)
        let yAxis = AXNumericDataAxisDescriptor(title: yTitle, range: y0...y1, gridlinePositions: [], valueDescriptionProvider: format)
        return AXChartDescriptor(title: title, summary: summary, xAxis: xAxis, yAxis: yAxis, additionalAxes: [], series: series.map { s in
            AXDataSeriesDescriptor(name: s.name, isContinuous: false,
                                   dataPoints: zip(categories, s.values).map { AXDataPoint(x: $0.0, y: $0.1) })
        })
    }
}

enum ChartSummary {
    /// „Tief 3,1 ct um 13:00, Hoch 28,4 ct um 18:00.“ — das Wichtigste vorweg.
    static func lowHigh(_ points: [(Date, Double)], format: (Double) -> String) -> String? {
        guard let lo = points.min(by: { $0.1 < $1.1 }), let hi = points.max(by: { $0.1 < $1.1 }) else { return nil }
        return String(localized: "Tief \(format(lo.1)) um \(Format.time(lo.0)), Hoch \(format(hi.1)) um \(Format.time(hi.0)).")
    }
}
