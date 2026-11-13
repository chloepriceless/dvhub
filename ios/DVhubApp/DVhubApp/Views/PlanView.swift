// PlanView.swift — Fahrplan: EOS-Plan aus /api/eos/plan (Pro) und der
// Zeitplan der Steuerung aus /api/schedule. Nur lesend.

import SwiftUI
import Charts
import DVhubLink

struct PlanRow: Identifiable, Equatable {
    let date: Date
    let socPct: Double?
    let pvKw: Double
    let loadKw: Double
    let feedInKw: Double
    let gridKw: Double
    let priceCt: Double?
    let label: String?
    var id: Date { date }
}

struct PlanView: View {
    let controller: SystemController
    @State private var rows: [PlanRow] = []
    @State private var message: String?
    @State private var fetchedAt: Date?
    @State private var schedule: JSONValue?
    @State private var selection: Date?

    var body: some View {
        AuroraPage { width in
            if let message { NoticeBanner(text: message, icon: "info.circle", tint: Brand.violet) }
            if !rows.isEmpty {
                if Layout.isWide(width) {
                    HStack(alignment: .top, spacing: 14) { powerCard; socCard }
                } else {
                    powerCard
                    socCard
                }
                stepsCard
            }
            if let s = schedule { scheduleCard(s) }
        }
        .navigationTitle("Fahrplan")
        .navigationBarTitleDisplayMode(.inline)
        .screenActions(.more, [
            ScreenAction(id: "refresh", title: "Aktualisieren", icon: "arrow.clockwise") { Task { await load() } },
        ])
        .refreshable { await load() }
        .task(id: controller.isOnline) { await load() }
    }

    private var selected: PlanRow? {
        guard let selection else { return nil }
        return rows.last { $0.date <= selection }
    }

