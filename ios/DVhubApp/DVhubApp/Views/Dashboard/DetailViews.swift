// DetailViews.swift — Detailwerte hinter den Karten des Leitstands: PV, Akku,
// Netz, Haus, Heute (Erlöse/Kosten), Zustand. Live-Werte kommen im
// 2-Sekunden-Takt, Zusatzwerte (Phasen, Flüsse, Zähler) alle 5 s aus
// /api/status, der Tagesverlauf aus /api/telemetry/series.

import SwiftUI
import Charts
import DVhubLink

struct DetailView: View {
    let kind: DetailKind
    let controller: SystemController
    var openHistory: () -> Void = {}
    @State private var day: HistorySummary?

    private var status: LiveStatus { controller.displayStatus ?? LiveStatus() }
    private var detail: StatusDetail { controller.detail ?? StatusDetail() }

    var body: some View {
        AuroraPage(inlineTitle: true) { width in
            if !controller.isOnline {
                NoticeBanner(text: "Keine Verbindung zur Anlage – Detailwerte zeigen den letzten bekannten Stand.")
            }
            switch kind {
            case .pv: pv(width)
            case .battery: battery(width)
            case .grid: grid(width)
            case .home: home(width)
            case .money: money(width)
            case .state: state(width)
            }
        }
        .navigationTitle(title)
        .task(id: controller.isOnline) {
            guard controller.isOnline else { return }
            if case .ok(let s) = await BoxData.history(controller, view: .day, date: Date()) { day = s }
            await controller.refreshToday()
            while !Task.isCancelled && controller.isOnline {
                await controller.refreshDetail()
                try? await Task.sleep(nanoseconds: 5 * 1_000_000_000)
            }
        }
        .accessibilityIdentifier("detail.\(kind.rawValue)")
    }

    private var title: String {
        switch kind {
        case .pv: return "PV"
        case .battery: return String(localized: "Akku")
        case .grid: return String(localized: "Netz")
        case .home: return String(localized: "Haus")
        case .money: return String(localized: "Heute")
        case .state: return String(localized: "Zustand")
        }
    }

    private func series(_ key: String) -> [SeriesPoint] { controller.todayValues(key) }
    private func kpi(_ k: String) -> Double? { day?.kpi(k) }

    // MARK: PV

