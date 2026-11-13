// SystemInfoView.swift — Einstellungen der Anlage zum Nachsehen (nur lesend):
// Strompreise, Börse, Standardwerte der Steuerung, Betrieb. Die Werte kommen
// aus /api/status; gelesen werden nur benannte Felder. Die Konfiguration
// selbst (/api/config) ist für die App nicht freigegeben.

import SwiftUI
import DVhubLink

struct SystemInfoView: View {
    let controller: SystemController

    private var raw: JSONValue { controller.statusRaw ?? .null }

    var body: some View {
        AuroraPage { width in
            if !controller.isOnline && controller.statusRaw == nil {
                NoticeBanner(text: "Die Einstellungen brauchen eine Verbindung zur Anlage.")
            }
            operation
            if raw["userEnergyPricing"]?.object != nil { pricing }
            if raw["epex"]?.object != nil { market }
            if raw["schedule"]?.object != nil { control }
            NoticeBanner(text: "Ändern geht in der DVhub-Weboberfläche unter „Einstellungen“. Die App liest hier nur mit.", icon: "lock", tint: Brand.cyan)
        }
        .navigationTitle("System")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await controller.refreshDetail(maxAge: 0) }
        .task(id: controller.isOnline) { await controller.refreshDetail(maxAge: 30) }
    }

    private var operation: some View {
        let tel = raw["telemetry"] ?? .null
        let run = raw["runtime"] ?? .null
        return GlassCard(tint: Brand.blue) {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: "Betrieb", icon: "server.rack", tint: Brand.blue)
                RowStack {
                    ValueRow(label: "Anlage", value: controller.credentials.boxName)
                    ValueRow(label: "DVhub-Version", value: controller.boxVersion ?? controller.displayStatus?.version ?? "–")
                    if let tz = raw["timeZone"]?.string { ValueRow(label: "Zeitzone", value: tz) }
                    if let ready = run["ready"]?.bool { ValueRow(label: "Regelung", value: ready ? "bereit" : "startet", tint: ready ? Brand.green : Brand.orange) }
                    if let e = tel["enabled"]?.bool {
                        ValueRow(label: "Messwert-Datenbank", value: !e ? "aus" : (tel["ok"]?.bool == false ? "Störung" : "läuft"),
                                 tint: !e ? Brand.dim : (tel["ok"]?.bool == false ? Brand.red : Brand.green),
                                 hint: IntegrationsView.date(tel["lastWriteAt"]).map { "Letzter Eintrag \(Format.dateTime($0))" })
                    }
                    if let stop = raw["emergencyStop"]?["active"]?.bool { ValueRow(label: "Not-Halt", value: stop ? "aktiv" : "aus", tint: stop ? Brand.red : nil) }
                    ValueRow(label: "Rechte dieses Geräts", value: controller.canControl ? "Anzeigen und steuern" : "Nur anzeigen")
                }
            }
        }
    }

    private var pricing: some View {
        let p = raw["userEnergyPricing"] ?? .null
        let mode = p["mode"]?.string
        let comp = p["dynamicComponents"] ?? .null
        let costs = p["costs"] ?? .null
        let windows = p["module3Windows"]?.array ?? []
        return GlassCard(tint: Brand.violet) {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: "Strompreise", icon: "eurosign.circle", tint: Brand.violet)
                RowStack {
                    ValueRow(label: "Bezugstarif", value: Self.modeName(mode, configured: p["configured"]?.bool ?? false))
                    if mode == "fixed", let f = p["fixedGrossImportCtKwh"]?.number { ValueRow(label: "Festpreis brutto", value: Format.ct(f)) }
                    if mode == "dynamic" {
                        if let v = comp["energyMarkupCtKwh"]?.number { ValueRow(label: "Aufschlag des Anbieters", value: Format.ct(v)) }
                        if let v = comp["gridChargesCtKwh"]?.number { ValueRow(label: "Netzentgelte", value: Format.ct(v)) }
                        if let v = comp["leviesAndFeesCtKwh"]?.number { ValueRow(label: "Umlagen und Abgaben", value: Format.ct(v)) }
                        if let v = comp["vatPct"]?.number { ValueRow(label: "Mehrwertsteuer", value: Format.percent(v)) }
                    }
                    if let v = p["current"]?["importPriceCtKwh"]?.number { ValueRow(label: "Bezugspreis jetzt", value: Format.ct(v), tint: Brand.violet) }
                    if let v = p["current"]?["exportPriceCtKwh"]?.number { ValueRow(label: "Einspeisepreis jetzt", value: Format.ct(v)) }
                    if let v = costs["pvCtKwh"]?.number { ValueRow(label: "Gestehungskosten Solar", value: Format.ct(v)) }
                    if let v = costs["batteryEffectiveCtKwh"]?.number { ValueRow(label: "Kosten Akku-Strom", value: Format.ct(v), hint: "mit Verlusten") }
                    if p["usesParagraph14aModule3"]?.bool == true { ValueRow(label: "§14a Modul 3", value: "\(windows.count) Zeitfenster") }
                }
                ForEach(Array(windows.enumerated()), id: \.offset) { _, w in
                    if let s = w["start"]?.string, let e = w["end"]?.string {
                        ValueRow(label: w["label"]?.string ?? "Zeitfenster", value: "\(s)–\(e) · \(Format.ct(w["priceCtKwh"]?.number))")
                    }
                }
            }
        }
    }

    static func modeName(_ mode: String?, configured: Bool) -> String {
        guard configured else { return "nicht eingerichtet" }
        switch mode {
        case "fixed": return "Festpreis"
        case "dynamic": return "dynamisch (Börse + Aufschläge)"
        case "provider": return "Preis vom Anbieter"
        default: return "–"
        }
    }

    private var market: some View {
        let e = raw["epex"] ?? .null
        return GlassCard(tint: Brand.blue) {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: "Börsenpreise in DVhub", icon: "chart.bar.fill", tint: Brand.blue)
                RowStack {
                    if let z = e["bzn"]?.string { ValueRow(label: "Gebotszone", value: z) }
                    ValueRow(label: "Zustand", value: e["ok"]?.bool == true ? "aktuell" : "Störung", tint: e["ok"]?.bool == true ? Brand.green : Brand.orange)
                    if let at = IntegrationsView.date(e["updatedAt"]) { ValueRow(label: "Zuletzt geholt", value: Format.dateTime(at)) }
                    if let s = e["summary"], s.object != nil {
                        if let lo = s["todayMin"]?.number, let hi = s["todayMax"]?.number {
                            ValueRow(label: "Heute", value: "\(MarketStyle.ct1(lo / 10))–\(MarketStyle.ct1(hi / 10)) ct")
                        }
                        if let lo = s["tomorrowMin"]?.number, let hi = s["tomorrowMax"]?.number {
                            ValueRow(label: "Morgen", value: "\(MarketStyle.ct1(lo / 10))–\(MarketStyle.ct1(hi / 10)) ct")
                        }
                        if s["hasFutureNegative"]?.bool == true { ValueRow(label: "Negative Preise", value: "stehen bevor", tint: Brand.red) }
                    }
                }
            }
        }
    }

    private var control: some View {
        let s = raw["schedule"] ?? .null
        let cfg = s["config"] ?? .null
        let sma = s["smallMarketAutomation"] ?? .null
        let rules = s["rules"]?.array ?? []
        return GlassCard(tint: Brand.yellow) {
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: "Steuerung", icon: "slider.horizontal.3", tint: Brand.yellow)
                RowStack {
                    if let v = cfg["defaultGridSetpointW"]?.number { ValueRow(label: "Standard-Sollwert am Netzpunkt", value: Format.signedPower(v)) }
                    if let v = cfg["defaultChargeCurrentA"]?.number { ValueRow(label: "Standard-Ladestrom", value: "\(Format.number(v, digits: 0)) A") }
                    ValueRow(label: "Regeln im Zeitplan", value: "\(rules.filter { $0["enabled"]?.bool != false }.count) aktiv von \(rules.count)")
                    if let d = sma["lastRunDate"]?.string { ValueRow(label: "Börsenautomatik zuletzt", value: d, hint: sma["generatedRuleCount"]?.number.map { "\(Int($0)) Regeln erzeugt" }) }
                    if let min = controller.displayStatus?.minSocPct { ValueRow(label: "Min-SoC", value: Format.percent(min)) }
                }
            }
        }
    }
}
