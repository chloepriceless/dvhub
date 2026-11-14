// IntegrationsView.swift — Zustand der Anbindungen (nur lesend), aus den für
// die App freigegebenen Endpunkten: Gesundheit, Datenfluss, EOS, DV-VPN,
// Geräte, E-Auto, Einspeisegrenze, Speicherplatz. Gelesen werden nur benannte
// Felder; Adressen und Kennungen der Gegenstellen zeigt die App nicht.

import SwiftUI
import DVhubLink

struct IntegrationsView: View {
    let controller: SystemController
    @State private var data: [String: JSONValue] = [:]
    @State private var statusCode: [String: Int] = [:]
    @State private var loading = false
    @State private var loadedAt: Date?

    private static let paths: [(String, String)] = [
        ("health", "/api/integrations/health"), ("dataflow", "/api/integrations/dataflow"), ("eos", "/api/eos/status"),
        ("vpn", "/api/vpn/status"), ("devices", "/api/devices"), ("victronDevices", "/api/victron/devices"),
        ("ev", "/api/ev"), ("feedInCap", "/api/feed-in-cap/status"), ("storage", "/api/storage/status"),
    ]

    var body: some View {
        AuroraPage(inlineTitle: true) { width in
            if !controller.isOnline { NoticeBanner(text: "Der Zustand der Anbindungen braucht eine Verbindung zur Anlage.") }
            let cards = self.cards
            if cards.isEmpty && loading { ProgressView().frame(maxWidth: .infinity, minHeight: 200) }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: Layout.isWide(width) ? 2 : 1), spacing: 12) {
                ForEach(cards) { $0 }
            }
            if let d = data["dataflow"] { dataflowCard(d) }
            Text("Einrichten und Ändern der Anbindungen geht in der DVhub-Weboberfläche unter „Integrationen“.\(loadedAt.map { " Stand \(Format.time($0))." } ?? "")")
                .font(.caption2).foregroundStyle(Brand.dim)
        }
        .navigationTitle("Integrationen")
        .screenActions(.more, [
            ScreenAction(id: "integrations.refresh", title: "Aktualisieren", icon: "arrow.clockwise", disabled: loading) { Task { await load() } },
        ])
        .refreshable { await load() }
        .task(id: controller.isOnline) { await load() }
    }

    /// Nacheinander laden: Die Box nimmt je Gerät höchstens vier Anfragen zugleich an.
    private func load() async {
        guard controller.isOnline, !loading else { return }
        loading = true
        defer { loading = false }
        for (key, path) in Self.paths {
            if Task.isCancelled { return }
            guard let r = try? await controller.request("GET", path) else { continue }
            statusCode[key] = r.status
            if r.status == 200 { data[key] = r.body } else { data[key] = nil }
        }
        loadedAt = Date()
    }

    // MARK: Karten

    private var cards: [IntegrationCard] {
        var out: [IntegrationCard] = []
        if let h = data["health"] {
            for (key, title, icon) in [("victron", "Wechselrichter", "bolt.batteryblock.fill"), ("epex", "Börsenpreise (EPEX)", "chart.bar.fill"), ("mqtt", "MQTT", "antenna.radiowaves.left.and.right")] {
                guard let s = h[key], s.object != nil else { continue }
                var rows: [(String, String)] = []
                if let ms = s["latencyMs"]?.number { rows.append(("Antwortzeit", "\(Int(ms)) ms")) }
                if let e = s["errors24h"]?.number { rows.append(("Fehler in 24 h", "\(Int(e))")) }
                if let at = parseISODate(s["lastSampleAt"]?.string) { rows.append(("Letzter Wert", Format.dateTime(at))) }
                if let fw = s["firmware"]?.string, !fw.isEmpty { rows.append(("Firmware", fw)) }
                if key == "victron", let mode = h["featured"]?["victronEssMode"]?.number { rows.append(("ESS-Modus", "\(Int(mode))")) }
                let (text, tint) = Self.health(s["status"]?.string, reason: s["statusReason"]?.string)
                out.append(IntegrationCard(id: key, title: title, icon: icon, state: text, tint: tint, rows: rows))
            }
        }
        if let e = data["eos"] {
            let st = e["status"]?.string ?? "unknown"
            let map: [String: (String, Color)] = ["up": ("läuft", Brand.green), "busy": ("rechnet", Brand.cyan), "down": ("antwortet nicht", Brand.red),
                                                  "disabled": ("aus", Brand.dim), "unknown": ("unbekannt", Brand.dim)]
            var rows: [(String, String)] = []
            if let v = e["version"]?.string { rows.append(("Version", v)) }
            if let at = Self.date(e["solutionAt"]) { rows.append(("Letzter Plan", Format.dateTime(at))) }
            if let at = Self.date(e["lastOkAt"]) { rows.append(("Zuletzt erreichbar", Format.dateTime(at))) }
            if let n = e["restarts"]?.number, n > 0 { rows.append(("Neustarts", "\(Int(n))")) }
            out.append(IntegrationCard(id: "eos", title: "EOS-Optimierer", icon: "brain", state: map[st]?.0 ?? st, tint: map[st]?.1 ?? Brand.dim, rows: rows))
        } else if statusCode["eos"] == 403 {
            out.append(IntegrationCard(id: "eos", title: "EOS-Optimierer", icon: "brain", state: "Pro", tint: Brand.violet, rows: []))
        }
        if let v = data["vpn"] {
            let enabled = v["enabled"]?.bool ?? false
            let st = v["status"]?.string ?? "–"
            let up = st == "connected" || st == "up"
            var rows: [(String, String)] = []
            if let s = v["uptimeSeconds"]?.number, s > 0 { rows.append(("Verbunden seit", Format.hours(s / 3600))) }
            if let d = v["certDaysRemaining"]?.number { rows.append(("Zertifikat gültig", "noch \(Int(d)) Tage")) }
            if let at = Self.date(v["lastModbusActivity"]?["ts"]) { rows.append(("Letzte Abfrage des Direktvermarkters", Format.dateTime(at))) }
            if let n = v["reconnectAttempts"]?.number, n > 0 { rows.append(("Neuverbindungen", "\(Int(n))")) }
            if v["watchdogOk"]?.bool == false { rows.append(("Wächter", "meldet Störung")) }
            out.append(IntegrationCard(id: "vpn", title: "DV-VPN", icon: "lock.shield.fill", state: !enabled ? "aus" : (up ? "verbunden" : st),
                                       tint: !enabled ? Brand.dim : (up ? Brand.green : Brand.orange), rows: rows))
        } else if statusCode["vpn"] == 403 {
            out.append(IntegrationCard(id: "vpn", title: "DV-VPN", icon: "lock.shield.fill", state: "Pro", tint: Brand.violet, rows: []))
        }
        if let ev = data["ev"], ev.object != nil {
            let veh = ev["vehicle"] ?? .null
            var rows: [(String, String)] = []
            if let soc = veh["socPct"]?.number { rows.append(("Ladestand", Format.percent(soc))) }
            if let r = veh["rangeKm"]?.number { rows.append(("Reichweite", "\(Int(r)) km")) }
            if let w = veh["chargePowerW"]?.number, w > 0 { rows.append(("Ladeleistung", Format.power(w))) }
            if let p = veh["plugged"]?.bool { rows.append(("Angesteckt", p ? "ja" : "nein")) }
            rows.append(("Planung", ev["optimizeEv"]?.bool == true ? "an" : "aus"))
            let charging = veh["charging"]?.bool == true
            let connected = veh["connected"]?.bool == true
            if ev["chargerConfigured"]?.bool == true || connected || !rows.isEmpty {
                out.append(IntegrationCard(id: "ev", title: veh["title"]?.string ?? "E-Auto", icon: "car.fill",
                                           state: charging ? "lädt" : (connected ? "verbunden" : "nicht verbunden"),
                                           tint: charging ? Brand.green : (connected ? Brand.cyan : Brand.dim), rows: rows))
            }
        }
        if let vd = data["victronDevices"], let list = vd["devices"]?.array, !list.isEmpty {
            for (i, d) in list.enumerated() {
                let kind = d["kind"]?.string ?? ""
                var rows: [(String, String)] = []
                if let w = d["powerW"]?.number { rows.append(("Leistung", Format.power(w))) }
                if let e = d["sessionEnergyKwh"]?.number, e > 0 { rows.append(("Ladung", Format.energy(e))) }
                if let t = d["temperatureC"]?.number { rows.append(("Temperatur", "\(Format.number(t)) °C")) }
                if let t = d["targetTemperatureC"]?.number { rows.append(("Soll", "\(Format.number(t)) °C")) }
                let state = d["statusText"]?.string ?? d["stateText"]?.string ?? (d["error"]?.isNull == false ? "Fehler" : "erkannt")
                out.append(IntegrationCard(id: "vd\(i)", title: d["label"]?.string ?? d["name"]?.string ?? "Gerät",
                                           icon: kind == "evcharger" ? "ev.charger.fill" : (kind == "heatpump" ? "heat.waves" : "powerplug.fill"),
                                           state: state, tint: d["error"]?.isNull == false ? Brand.orange : Brand.cyan, rows: rows))
            }
        }
        if let devs = data["devices"]?.array, !devs.isEmpty {
            let online = devs.filter { $0["online"]?.bool == true }.count
            let rows = devs.prefix(8).map { d in
                (d["name"]?.string ?? "Gerät", d["online"]?.bool == true ? Format.power(d["powerW"]?.number) : "offline")
            }
            out.append(IntegrationCard(id: "devices", title: "Schaltbare Geräte", icon: "powerplug.fill", state: "\(online) von \(devs.count) online",
                                       tint: online == devs.count ? Brand.green : Brand.orange, rows: Array(rows)))
        }
        if let f = data["feedInCap"], f["configured"]?.bool == true {
            var rows: [(String, String)] = []
            if let w = f["limitW"]?.number { rows.append(("Grenze", Format.power(w))) }
            if let p = f["pct"]?.number { rows.append(("Anteil der Anlagenleistung", Format.percent(p))) }
            if let w = f["effectiveW"]?.number { rows.append(("Wirksam", Format.power(w))) }
            let exceeding = f["monitor"]?["exceeding"]?.bool == true
            if let n = f["monitor"]?["episodes"]?.number, n > 0 { rows.append(("Überschreitungen", "\(Int(n))")) }
            out.append(IntegrationCard(id: "cap", title: "Einspeisegrenze", icon: "arrow.up.to.line.compact", state: exceeding ? "überschritten" : "eingehalten",
                                       tint: exceeding ? Brand.red : Brand.green, rows: rows))
        }
        if let s = data["storage"] {
            let level = s["level"]?.string ?? "unbekannt"
            var rows: [(String, String)] = []
            if let p = s["freePct"]?.number { rows.append(("Frei", Format.percent(p))) }
            if let mb = s["freeMb"]?.number { rows.append(("Freier Platz", mb >= 1024 ? "\(Format.number(mb / 1024)) GB" : "\(Int(mb)) MB")) }
            if let mb = s["dbMb"]?.number { rows.append(("Messwert-Datenbank", mb >= 1024 ? "\(Format.number(mb / 1024)) GB" : "\(Int(mb)) MB")) }
            out.append(IntegrationCard(id: "storage", title: "Speicherplatz", icon: "internaldrive.fill", state: level,
                                       tint: level == "ok" ? Brand.green : (level == "kritisch" ? Brand.red : Brand.orange), rows: rows))
        }
        return out
    }

    static func health(_ status: String?, reason: String?) -> (String, Color) {
        switch (status, reason) {
        case ("ok", _): return ("verbunden", Brand.green)
        case ("warn", "errors"): return ("instabil", Brand.orange)
        case ("warn", _): return ("Werte verzögert", Brand.orange)
        case ("err", _): return ("keine Werte", Brand.red)
        default: return ("unbekannt", Brand.dim)
        }
    }

    /// Zeit als ISO-Text oder Unix-Millisekunden.
    static func date(_ v: JSONValue?) -> Date? {
        guard let v else { return nil }
        if let s = v.string { return parseISODate(s) }
        if let n = v.number, n > 1e11 { return Date(timeIntervalSince1970: n / 1000) }
        return nil
    }

    // MARK: Datenfluss

    private func dataflowCard(_ d: JSONValue) -> some View {
        let checks = d["checks"]?.array ?? []
        let seen = d["seen"]?.array ?? []
        let control = d["out"]?["control"] ?? .null
        let writes = d["out"]?["lastWrites"]?.array ?? []
        return GlassCard(tint: Brand.cyan) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Eyebrow(text: "Datenfluss", icon: "arrow.left.arrow.right", tint: Brand.cyan)
                    Spacer()
                    if control["paused"]?.bool == true { Pill(text: "Steuerung pausiert", tint: Brand.red) }
                }
                if let label = d["in"]?["source"]?["label"]?.string {
                    Text("Quelle: \(label)").font(.footnote).foregroundStyle(Brand.text2)
                }
                ForEach(Array(checks.enumerated()), id: \.offset) { _, c in
                    if let t = c["text"]?.string {
                        NoticeBanner(text: t, icon: "exclamationmark.triangle", tint: c["level"]?.string == "error" ? Brand.red : Brand.orange)
                    }
                }
                if !seen.isEmpty {
                    Text("So versteht DVhub die Werte").font(.caption.weight(.bold)).foregroundStyle(Brand.text)
                    RowStack {
                        ForEach(Array(seen.enumerated()), id: \.offset) { _, r in
                            ValueRow(label: r["label"]?.string ?? "–", value: Self.value(r["value"]?.number, r["unit"]?.string), hint: r["note"]?.string)
                        }
                    }
                }
                let rows = control["rows"]?.array ?? []
                if !rows.isEmpty {
                    Text("Was DVhub vorgibt").font(.caption.weight(.bold)).foregroundStyle(Brand.text)
                    RowStack {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                            ValueRow(label: r["label"]?.string ?? "–", value: Self.value(r["value"]?.number, r["unit"]?.string),
                                     hint: r["source"]?.string.map(DetailView.sourceName))
                        }
                    }
                }
                if !writes.isEmpty {
                    Text("Zuletzt geschrieben").font(.caption.weight(.bold)).foregroundStyle(Brand.text)
                    RowStack {
                        ForEach(Array(writes.prefix(6).enumerated()), id: \.offset) { _, w in
                            ValueRow(label: Self.targetName(w["key"]?.string ?? ""), value: Format.number(w["value"]?.number, digits: 0),
                                     hint: Self.date(w["at"]).map(Format.dateTime))
                        }
                    }
                }
            }
        }
    }

    static func value(_ v: Double?, _ unit: String?) -> String {
        guard let v else { return "–" }
        switch unit {
        case "W": return Format.signedPower(v)
        case "%": return Format.percent(v)
        default: return Format.number(v, digits: 0) + (unit.map { " \($0)" } ?? "")
        }
    }

    static func targetName(_ key: String) -> String {
        switch key {
        case "gridSetpointW": return "Netz-Sollwert"
        case "chargeCurrentA": return "Ladestrom"
        case "minSocPct": return "Mindest-Ladestand"
        case "maxDischargeW": return "Max. Entladeleistung"
        case "feedExcessDcPv": return "DC-Überschuss einspeisen"
        default: return "Vorgabe"
        }
    }
}

struct IntegrationCard: View, Identifiable {
    let id: String
    let title: String
    let icon: String
    let state: String
    let tint: Color
    let rows: [(String, String)]

    var body: some View {
        GlassCard(tint: tint) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Image(systemName: icon).font(.title3).foregroundStyle(tint).frame(width: 30)
                    Text(title).font(.headline).foregroundStyle(Brand.text).lineLimit(1).minimumScaleFactor(0.8)
                    Spacer(minLength: 4)
                    Pill(text: state, tint: tint)
                }
                if !rows.isEmpty {
                    RowStack {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, r in ValueRow(label: r.0, value: r.1) }
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