    @ViewBuilder
    private func pv(_ width: CGFloat) -> some View {
        Hero(eyebrow: String(localized: "Erzeugung jetzt"), icon: "sun.max.fill", tint: Brand.pv, value: Format.power(status.pvTotalW),
             caption: kpi("pvKwh").map { String(localized: "Heute \(Format.energy($0))") })
        DayChartCard(title: String(localized: "Leistung heute"), unit: "kW", tint: Brand.pv, lines: [.init(name: "PV", color: Brand.pv, points: series("pv_total_w"), area: true)])
        columns(width) {
            GlassCard(tint: Brand.pv) {
                VStack(alignment: .leading, spacing: 4) {
                    Eyebrow(text: "Wohin geht der Solarstrom?", icon: "arrow.triangle.branch", tint: Brand.pv)
                    ShareBar(parts: [
                        .init(name: String(localized: "Haus"), value: detail.solarDirectUseW, color: Brand.home),
                        .init(name: String(localized: "Akku"), value: detail.solarToBatteryW, color: Brand.battery),
                        .init(name: String(localized: "Netz"), value: detail.solarToGridW, color: Brand.grid),
                    ], format: Format.power)
                }
            }
            GlassCard {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow(text: "Quellen", icon: "square.stack.3d.up", tint: Brand.text2)
                    RowStack {
                        ValueRow(label: "Gesamt", value: Format.power(detail.pvTotalW ?? status.pvTotalW), tint: Brand.pv)
                        if detail.pvDcW != nil { ValueRow(label: "DC-gekoppelt", value: Format.power(detail.pvDcW), hint: String(localized: "Laderegler am Akku")) }
                        if detail.pvAcW != nil { ValueRow(label: "AC-gekoppelt", value: Format.power(detail.pvAcW), hint: String(localized: "PV-Wechselrichter")) }
                        phases(String(localized: "AC-PV"), detail.pvAcPhasesW)
                        phases(String(localized: "AC-PV 2"), detail.pvAc2PhasesW)
                    }
                }
            }
        }
        if day != nil {
            GlassCard {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow(text: "Heute", icon: "calendar", tint: Brand.text2)
                    RowStack {
                        ValueRow(label: "Erzeugt", value: Format.energy(kpi("pvKwh")), tint: Brand.pv)
                        ValueRow(label: "Direkt verbraucht", value: Format.energy(kpi("solarDirectUseKwh")))
                        ValueRow(label: "In den Akku", value: Format.energy(kpi("solarToBatteryKwh")))
                        ValueRow(label: "Eingespeist", value: Format.energy(kpi("solarToGridKwh")))
                        if let p = peak("pv_total_w") { ValueRow(label: "Spitze", value: "\(Format.power(p.value)) · \(Format.time(p.date))") }
                        if let q = day?.selfUsePct { ValueRow(label: "Eigenverbrauch", value: Format.percent(q), hint: String(localized: "Anteil der Erzeugung, der nicht eingespeist wurde")) }
                        if let c = kpi("curtailedPvKwh"), c > 0.05 { ValueRow(label: "Abgeregelt", value: Format.energy(c), tint: Brand.orange) }
                    }
                }
            }
        }
    }

    // MARK: Akku

    @ViewBuilder
    private func battery(_ width: CGFloat) -> some View {
        let w = status.batteryPowerW
        GlassCard(tint: Brand.battery) {
            HStack(spacing: 18) {
                SocRing(soc: status.soc, minSoc: status.minSocPct ?? detail.minSocPct)
                    .frame(width: 124, height: 124)
                VStack(alignment: .leading, spacing: 6) {
                    Eyebrow(text: "Akku", icon: StatusText.batteryIcon(status.soc), tint: Brand.battery)
                    MetricValue(value: Format.power(w), style: .largeTitle)
                    Pill(text: StatusText.batteryCaption(status), icon: (w ?? 0) > 0 ? "arrow.down.to.line" : ((w ?? 0) < 0 ? "arrow.up.to.line" : "pause"),
                         tint: abs(w ?? 0) < FlowEdge.idleW ? Brand.dim : Brand.battery)
                    if let m = status.minSocPct ?? detail.minSocPct {
                        Text("Min-SoC \(Format.percent(m))").font(.footnote).foregroundStyle(Brand.text2)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .combine)
        DayChartCard(title: String(localized: "Ladestand heute"), unit: "%", tint: Brand.battery, range: 0...100, scale: 1,
                     lines: [.init(name: "SoC", color: Brand.battery, points: series(BoxData.socKey), area: true)],
                     threshold: status.minSocPct ?? detail.minSocPct)
        DayChartCard(title: String(localized: "Leistung heute"), unit: "kW", tint: Brand.battery,
                     lines: [.init(name: String(localized: "Laden (+) / Entladen (−)"), color: Brand.cyan, points: series("battery_power_w"), area: true)])
        columns(width) {
            GlassCard {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow(text: "Jetzt", icon: "bolt", tint: Brand.text2)
                    RowStack {
                        ValueRow(label: "Ladestand", value: Format.percent(status.soc), tint: Brand.battery)
                        ValueRow(label: "Leistung", value: Format.signedPower(w), hint: String(localized: "+ lädt, − entlädt"))
                        ValueRow(label: "Min-SoC", value: Format.percent(status.minSocPct ?? detail.minSocPct), hint: String(localized: "Darunter entlädt DVhub nicht"))
                        if let a = detail.activeMinSocPct { ValueRow(label: "Min-SoC laut Zeitplan", value: Format.percent(a)) }
                        if let m = detail.maxDischargeW {
                            ValueRow(label: "Max. Entladung", value: m < 0 ? String(localized: "unbegrenzt") : (m == 0 ? String(localized: "halten (0 W)") : Format.power(m)))
                        }
                        if let s2 = detail.secondSocPct { ValueRow(label: "Zweiter Akku", value: "\(Format.percent(s2)) · \(Format.signedPower(detail.secondBatteryW))") }
                    }
                }
            }
            GlassCard(tint: Brand.battery) {
                VStack(alignment: .leading, spacing: 8) {
                    if (w ?? 0) >= 0 {
                        Eyebrow(text: "Womit wird geladen?", icon: "arrow.down.to.line", tint: Brand.battery)
                        ShareBar(parts: [.init(name: String(localized: "Solar"), value: detail.solarToBatteryW, color: Brand.pv),
                                         .init(name: String(localized: "Netz"), value: detail.gridToBatteryW, color: Brand.grid)], format: Format.power)
                    } else {
                        Eyebrow(text: "Wohin entlädt der Akku?", icon: "arrow.up.to.line", tint: Brand.battery)
                        ShareBar(parts: [.init(name: String(localized: "Haus"), value: detail.batteryDirectUseW, color: Brand.home),
                                         .init(name: String(localized: "Netz"), value: detail.batteryToGridW, color: Brand.grid)], format: Format.power)
                    }
                }
            }
        }
        if day != nil {
            GlassCard {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow(text: "Heute", icon: "calendar", tint: Brand.text2)
                    RowStack {
                        ValueRow(label: "Geladen", value: Format.energy(kpi("batteryChargeKwh")), tint: Brand.battery)
                        ValueRow(label: "Entladen", value: Format.energy(kpi("batteryDischargeKwh")))
                        ValueRow(label: "davon aus dem Netz geladen", value: Format.energy(kpi("gridToBatteryKwh")))
                        if let c = kpi("cycles") { ValueRow(label: "Zyklen", value: Format.number(c, digits: 2)) }
                        if let lo = series(BoxData.socKey).map(\.value).min(), let hi = series(BoxData.socKey).map(\.value).max() {
                            ValueRow(label: "Ladestand heute", value: "\(Format.percent(lo)) – \(Format.percent(hi))")
                        }
                    }
                }
            }
        }
    }

    // MARK: Netz

    @ViewBuilder
    private func grid(_ width: CGFloat) -> some View {
        let exporting = StatusText.isExporting(status)
        Hero(eyebrow: String(localized: "\(StatusText.gridCaption(status)) jetzt", comment: "z. B. Bezug jetzt / Einspeisung jetzt"), icon: "bolt.horizontal.fill", tint: exporting ? Brand.cyan : Brand.grid,
             value: Format.power(StatusText.gridValue(status)),
             caption: status.gridSetpointW.map { String(localized: "Sollwert \(Format.signedPower($0))") })
        DayChartCard(title: String(localized: "Netz heute"), unit: "kW", tint: Brand.grid, lines: [
            .init(name: String(localized: "Einspeisung"), color: Brand.cyan, points: series("grid_export_w"), area: true),
            .init(name: String(localized: "Bezug"), color: Brand.red, points: series("grid_import_w"), area: true),
        ])
        columns(width) {
            GlassCard {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow(text: "Jetzt", icon: "bolt", tint: Brand.text2)
                    RowStack {
                        ValueRow(label: "Bezug", value: Format.power(status.gridImportW), tint: (status.gridImportW ?? 0) > FlowEdge.idleW ? Brand.red : nil)
                        ValueRow(label: "Einspeisung", value: Format.power(status.gridExportW), tint: (status.gridExportW ?? 0) > FlowEdge.idleW ? Brand.cyan : nil)
                        ValueRow(label: "Sollwert am Netzpunkt", value: Format.signedPower(status.gridSetpointW ?? detail.gridSetpointW),
                                 hint: String(localized: "− heißt: so viel soll eingespeist werden"))
                        if let a = detail.activeSetpointW {
                            ValueRow(label: "Vorgabe von DVhub", value: Format.signedPower(a), hint: detail.activeSetpointSource.map(Self.sourceName))
                        }
                        if let t = detail.gridTotalW {
                            ValueRow(label: "Zähler gesamt", value: Format.signedPower(detail.gridPhaseAsImport(t)), hint: String(localized: "+ Bezug, − Einspeisung"))
                        }
                        phases(String(localized: "Zähler"), detail.gridPhasesW.map { $0.map(detail.gridPhaseAsImport) }, signed: true)
                    }
                }
            }
            VStack(spacing: 14) {
                if detail.gridVoltagesV.contains(where: { $0 != nil }) {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 0) {
                            Eyebrow(text: "Netzspannung", icon: "waveform", tint: Brand.text2)
                            RowStack {
                                ForEach(Array(detail.gridVoltagesV.enumerated()), id: \.offset) { i, v in
                                    if let v { ValueRow(label: "L\(i + 1)", value: "\(Format.number(v)) V") }
                                }
                                if let f = detail.gridFrequencyHz { ValueRow(label: "Frequenz", value: String(localized: "\(Format.number(f, digits: 2)) Hz")) }
                            }
                        }
                    }
                }
                if let c = status.controls, hasControls(c) {
                    GlassCard(tint: Brand.orange) {
                        VStack(alignment: .leading, spacing: 0) {
                            Eyebrow(text: "Begrenzungen", icon: "hand.raised.fill", tint: Brand.orange)
                            RowStack {
                                if c.dv?.curtailed == true { ValueRow(label: "Direktvermarkter regelt ab", value: c.dv?.limitPct.map(Format.percent) ?? String(localized: "aktiv"), tint: Brand.orange) }
                                if c.negativePrice?.active == true { ValueRow(label: "Negativpreis-Schutz", value: String(localized: "aktiv"), tint: Brand.orange) }
                                if let l = c.feedInLimit?.limitW { ValueRow(label: "Einspeisegrenze", value: Format.power(l)) }
                                if c.feedInLimit?.blocked == true { ValueRow(label: "Einspeisung", value: String(localized: "gesperrt"), tint: Brand.orange) }
                                if c.p14a?.active == true { ValueRow(label: "§14a-Begrenzung", value: c.p14a?.limitW.map(Format.power) ?? String(localized: "aktiv"), tint: Brand.orange) }
                            }
                        }
                    }
                }
            }
        }
        GlassCard {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: "Heute", icon: "calendar", tint: Brand.text2)
                RowStack {
                    ValueRow(label: "Bezogen", value: Format.energy(detail.importKwh ?? kpi("importKwh")), tint: Brand.red)
                    ValueRow(label: "Eingespeist", value: Format.energy(detail.exportKwh ?? kpi("exportKwh")), tint: Brand.cyan)
                    if let p = detail.spotNowCtKwh { ValueRow(label: "Börsenpreis jetzt", value: Format.ct(p)) }
                    if let p = detail.importPriceNowCtKwh { ValueRow(label: "Mein Bezugspreis jetzt", value: Format.ct(p)) }
                }
            }
        }
    }

    private func hasControls(_ c: LiveStatus.Controls) -> Bool {
        c.dv?.curtailed == true || c.negativePrice?.active == true || c.feedInLimit?.limitW != nil || c.feedInLimit?.blocked == true || c.p14a?.active == true
    }

    /// Herkunft einer Vorgabe in Worten — unbekannte Kennungen werden nicht angezeigt.
    static func sourceName(_ s: String) -> String {
        switch s {
        case "forecast_optimizer", "optimizer": return String(localized: "aus dem Optimierer")
        case "eos", "eos_plan": return String(localized: "aus dem EOS-Plan")
        case "manual", "manual_write": return String(localized: "von Hand gesetzt")
        case "small_market_automation", "sma": return String(localized: "aus der Börsenautomatik")
        case "default", "default_setpoint": return String(localized: "Standardwert")
        case "schedule", "rule": return String(localized: "aus dem Zeitplan")
        default: return String(localized: "aus der Steuerung")
        }
    }

    // MARK: Haus

    @ViewBuilder
    private func home(_ width: CGFloat) -> some View {
        let loadKey = series("load_power_w").isEmpty ? "self_consumption_w" : "load_power_w"
        Hero(eyebrow: String(localized: "Verbrauch jetzt"), icon: "house.fill", tint: Brand.home, value: Format.power(status.loadW),
             caption: kpi("loadKwh").map { String(localized: "Heute \(Format.energy($0))") })
        GlassCard(tint: Brand.home) {
            VStack(alignment: .leading, spacing: 4) {
                Eyebrow(text: "Woher kommt der Strom?", icon: "arrow.triangle.merge", tint: Brand.home)
                ShareBar(parts: [
                    .init(name: String(localized: "Solar"), value: detail.solarDirectUseW, color: Brand.pv),
                    .init(name: String(localized: "Akku"), value: detail.batteryDirectUseW, color: Brand.battery),
                    .init(name: String(localized: "Netz"), value: detail.gridDirectUseW, color: Brand.grid),
                ], format: Format.power)
            }
        }
        DayChartCard(title: String(localized: "Verbrauch heute"), unit: "kW", tint: Brand.home, lines: [
            .init(name: String(localized: "Haus"), color: Brand.home, points: series(loadKey), area: true),
            .init(name: "PV", color: Brand.pv, points: series("pv_total_w"), area: false),
        ])
        if day != nil {
            GlassCard {
                VStack(alignment: .leading, spacing: 4) {
                    Eyebrow(text: "Heute", icon: "calendar", tint: Brand.text2)
                    ShareBar(parts: [
                        .init(name: String(localized: "Solar"), value: kpi("solarDirectUseKwh"), color: Brand.pv),
                        .init(name: String(localized: "Akku"), value: kpi("batteryDirectUseKwh"), color: Brand.battery),
                        .init(name: String(localized: "Netz"), value: kpi("gridDirectUseKwh"), color: Brand.grid),
                    ], format: Format.energy)
                    RowStack {
                        ValueRow(label: "Verbraucht", value: Format.energy(kpi("loadKwh")), tint: Brand.home)
                        if let a = day?.autarkyPct { ValueRow(label: "Autarkie", value: Format.percent(a), tint: Brand.green, hint: String(localized: "Anteil, der nicht aus dem Netz kam")) }
                        if let p = peak(loadKey) { ValueRow(label: "Spitze", value: "\(Format.power(p.value)) · \(Format.time(p.date))") }
                    }
                }
            }
        }
    }

    // MARK: Heute (Geld)

    @ViewBuilder
    private func money(_ width: CGFloat) -> some View {
        let net = status.todayNetEur ?? detail.netEur
        let tint = (net ?? 0) >= 0 ? Brand.money : Brand.red
        Hero(eyebrow: String(localized: "Heute netto"), icon: "eurosign.circle.fill", tint: tint, value: Format.signedEuro(net),
             caption: (net ?? 0) >= 0 ? String(localized: "verdient") : String(localized: "gekostet"), color: tint)
        columns(width) {
            GlassCard(tint: Brand.money) {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow(text: "Erlöse", icon: "arrow.up.right", tint: Brand.money)
                    MetricValue(value: Format.euro(status.todayRevenueEur ?? detail.revenueEur), color: Brand.money).padding(.vertical, 4)
                    RowStack {
                        ValueRow(label: "Eingespeist", value: Format.energy(detail.exportKwh ?? kpi("exportKwh")))
                        if let v = kpi("exportPvRevenueEur") { ValueRow(label: "aus Solar", value: Format.euro(v)) }
                        if let v = kpi("exportBatteryRevenueEur"), abs(v) > 0.004 { ValueRow(label: "aus dem Akku", value: Format.euro(v)) }
                        if let v = kpi("marketPremiumEur"), abs(v) > 0.004 { ValueRow(label: "Marktprämie", value: Format.euro(v)) }
                        if let p = detail.spotNowCtKwh { ValueRow(label: "Börsenpreis jetzt", value: Format.ct(p)) }
                    }
                }
            }
            GlassCard(tint: Brand.red) {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow(text: "Kosten", icon: "arrow.down.right", tint: Brand.red)
                    MetricValue(value: Format.euro(status.todayCostEur ?? detail.costEur), color: Brand.red).padding(.vertical, 4)
                    RowStack {
                        ValueRow(label: "Bezogen", value: Format.energy(detail.importKwh ?? kpi("importKwh")))
                        if let p = detail.importPriceNowCtKwh { ValueRow(label: "Mein Bezugspreis jetzt", value: Format.ct(p)) }
                        if let v = kpi("avoidedImportGrossEur") { ValueRow(label: "Vermiedener Bezug", value: Format.euro(v), tint: Brand.money, hint: String(localized: "Was der Eigenverbrauch am Netz gekostet hätte")) }
                    }
                }
            }
        }
        if let rows = day?.rows, rows.contains(where: { $0.values["netEur"] != nil }) {
            NetCurveCard(rows: rows)
        }
        Button(action: openHistory) {
            Label("Woche, Monat und Jahr in der Historie", systemImage: "chart.bar.xaxis")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Brand.glassStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Brand.border, lineWidth: 1))
        }
        .buttonStyle(CardButtonStyle())
        Text("Tageswerte nach den Zählern und Preisen in DVhub; die Abrechnung des Direktvermarkters kann abweichen.")
            .font(.caption2).foregroundStyle(Brand.dim)
    }

    // MARK: Zustand

    @ViewBuilder
    private func state(_ width: CGFloat) -> some View {
        let tint = StateLines.color(status)
        GlassCard(tint: tint) {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow(text: "Zustand", icon: "checkmark.shield.fill", tint: tint)
                StateLines(status: status)
            }
        }
        if !detail.alarms.isEmpty || detail.alarmsStale {
            GlassCard(tint: Brand.red) {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow(text: "Alarme der Anlage", icon: "bell.badge.fill", tint: Brand.red)
                    if detail.alarmsStale {
                        Text("Die Alarm-Abfrage ist veraltet – der letzte Stand ist nicht verlässlich.").font(.footnote).foregroundStyle(Brand.orange).padding(.vertical, 6)
                    }
                    RowStack {
                        ForEach(detail.alarms) { a in
                            ValueRow(label: a.label, value: a.severity >= 2 ? String(localized: "Alarm") : String(localized: "Warnung"), tint: a.severity >= 2 ? Brand.red : Brand.orange)
                        }
                    }
                }
            }
        }
        if !detail.warnings.isEmpty {
            GlassCard(tint: Brand.orange) {
                VStack(alignment: .leading, spacing: 8) {
                    Eyebrow(text: "Hinweise von DVhub", icon: "exclamationmark.bubble", tint: Brand.orange)
                    ForEach(detail.warnings, id: \.self) { w in
                        Text(w).font(.footnote).foregroundStyle(Brand.text)
                    }
                }
            }
        }
        GlassCard {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: "Verbindung", icon: "antenna.radiowaves.left.and.right", tint: Brand.text2)
                RowStack {
                    ValueRow(label: "Weg", value: connectionText)
                    ValueRow(label: "DVhub-Version", value: controller.boxVersion ?? status.version ?? "–")
                    ValueRow(label: "Rechte dieses Geräts", value: controller.canControl ? String(localized: "Anzeigen und steuern") : String(localized: "Nur anzeigen"))
                    if let at = controller.displayAt { ValueRow(label: "Letzter Stand", value: Format.dateTime(at)) }
                }
            }
        }
        GlassCard(tint: Brand.violet) {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Meldungen", icon: "bell.badge", tint: Brand.violet)
                if controller.events.isEmpty {
                    Text("Keine Meldungen. Wechsel bei Alarmen und Not-Halt landen hier – auch wenn die App zu war.")
                        .font(.footnote).foregroundStyle(Brand.text2)
                } else {
                    EventList(events: controller.events)
                }
            }
        }
    }

    private var connectionText: String {
        switch controller.state {
        case .online(let k): return k == .lan ? String(localized: "Heimnetz, direkt") : String(localized: "Relay, Ende zu Ende verschlüsselt")
        case .connecting: return String(localized: "verbindet …")
        case .boxOffline: return String(localized: "Anlage nicht erreichbar")
        case .offline: return String(localized: "keine Verbindung")
        case .idle: return String(localized: "getrennt")
        }
    }

    // MARK: Helfer

    private func peak(_ key: String) -> SeriesPoint? { series(key).max { $0.value < $1.value } }

    @ViewBuilder
    private func phases(_ name: String, _ p: [Double?], signed: Bool = false) -> some View {
        if p.contains(where: { $0 != nil }) {
            ForEach(Array(p.enumerated()), id: \.offset) { i, v in
                ValueRow(label: "\(name) L\(i + 1)", value: signed ? Format.signedPower(v) : Format.power(v))
            }
        }
    }

    /// Breit: zwei Spalten nebeneinander, schmal: untereinander.
    @ViewBuilder
    private func columns<A: View, B: View>(_ width: CGFloat, @ViewBuilder _ content: () -> TupleView<(A, B)>) -> some View {
        let c = content().value
        if Layout.isWide(width) {
            HStack(alignment: .top, spacing: 14) { c.0; c.1 }
        } else {
            c.0
            c.1
        }
    }
}

