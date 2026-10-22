// HistoryView.swift — Tagesverlauf aus /api/telemetry/series (nur lesend).

import SwiftUI
import Charts
import DVhubLink

struct HistoryView: View {
    let controller: SystemController
    @State private var width: CGFloat = 0
    @State private var day: Day = .today
    @State private var points: [SeriesPoint] = []
    @State private var loading = false
    @State private var error: String?

    enum Day: String, CaseIterable, Identifiable {
        case today = "Heute", yesterday = "Gestern"
        var id: String { rawValue }
    }

    static let powerKeys = ["pv_total_w", "load_power_w", "self_consumption_w", "grid_import_w", "grid_export_w", "battery_power_w"]
    static let socKey = "battery_soc_pct"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Picker("Tag", selection: $day) {
                    ForEach(Day.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                if let error {
                    StaleBanner(text: error)
                }
                if width >= 760 {
                    HStack(alignment: .top, spacing: 16) {
                        powerChart.frame(maxWidth: .infinity)
                        socChart.frame(maxWidth: .infinity)
                    }
                } else {
                    powerChart
                    socChart
                }
            }
            .padding()
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { width = g.size.width }
                    .onChange(of: g.size.width) { _, w in width = w }
            })
        }
        .overlay { if loading && points.isEmpty { ProgressView() } }
        .navigationTitle("Verlauf")
        .refreshable { await load() }
        .task(id: TaskKey(day: day, online: controller.isOnline)) { await load() }
    }

    struct TaskKey: Equatable { let day: Day; let online: Bool }

    private var powerSeries: [(String, String, Color)] {
        let load = points.contains { $0.key == "load_power_w" } ? "load_power_w" : "self_consumption_w"
        return [("pv_total_w", "PV", .yellow), (load, "Haus", .orange), ("grid_import_w", "Bezug", .red),
                ("grid_export_w", "Einspeisung", .blue)]
    }

    private var powerChart: some View {
        Tile(title: "Leistung", icon: "bolt.fill", tint: .yellow) {
            Chart {
                ForEach(powerSeries, id: \.0) { key, label, _ in
                    ForEach(points.filter { $0.key == key }) { p in
                        LineMark(x: .value("Zeit", p.date), y: .value("kW", p.value / 1000))
                            .foregroundStyle(by: .value("Reihe", label))
                            .interpolationMethod(.monotone)
                    }
                }
            }
            .chartForegroundStyleScale(domain: powerSeries.map(\.1), range: powerSeries.map(\.2))
            .chartYAxisLabel("kW")
            .chartXAxis { HourAxis.marks }
            .frame(height: 220)
        }
    }

    private var socChart: some View {
        Tile(title: "Akku-Ladestand", icon: "battery.75percent", tint: .green) {
            Chart(points.filter { $0.key == Self.socKey }) { p in
                AreaMark(x: .value("Zeit", p.date), y: .value("%", p.value))
                    .foregroundStyle(.green.opacity(0.25))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Zeit", p.date), y: .value("%", p.value))
                    .foregroundStyle(.green)
                    .interpolationMethod(.monotone)
            }
            .chartYScale(domain: 0...100)
            .chartYAxisLabel("%")
            .chartXAxis { HourAxis.marks }
            .frame(height: 220)
        }
    }

    private func load() async {
        guard controller.isOnline else {
            if points.isEmpty { error = "Der Verlauf braucht eine Verbindung zur Anlage." }
            return
        }
        loading = true
        defer { loading = false }
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let start = day == .today ? today : cal.date(byAdding: .day, value: -1, to: today)!
        let end = cal.date(byAdding: .day, value: 1, to: start)!
        let keys = (Self.powerKeys + [Self.socKey]).joined(separator: ",")
        let path = "/api/telemetry/series?keys=\(keys)&start=\(enc(ISO.string(start)))&end=\(enc(ISO.string(end)))&maxResolution=900"
        do {
            let r = try await controller.request("GET", path)
            guard r.status == 200, let rows = r.body["data"]?.array else {
                error = "Verlauf nicht verfügbar (\(r.body["error"]?.string ?? "HTTP \(r.status)"))."
                return
            }
            points = rows.compactMap { row in
                guard let key = row["key"]?.string, let d = ISO.parse(row["ts"]?.string), let v = row["value"]?.double else { return nil }
                return SeriesPoint(key: key, date: d, value: v)
            }
            error = points.isEmpty ? "Für diesen Tag liegen keine Messwerte vor." : nil
        } catch {
            self.error = (error as? LinkError)?.description ?? error.localizedDescription
        }
    }

    private func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
    }
}
