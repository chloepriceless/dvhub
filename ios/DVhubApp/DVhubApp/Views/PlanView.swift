// PlanView.swift — EOS-Fahrplan aus /api/eos/plan (nur lesend).

import SwiftUI
import Charts
import DVhubLink

struct PlanView: View {
    let controller: SystemController
    @State private var rows: [PlanRow] = []
    @State private var message: String?
    @State private var fetchedAt: Date?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let message { StaleBanner(text: message) }
                if !rows.isEmpty {
                    Tile(title: "EOS-Fahrplan", icon: "calendar.day.timeline.left", tint: .purple) {
                        Chart {
                            ForEach(rows) { r in
                                AreaMark(x: .value("Zeit", r.date), y: .value("kW", r.pvKw))
                                    .foregroundStyle(by: .value("Reihe", "PV-Prognose"))
                                    .opacity(0.35)
                                LineMark(x: .value("Zeit", r.date), y: .value("kW", r.feedInKw))
                                    .foregroundStyle(by: .value("Reihe", "Einspeisung"))
                            }
                        }
                        .chartForegroundStyleScale(["PV-Prognose": Color.yellow, "Einspeisung": Color.pink])
                        .chartYAxisLabel("kW")
                        .chartXAxis { HourAxis.marks }
                        .frame(height: 200)
                        Chart(rows.filter { $0.socPct != nil }) { r in
                            LineMark(x: .value("Zeit", r.date), y: .value("%", r.socPct ?? 0))
                                .foregroundStyle(.green)
                        }
                        .chartYScale(domain: 0...100)
                        .chartYAxisLabel("Akku %")
                        .chartXAxis { HourAxis.marks }
                        .frame(height: 140)
                        if let fetchedAt {
                            Text("Plan von \(Format.dateTime(fetchedAt))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Plan")
        .refreshable { await load() }
        .task(id: controller.isOnline) { await load() }
    }

    private func load() async {
        guard controller.isOnline else {
            if rows.isEmpty { message = "Der Plan braucht eine Verbindung zur Anlage." }
            return
        }
        do {
            let r = try await controller.request("GET", "/api/eos/plan?rows=192")
            if r.status == 403 { message = "Der EOS-Plan braucht eine Pro-Lizenz in DVhub."; rows = []; return }
            guard r.status == 200 else { message = "Plan nicht verfügbar (HTTP \(r.status))."; return }
            if r.body["available"]?.bool != true || (r.body["output"]?.isNull ?? true) {
                switch r.body["reason"]?.string {
                case "eos_off": message = "EOS ist ausgeschaltet."
                case "eos_not_answering": message = "EOS antwortet gerade nicht – der Plan erscheint nach dem nächsten Lauf."
                default: message = "Kein EOS-Fahrplan verfügbar."
                }
                rows = []
                return
            }
            let slotMin = r.body["output"]?["slotMinutes"]?.double ?? 15
            let kw = { (wh: Double?) in (wh ?? 0) / (slotMin / 60) / 1000 }
            rows = (r.body["output"]?["rows"]?.array ?? []).compactMap { row in
                guard let d = ISO.parse(row["ts_utc"]?.string) else { return nil }
                return PlanRow(date: d, socPct: row["socPct"]?.double, pvKw: kw(row["pvWh"]?.double), feedInKw: kw(row["gridFeedinWh"]?.double))
            }
            fetchedAt = ISO.parse(r.body["plan"]?["fetchedAt"]?.string)
            message = rows.isEmpty ? "Der Plan ist leer." : nil
        } catch {
            message = (error as? LinkError)?.description ?? error.localizedDescription
        }
    }
}

/// Stundenachse (alle 6 h), um Mitternacht mit Wochentag — kurz genug für schmale Diagramme.
enum HourAxis {
    static var marks: some AxisContent {
        AxisMarks(values: .stride(by: .hour, count: 6)) { value in
            AxisGridLine()
            AxisTick()
            if let d = value.as(Date.self) {
                AxisValueLabel(Calendar.current.component(.hour, from: d) == 0
                    ? d.formatted(.dateTime.weekday(.abbreviated).locale(Format.de))
                    : d.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).locale(Format.de)))
            }
        }
    }
}