// MARK: - Bausteine der Detailansichten

struct Hero: View {
    let eyebrow: String
    let icon: String
    let tint: Color
    let value: String
    var caption: String? = nil
    var color: Color = Brand.text
    /// Große Ziffern, die mit der Schriftgröße des Systems mitwachsen.
    @ScaledMetric(relativeTo: .largeTitle) private var heroSize: CGFloat = 52

    var body: some View {
        GlassCard(tint: tint) {
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow(text: eyebrow, icon: icon, tint: tint)
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(value)
                        .font(.system(size: heroSize, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(color)
                        .contentTransition(.numericText())
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                    if let caption { Text(caption).font(.subheadline).foregroundStyle(Brand.text2) }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Ladestand als Ring, Min-SoC als Marke.
struct SocRing: View {
    let soc: Double?
    let minSoc: Double?

    var body: some View {
        let f = max(0, min(1, (soc ?? 0) / 100))
        ZStack {
            Circle().stroke(Brand.hairline, lineWidth: 12)
            Circle().trim(from: 0, to: f)
                .stroke(AngularGradient(colors: [Brand.cyan, Brand.battery], center: .center, startAngle: .degrees(0), endAngle: .degrees(360 * f)),
                        style: StrokeStyle(lineWidth: 12, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .shadow(color: Brand.battery.opacity(0.5), radius: 6)
            if let m = minSoc, m > 0 {
                Rectangle().fill(Brand.orange).frame(width: 3, height: 18)
                    .offset(y: -62 + 6)
                    .rotationEffect(.degrees(360 * m / 100))
            }
            VStack(spacing: 0) {
                Text(Format.percent(soc)).font(.system(.title, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
                    .contentTransition(.numericText())
                Text("Ladestand").font(.caption2).foregroundStyle(Brand.text2)
            }
        }
        .padding(6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ladestand \(Format.percent(soc))")
    }
}

/// Anteile als gestapelter Balken mit Legende.
struct ShareBar: View {
    struct Part: Identifiable { let name: String; let value: Double?; let color: Color; var id: String { name } }
    let parts: [Part]
    let format: (Double?) -> String

    var body: some View {
        let vals = parts.map { max(0, $0.value ?? 0) }
        let total = vals.reduce(0, +)
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { g in
                HStack(spacing: 2) {
                    if total <= 0 {
                        Capsule().fill(Brand.hairline)
                    } else {
                        ForEach(Array(parts.enumerated()), id: \.offset) { i, p in
                            if vals[i] > 0 {
                                RoundedRectangle(cornerRadius: 4).fill(p.color)
                                    .frame(width: max(4, (g.size.width - CGFloat(parts.count) * 2) * CGFloat(vals[i] / total)))
                            }
                        }
                    }
                }
            }
            .frame(height: 12)
            .accessibilityHidden(true)
            ForEach(Array(parts.enumerated()), id: \.offset) { i, p in
                HStack {
                    Circle().fill(p.color).frame(width: 8, height: 8)
                    Text(p.name).font(.subheadline).foregroundStyle(Brand.text2)
                    Spacer()
                    if total > 0 { Text(Format.percent(vals[i] / total * 100)).font(.caption.monospacedDigit()).foregroundStyle(Brand.dim) }
                    Text(format(p.value)).font(.system(.subheadline, design: .rounded).weight(.semibold)).monospacedDigit().foregroundStyle(Brand.text)
                        .frame(minWidth: 72, alignment: .trailing)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.top, 6)
    }
}

/// Tagesverlauf mit Ablesen per Finger.
struct DayChartCard: View {
    struct Line: Identifiable {
        let name: String
        let color: Color
        let points: [SeriesPoint]
        var area = false
        var id: String { name }
    }

    let title: String
    let unit: String
    let tint: Color
    var range: ClosedRange<Double>? = nil
    /// Teiler für die Anzeige (W → kW).
    var scale: Double = 1000
    let lines: [Line]
    var threshold: Double? = nil
    @State private var selection: Date?

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Eyebrow(text: title, icon: "chart.xyaxis.line", tint: tint)
                    Spacer()
                    if let sel = selection {
                        Text(readout(sel)).font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(Brand.text)
                    } else if lines.count > 1 {
                        HStack(spacing: 8) {
                            ForEach(lines) { l in
                                HStack(spacing: 3) { Circle().fill(l.color).frame(width: 6, height: 6); Text(l.name) }
                            }
                        }
                        .font(.caption2).foregroundStyle(Brand.text2)
                    } else {
                        Text(unit).font(.caption2).foregroundStyle(Brand.dim)
                    }
                }
                if lines.allSatisfy({ $0.points.isEmpty }) {
                    Text("Noch kein Verlauf für heute.").font(.footnote).foregroundStyle(Brand.dim)
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    chart.frame(height: 170)
                }
            }
        }
    }

    private func readout(_ d: Date) -> String {
        let vals = lines.compactMap { l -> String? in
            guard let p = nearest(l.points, d) else { return nil }
            let v = Format.number(p.value / scale, digits: scale == 1 ? 0 : 2)
            return lines.count > 1 ? "\(l.name) \(v)" : "\(v) \(unit)"
        }
        return ([Format.time(d)] + vals).joined(separator: " · ")
    }

    private func nearest(_ pts: [SeriesPoint], _ d: Date) -> SeriesPoint? {
        pts.min { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) }
    }

    private var chart: some View {
        let start = Calendar.current.startOfDay(for: Date())
        return Chart {
            ForEach(lines) { l in
                let pts = Sparkline.thin(l.points, to: 288)
                ForEach(pts) { p in
                    if l.area {
                        AreaMark(x: .value("Zeit", p.date), y: .value(unit, p.value / scale), series: .value("Reihe", l.name + "-Fläche"))
                            .interpolationMethod(.monotone)
                            .foregroundStyle(LinearGradient(colors: [l.color.opacity(0.32), l.color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    }
                    LineMark(x: .value("Zeit", p.date), y: .value(unit, p.value / scale), series: .value("Reihe", l.name))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(l.color)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                }
            }
            if let threshold {
                RuleMark(y: .value("Grenze", threshold))
                    .foregroundStyle(Brand.orange.opacity(0.8))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
            if let selection {
                RuleMark(x: .value("Auswahl", selection)).foregroundStyle(Brand.text.opacity(0.5)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXSelection(value: $selection)
        .chartXScale(domain: start...start.addingTimeInterval(86400))
        .chartYScale(domain: .automatic(includesZero: true))
        .modifier(OptionalYDomain(range: range))
        .chartXAxis { DayHourAxis() }
        .chartYAxis { PlainYAxis() }
        .accessibilityLabel(title)
        .accessibilityChartDescriptor(TimeSeriesDescriptor(
            title: title,
            summary: lines.first.flatMap { l in ChartSummary.lowHigh(l.points.map { ($0.date, $0.value / scale) }) { "\(Format.number($0, digits: scale == 1 ? 0 : 2)) \(unit)" } },
            yTitle: unit,
            series: lines.map { l in .init(name: l.name, points: l.points.map { ($0.date, $0.value / scale) }) },
            format: { "\(Format.number($0, digits: scale == 1 ? 0 : 2)) \(unit)" }))
    }
}

private struct OptionalYDomain: ViewModifier {
    let range: ClosedRange<Double>?
    func body(content: Content) -> some View {
        if let range { content.chartYScale(domain: range) } else { content }
    }
}

/// Stundenachse in Ortszeit (alle 6 h; schmal genug für kleine Diagramme).
func DayHourAxis(count: Int = 6) -> some AxisContent {
    AxisMarks(values: .stride(by: .hour, count: count)) { value in
        AxisGridLine().foregroundStyle(Brand.hairline)
        if let d = value.as(Date.self) {
            AxisValueLabel {
                Text(String(format: "%02d", Calendar.current.component(.hour, from: d)))
                    .font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
            }
        }
    }
}

func PlainYAxis() -> some AxisContent {
    AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
        AxisGridLine().foregroundStyle(Brand.hairline)
        AxisValueLabel {
            if let v = value.as(Double.self) {
                Text(v.formatted(.number.precision(.fractionLength(0...1)).locale(Format.locale)))
                    .font(.caption2.monospacedDigit()).foregroundStyle(Brand.dim)
            }
        }
    }
}

/// Netto-Ergebnis über den Tag aufsummiert (aus den Viertelstunden der Historie).
struct NetCurveCard: View {
    let rows: [HistoryRow]

    var body: some View {
        var sum = 0.0
        let pts: [(Date, Double)] = rows.compactMap { r in
            guard let d = r.date, let v = r.values["netEur"] else { return nil }
            sum += v
            return (d, sum)
        }
        return GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Ergebnis über den Tag", icon: "chart.line.uptrend.xyaxis", tint: Brand.money)
                Chart {
                    ForEach(pts, id: \.0) { p in
                        AreaMark(x: .value("Zeit", p.0), y: .value("€", p.1))
                            .interpolationMethod(.monotone)
                            .foregroundStyle(LinearGradient(colors: [Brand.money.opacity(0.3), Brand.money.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("Zeit", p.0), y: .value("€", p.1))
                            .interpolationMethod(.monotone).foregroundStyle(Brand.money).lineStyle(StrokeStyle(lineWidth: 2))
                    }
                    RuleMark(y: .value("Null", 0)).foregroundStyle(Brand.border)
                }
                .chartXAxis { DayHourAxis() }
                .chartYAxis { PlainYAxis() }
                .frame(height: 150)
                .accessibilityLabel("Aufsummiertes Netto-Ergebnis in Euro über den Tag")
            }
        }
    }
}