    private var powerCard: some View {
        GlassCard(tint: Brand.violet) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Eyebrow(text: "EOS-Plan · Leistung", icon: "calendar.day.timeline.left", tint: Brand.violet)
                    Spacer()
                    if let r = selected {
                        Text("\(Format.dateTime(r.date)) · PV \(Format.number(r.pvKw)) · Haus \(Format.number(r.loadKw)) kW")
                            .font(.caption2.monospacedDigit()).foregroundStyle(Brand.text).lineLimit(1).minimumScaleFactor(0.6)
                    }
                }
                Chart {
                    ForEach(rows) { r in
                        AreaMark(x: .value("Zeit", r.date), y: .value("kW", r.pvKw), series: .value("R", "PV-Fläche"))
                            .interpolationMethod(.monotone)
                            .foregroundStyle(LinearGradient(colors: [Brand.pv.opacity(0.35), Brand.pv.opacity(0.03)], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("Zeit", r.date), y: .value("kW", r.pvKw), series: .value("R", "PV"))
                            .interpolationMethod(.monotone).foregroundStyle(Brand.pv)
                        LineMark(x: .value("Zeit", r.date), y: .value("kW", r.loadKw), series: .value("R", "Haus"))
                            .interpolationMethod(.monotone).foregroundStyle(Brand.home)
                        LineMark(x: .value("Zeit", r.date), y: .value("kW", r.feedInKw), series: .value("R", "Einspeisung"))
                            .interpolationMethod(.monotone).foregroundStyle(Brand.cyan)
                        LineMark(x: .value("Zeit", r.date), y: .value("kW", r.gridKw), series: .value("R", "Bezug"))
                            .interpolationMethod(.monotone).foregroundStyle(Brand.red)
                    }
                    if let r = selected {
                        RuleMark(x: .value("Auswahl", r.date)).foregroundStyle(Brand.text.opacity(0.5)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    }
                }
                .chartXSelection(value: $selection)
                .chartXAxis { PlanAxis() }
                .chartYAxis { PlainYAxis() }
                .frame(height: 200)
                .accessibilityLabel("Geplante Leistung: PV, Haus, Einspeisung, Bezug")
                HStack(spacing: 10) {
                    key(Brand.pv, "PV"); key(Brand.home, "Haus"); key(Brand.cyan, "Einspeisung"); key(Brand.red, "Bezug")
                }
                if let fetchedAt { Text("Plan von \(Format.dateTime(fetchedAt))").font(.caption2).foregroundStyle(Brand.dim) }
            }
        }
    }

    private var socCard: some View {
        GlassCard(tint: Brand.battery) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Eyebrow(text: "Akku und Preis", icon: "battery.75percent", tint: Brand.battery)
                    Spacer()
                    if let r = selected {
                        Text("\(Format.percent(r.socPct))\(r.priceCt.map { " · \(Format.ct($0))" } ?? "")")
                            .font(.caption2.monospacedDigit()).foregroundStyle(Brand.text)
                    }
                }
                Chart {
                    ForEach(rows.filter { $0.socPct != nil }) { r in
                        AreaMark(x: .value("Zeit", r.date), y: .value("%", r.socPct ?? 0))
                            .interpolationMethod(.monotone)
                            .foregroundStyle(LinearGradient(colors: [Brand.battery.opacity(0.3), Brand.battery.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("Zeit", r.date), y: .value("%", r.socPct ?? 0))
                            .interpolationMethod(.monotone).foregroundStyle(Brand.battery).lineStyle(StrokeStyle(lineWidth: 2))
                    }
                    if let r = selected {
                        RuleMark(x: .value("Auswahl", r.date)).foregroundStyle(Brand.text.opacity(0.5)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    }
                }
                .chartXSelection(value: $selection)
                .chartYScale(domain: 0...100)
                .chartXAxis { PlanAxis() }
                .chartYAxis { PlainYAxis() }
                .frame(height: 140)
                .accessibilityLabel("Geplanter Ladestand")
                if rows.contains(where: { $0.priceCt != nil }) {
                    Chart(rows.filter { $0.priceCt != nil }) { r in
                        BarMark(x: .value("Zeit", r.date, unit: .minute, calendar: .current), y: .value("ct", r.priceCt ?? 0), width: .fixed(2))
                            .foregroundStyle((r.priceCt ?? 0) < 0 ? Brand.priceDown : Brand.priceUp.opacity(0.8))
                    }
                    .chartXAxis(.hidden)
                    .chartYAxis { PlainYAxis() }
                    .frame(height: 70)
                    .accessibilityLabel("Preis je Viertelstunde im Plan")
                }
            }
        }
    }

    /// Die nächsten Schritte, in denen der Plan etwas vorgibt.
    @ViewBuilder
    private var stepsCard: some View {
        let steps = rows.filter { $0.label != nil && $0.date >= Date().addingTimeInterval(-900) }
        // Aufeinanderfolgende gleiche Vorgaben zusammenfassen.
        let merged: [(PlanRow, Date)] = steps.reduce(into: []) { acc, r in
            if let last = acc.last, last.0.label == r.label, r.date.timeIntervalSince(last.1) <= 1800 { acc[acc.count - 1].1 = r.date } else { acc.append((r, r.date)) }
        }
        if !merged.isEmpty {
            GlassCard {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow(text: "Was der Plan vorgibt", icon: "list.bullet.rectangle", tint: Brand.violet)
                    RowStack {
                        ForEach(Array(merged.prefix(10).enumerated()), id: \.offset) { _, m in
                            ValueRow(label: m.0.label ?? "", value: "\(Format.dateTime(m.0.date))–\(Format.time(m.1.addingTimeInterval(900)))")
                        }
                    }
                }
            }
        }
    }

    private func scheduleCard(_ s: JSONValue) -> some View {
        let active = s["active"] ?? .null
        let rules = (s["rules"]?.array ?? []).filter { $0["enabled"]?.bool != false }
        let targets = ["gridSetpointW", "minSocPct", "maxDischargeW", "chargeCurrentA"]
        return GlassCard(tint: Brand.yellow) {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: "Zeitplan der Steuerung", icon: "clock.badge.checkmark", tint: Brand.yellow)
                RowStack {
                    ForEach(targets, id: \.self) { t in
                        if let v = active[t]?["value"]?.number {
                            ValueRow(label: "Jetzt: " + IntegrationsView.targetName(t), value: Self.targetValue(t, v),
                                     hint: active[t]?["source"]?.string.map(DetailView.sourceName))
                        }
                    }
                }
                if rules.isEmpty {
                    Text("Keine aktiven Regeln.").font(.footnote).foregroundStyle(Brand.text2).padding(.top, 8)
                } else {
                    Text("\(rules.count) aktive Regel\(rules.count == 1 ? "" : "n")").font(.caption.weight(.bold)).foregroundStyle(Brand.text).padding(.top, 10)
                    RowStack {
                        ForEach(Array(rules.prefix(14).enumerated()), id: \.offset) { _, r in
                            ValueRow(label: "\(r["start"]?.string ?? "–")–\(r["end"]?.string ?? "–")",
                                     value: IntegrationsView.targetName(r["target"]?.string ?? "") + " " + Self.targetValue(r["target"]?.string ?? "", r["value"]?.number),
                                     hint: r["source"]?.string.map(DetailView.sourceName))
                        }
                    }
                    if rules.count > 14 { Text("… und \(rules.count - 14) weitere").font(.caption2).foregroundStyle(Brand.dim).padding(.top, 4) }
                }
            }
        }
    }

    static func targetValue(_ target: String, _ v: Double?) -> String {
        guard let v else { return "–" }
        switch target {
        case "gridSetpointW": return Format.signedPower(v)
        case "maxDischargeW": return v < 0 ? "unbegrenzt" : Format.power(v)
        case "minSocPct": return Format.percent(v)
        case "chargeCurrentA": return "\(Format.number(v, digits: 0)) A"
        default: return Format.number(v, digits: 0)
        }
    }

    private func key(_ c: Color, _ t: String) -> some View {
        HStack(spacing: 4) { Circle().fill(c).frame(width: 7, height: 7); Text(t) }.font(.caption2).foregroundStyle(Brand.text2)
    }

    private func load() async {
        guard controller.isOnline else {
            if rows.isEmpty { message = "Der Fahrplan braucht eine Verbindung zur Anlage." }
            return
        }
        if let r = try? await controller.request("GET", "/api/schedule"), r.status == 200 { schedule = r.body }
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
            // 0, negativ oder fehlend → 15 min (sonst Division durch null).
            let slotRaw = r.body["output"]?["slotMinutes"]?.double ?? 15
            let slotMin = slotRaw.isFinite && slotRaw > 0 ? slotRaw : 15
            let kw = { (wh: Double?) in (wh ?? 0) / (slotMin / 60) / 1000 }
            rows = (r.body["output"]?["rows"]?.array ?? []).compactMap { row in
                guard let d = ISO.parse(row["ts_utc"]?.string) else { return nil }
                return PlanRow(date: d, socPct: row["socPct"]?.double, pvKw: kw(row["pvWh"]?.double), loadKw: kw(row["loadWh"]?.double),
                               feedInKw: kw(row["gridFeedinWh"]?.double), gridKw: kw(row["gridConsumptionWh"]?.double),
                               priceCt: row["priceCtKwh"]?.double, label: row["zeitplanLabel"]?.string)
            }
            fetchedAt = ISO.parse(r.body["plan"]?["fetchedAt"]?.string)
            message = rows.isEmpty ? "Der Plan ist leer." : nil
        } catch {
            message = userMessage(for: error)
        }
    }
}

/// Stundenachse über mehrere Tage: alle 6 h, um Mitternacht der Wochentag.
func PlanAxis() -> some AxisContent {
    AxisMarks(values: .stride(by: .hour, count: 6)) { value in
        AxisGridLine().foregroundStyle(Brand.hairline)
        if let d = value.as(Date.self) {
            AxisValueLabel {
                Text(Calendar.current.component(.hour, from: d) == 0
                     ? d.formatted(.dateTime.weekday(.abbreviated).locale(Format.de))
                     : String(format: "%02d", Calendar.current.component(.hour, from: d)))
                    .font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
            }
        }
    }
}
