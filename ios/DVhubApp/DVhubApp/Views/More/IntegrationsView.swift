// IntegrationsView.swift — Zustand der Anbindungen (nur lesend), aus den für
// die App freigegebenen Endpunkten: Gesundheit, Datenfluss, EOS, DV-VPN,
// Geräte, E-Auto, Einspeisegrenze, Speicherplatz — und was eingerichtet ist
// (/api/mobile-link/integrations). Diese Sicht baut die Box eigens für die App:
// ohne Adressen im Heimnetz, Benutzernamen, Kennungen und Passwörter. Die volle
// Übersicht der Weboberfläche (/api/integrations/status) bekommt die App nicht.

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
        ("setup", "/api/mobile-link/integrations"),
    ]

    var body: some View {
        AuroraPage(inlineTitle: true) { width in
            if !controller.isOnline { NoticeBanner(text: "Der Zustand der Anbindungen braucht eine Verbindung zur Anlage.") }
            let cards = self.cards
            if cards.isEmpty && loading { ProgressView().frame(maxWidth: .infinity, minHeight: 200) }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: Layout.isWide(width) ? 2 : 1), spacing: 12) {
                ForEach(cards) { $0 }
            }
            if let c = data["setup"] {
                setupCard(c, columns: Layout.isWide(width) ? 2 : 1)
            } else if let code = statusCode["setup"], code != 200 {
                NoticeBanner(text: "Was eingerichtet ist, zeigt die App ab einem neueren DVhub-Stand.", icon: "info.circle", tint: Brand.cyan)
            }
            if let d = data["dataflow"] { dataflowCard(d) }
            Text("Einrichten und Ändern der Anbindungen geht in der DVhub-Weboberfläche unter „Integrationen“. Adressen und Zugangsdaten zeigt die App nicht – sie verlassen die Anlage nicht.\(loadedAt.map { " Stand \(Format.time($0))." } ?? "")")
                .font(.caption2).foregroundStyle(Brand.dim)
        }
        .navigationTitle("Integrationen")
        .screenActions(.more, [
            ScreenAction(id: "integrations.refresh", title: String(localized: "Aktualisieren"), icon: "arrow.clockwise", disabled: loading) { Task { await load() } },
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
            for (key, title, icon) in [("victron", String(localized: "Wechselrichter"), "bolt.batteryblock.fill"), ("epex", String(localized: "Börsenpreise (EPEX)"), "chart.bar.fill"), ("mqtt", String(localized: "MQTT"), "antenna.radiowaves.left.and.right")] {
                guard let s = h[key], s.object != nil else { continue }
                var rows: [(String, String)] = []
                if let ms = s["latencyMs"]?.number { rows.append((String(localized: "Antwortzeit"), String(localized: "\(Int(ms)) ms"))) }
                if let e = s["errors24h"]?.number { rows.append((String(localized: "Fehler in 24 h"), "\(Int(e))")) }
                if let at = parseISODate(s["lastSampleAt"]?.string) { rows.append((String(localized: "Letzter Wert"), Format.dateTime(at))) }
                if let fw = s["firmware"]?.string, !fw.isEmpty { rows.append((String(localized: "Firmware"), fw)) }
                if key == "victron", let mode = h["featured"]?["victronEssMode"]?.number { rows.append((String(localized: "ESS-Modus"), "\(Int(mode))")) }
                let (text, tint) = Self.health(s["status"]?.string, reason: s["statusReason"]?.string)
                out.append(IntegrationCard(id: key, title: title, icon: icon, state: text, tint: tint, rows: rows))
            }
        }
        if let e = data["eos"] {
            let st = e["status"]?.string ?? "unknown"
            let map: [String: (String, Color)] = ["up": (String(localized: "läuft"), Brand.green), "busy": (String(localized: "rechnet"), Brand.cyan), "down": (String(localized: "antwortet nicht"), Brand.red),
                                                  "disabled": (String(localized: "aus"), Brand.dim), "unknown": (String(localized: "unbekannt"), Brand.dim)]
            var rows: [(String, String)] = []
            if let v = Self.eosVersion(e) { rows.append((String(localized: "Version"), v)) }
            if let at = Self.date(e["solutionAt"]) { rows.append((String(localized: "Letzter Plan"), Format.dateTime(at))) }
            if let at = Self.date(e["lastOkAt"]) { rows.append((String(localized: "Zuletzt erreichbar"), Format.dateTime(at))) }
            if let n = e["restarts"]?.number, n > 0 { rows.append((String(localized: "Neustarts"), "\(Int(n))")) }
            out.append(IntegrationCard(id: "eos", title: String(localized: "EOS-Optimierer"), icon: "brain", state: map[st]?.0 ?? st, tint: map[st]?.1 ?? Brand.dim, rows: rows))
        } else if statusCode["eos"] == 403 {
            out.append(IntegrationCard(id: "eos", title: String(localized: "EOS-Optimierer"), icon: "brain", state: "Pro", tint: Brand.violet, rows: []))
        }
        if let v = data["vpn"] {
            let enabled = v["enabled"]?.bool ?? false
            let st = v["status"]?.string ?? "–"
            let up = st == "connected" || st == "up"
            var rows: [(String, String)] = []
            if let s = v["uptimeSeconds"]?.number, s > 0 { rows.append((String(localized: "Verbunden seit"), Format.hours(s / 3600))) }
            if let d = v["certDaysRemaining"]?.number { rows.append((String(localized: "Zertifikat gültig"), String(localized: "noch \(Int(d)) Tage"))) }
            if let at = Self.date(v["lastModbusActivity"]?["ts"]) { rows.append((String(localized: "Letzte Abfrage des Direktvermarkters"), Format.dateTime(at))) }
            if let n = v["reconnectAttempts"]?.number, n > 0 { rows.append((String(localized: "Neuverbindungen"), "\(Int(n))")) }
            if v["watchdogOk"]?.bool == false { rows.append((String(localized: "Wächter"), String(localized: "meldet Störung"))) }
            out.append(IntegrationCard(id: "vpn", title: String(localized: "DV-VPN"), icon: "lock.shield.fill", state: !enabled ? String(localized: "aus") : (up ? String(localized: "verbunden") : st),
                                       tint: !enabled ? Brand.dim : (up ? Brand.green : Brand.orange), rows: rows))
        } else if statusCode["vpn"] == 403 {
            out.append(IntegrationCard(id: "vpn", title: String(localized: "DV-VPN"), icon: "lock.shield.fill", state: "Pro", tint: Brand.violet, rows: []))
        }
        if let ev = data["ev"], ev.object != nil {
            let veh = ev["vehicle"] ?? .null
            var rows: [(String, String)] = []
            if let soc = veh["socPct"]?.number { rows.append((String(localized: "Ladestand"), Format.percent(soc))) }
            if let r = veh["rangeKm"]?.number { rows.append((String(localized: "Reichweite"), String(localized: "\(Int(r)) km"))) }
            if let w = veh["chargePowerW"]?.number, w > 0 { rows.append((String(localized: "Ladeleistung"), Format.power(w))) }
            if let p = veh["plugged"]?.bool { rows.append((String(localized: "Angesteckt"), p ? String(localized: "ja") : String(localized: "nein"))) }
            rows.append((String(localized: "Planung"), ev["optimizeEv"]?.bool == true ? String(localized: "an") : String(localized: "aus")))
            let charging = veh["charging"]?.bool == true
            let connected = veh["connected"]?.bool == true
            if ev["chargerConfigured"]?.bool == true || connected || !rows.isEmpty {
                out.append(IntegrationCard(id: "ev", title: veh["title"]?.string ?? String(localized: "E-Auto"), icon: "car.fill",
                                           state: charging ? String(localized: "lädt") : (connected ? String(localized: "verbunden") : String(localized: "nicht verbunden")),
                                           tint: charging ? Brand.green : (connected ? Brand.cyan : Brand.dim), rows: rows))
            }
        }
        if let vd = data["victronDevices"], let list = vd["devices"]?.array, !list.isEmpty {
            for (i, d) in list.enumerated() {
                let kind = d["kind"]?.string ?? ""
                var rows: [(String, String)] = []
                if let w = d["powerW"]?.number { rows.append((String(localized: "Leistung"), Format.power(w))) }
                if let e = d["sessionEnergyKwh"]?.number, e > 0 { rows.append((String(localized: "Ladung"), Format.energy(e))) }
                if let t = d["temperatureC"]?.number { rows.append((String(localized: "Temperatur"), "\(Format.number(t)) °C")) }
                if let t = d["targetTemperatureC"]?.number { rows.append((String(localized: "Soll"), "\(Format.number(t)) °C")) }
                let state = d["statusText"]?.string ?? d["stateText"]?.string ?? (d["error"]?.isNull == false ? String(localized: "Fehler") : String(localized: "erkannt"))
                out.append(IntegrationCard(id: "vd\(i)", title: d["label"]?.string ?? d["name"]?.string ?? String(localized: "Gerät"),
                                           icon: kind == "evcharger" ? "ev.charger.fill" : (kind == "heatpump" ? "heat.waves" : "powerplug.fill"),
                                           state: state, tint: d["error"]?.isNull == false ? Brand.orange : Brand.cyan, rows: rows))
            }
        }
        if let devs = data["devices"]?.array, !devs.isEmpty {
            let online = devs.filter { $0["online"]?.bool == true }.count
            let rows = devs.prefix(8).map { d in
                (d["name"]?.string ?? String(localized: "Gerät"), d["online"]?.bool == true ? Format.power(d["powerW"]?.number) : String(localized: "offline"))
            }
            out.append(IntegrationCard(id: "devices", title: String(localized: "Schaltbare Geräte"), icon: "powerplug.fill", state: String(localized: "\(online) von \(devs.count) online"),
                                       tint: online == devs.count ? Brand.green : Brand.orange, rows: Array(rows)))
        }
        if let f = data["feedInCap"], f["configured"]?.bool == true {
            var rows: [(String, String)] = []
            if let w = f["limitW"]?.number { rows.append((String(localized: "Grenze"), Format.power(w))) }
            if let p = f["pct"]?.number { rows.append((String(localized: "Anteil der Anlagenleistung"), Format.percent(p))) }
            if let w = f["effectiveW"]?.number { rows.append((String(localized: "Wirksam"), Format.power(w))) }
            let exceeding = f["monitor"]?["exceeding"]?.bool == true
            if let n = f["monitor"]?["episodes"]?.number, n > 0 { rows.append((String(localized: "Überschreitungen"), "\(Int(n))")) }
            out.append(IntegrationCard(id: "cap", title: String(localized: "Einspeisegrenze"), icon: "arrow.up.to.line.compact", state: exceeding ? String(localized: "überschritten") : String(localized: "eingehalten"),
                                       tint: exceeding ? Brand.red : Brand.green, rows: rows))
        }
        if let s = data["storage"] {
            let level = s["level"]?.string ?? String(localized: "unbekannt")
            var rows: [(String, String)] = []
            if let p = s["freePct"]?.number { rows.append((String(localized: "Frei"), Format.percent(p))) }
            if let mb = s["freeMb"]?.number { rows.append((String(localized: "Freier Platz"), mb >= 1024 ? String(localized: "\(Format.number(mb / 1024)) GB") : String(localized: "\(Int(mb)) MB"))) }
            if let mb = s["dbMb"]?.number { rows.append((String(localized: "Messwert-Datenbank"), mb >= 1024 ? String(localized: "\(Format.number(mb / 1024)) GB") : String(localized: "\(Int(mb)) MB"))) }
            out.append(IntegrationCard(id: "storage", title: String(localized: "Speicherplatz"), icon: "internaldrive.fill", state: level,
                                       tint: level == "ok" ? Brand.green : (level == "kritisch" ? Brand.red : Brand.orange), rows: rows))
        }
        return out
    }

    /// Version für die EOS-Karte. Ab DVhub 1.0.11 nennt `/api/eos/status` in
    /// `dvhubEos` den Stand des DVhub-EOS samt Rust-Kern (`label`, sonst `build`
    /// und `nativeCore`). Das rohe `version` ist nur die Paketnummer von
    /// Upstream und wirkt wie ein alter Stand — es bleibt der Rückfall.
    static func eosVersion(_ e: JSONValue) -> String? {
        func text(_ v: JSONValue?) -> String? { v?.string.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } }
        let d = e["dvhubEos"] ?? .null
        if let label = text(d["label"]) { return label }
        if let build = text(d["build"]) {
            return text(d["nativeCore"]).map { String(localized: "\(build) · Rust-Kern \($0)") } ?? build
        }
        return text(e["version"])
    }

    static func health(_ status: String?, reason: String?) -> (String, Color) {
        switch (status, reason) {
        case ("ok", _): return (String(localized: "verbunden"), Brand.green)
        case ("warn", "errors"): return (String(localized: "instabil"), Brand.orange)
        case ("warn", _): return (String(localized: "Werte verzögert"), Brand.orange)
        case ("err", _): return (String(localized: "keine Werte"), Brand.red)
        default: return (String(localized: "unbekannt"), Brand.dim)
        }
    }

    /// Zeit als ISO-Text oder Unix-Millisekunden.
    static func date(_ v: JSONValue?) -> Date? {
        guard let v else { return nil }
        if let s = v.string { return parseISODate(s) }
        if let n = v.number, n > 1e11 { return Date(timeIntervalSince1970: n / 1000) }
        return nil
    }

    // MARK: Eingerichtet

    struct SetupRow: Identifiable {
        let id: String
        let title: String
        let state: String
        let tint: Color
        var detail: String? = nil
    }

    /// Zeilen aus der Sicht für die App (dvhub/services/mobile-link/integrations-view.js).
    /// Es gibt dort nur Wahrheitswerte, Zähler und kurze Texte — keine Adressen.
    static func setupRows(_ c: JSONValue) -> [SetupRow] {
        let on = String(localized: "an"), off = String(localized: "aus")
        let set = String(localized: "eingerichtet"), unset = String(localized: "nicht eingerichtet")
        func flag(_ v: JSONValue?) -> Bool { v?.bool == true }
        func join(_ parts: [String?]) -> String? {
            let p = parts.compactMap { $0 }.filter { !$0.isEmpty }
            return p.isEmpty ? nil : p.joined(separator: " · ")
        }
        var rows: [SetupRow] = []
        let mqtt = c["mqtt"] ?? .null
        rows.append(SetupRow(id: "mqtt", title: "MQTT",
                             state: !flag(mqtt["enabled"]) ? off : (flag(mqtt["connected"]) ? String(localized: "verbunden") : String(localized: "nicht verbunden")),
                             tint: !flag(mqtt["enabled"]) ? Brand.dim : (flag(mqtt["connected"]) ? Brand.green : Brand.orange),
                             detail: flag(mqtt["enabled"]) ? join([
                                flag(mqtt["embedded"]) ? String(localized: "Broker auf der Anlage") : String(localized: "eigener Broker"),
                                mqtt["topicCount"]?.number.map { String(localized: "\(Int($0)) Themen") },
                                flag(mqtt["passwordSet"]) ? String(localized: "Passwort gesetzt") : String(localized: "ohne Passwort"),
                                flag(mqtt["haDiscovery"]) ? String(localized: "Home-Assistant-Erkennung an") : nil]) : nil))
        let vic = c["victron"] ?? .null
        rows.append(SetupRow(id: "victron", title: String(localized: "Wechselrichter"), state: flag(vic["configured"]) ? set : unset,
                             tint: flag(vic["configured"]) ? Brand.green : Brand.dim,
                             detail: join([vic["modelId"]?.string, vic["firmware"]?.string.map { String(localized: "Firmware \($0)") }])))
        let mid = c["mid"] ?? .null
        rows.append(SetupRow(id: "mid", title: String(localized: "Netzzähler"), state: flag(mid["configured"]) ? set : unset,
                             tint: flag(mid["configured"]) ? Brand.green : Brand.dim, detail: mid["firmware"]?.string.map { String(localized: "Firmware \($0)") }))
        let eos = c["dveos"] ?? .null
        rows.append(SetupRow(id: "dveos", title: String(localized: "EOS-Optimierer"),
                             state: flag(eos["active"]) ? String(localized: "plant") : (flag(eos["enabled"]) ? String(localized: "an, plant nicht") : off),
                             tint: flag(eos["active"]) ? Brand.green : (flag(eos["enabled"]) ? Brand.orange : Brand.dim)))
        let evcc = c["evcc"] ?? .null
        let charger = evcc["charger"] ?? .null
        let hasCharger = charger.object != nil
        if flag(evcc["configured"]) || hasCharger {
            let reachable = hasCharger ? flag(charger["reachable"]) : flag(evcc["reachable"])
            rows.append(SetupRow(id: "evcc", title: String(localized: "Wallbox"),
                                 state: reachable ? String(localized: "erreichbar") : String(localized: "nicht erreichbar"), tint: reachable ? Brand.green : Brand.orange,
                                 detail: join([evcc["wallboxType"]?.string,
                                               evcc["loadpointCount"]?.number.flatMap { $0 > 0 ? String(localized: "\(Int($0)) Ladepunkte") : nil },
                                               charger["mode"]?.string.map { String(localized: "Modus \($0)") },
                                               flag(evcc["hasError"]) || flag(charger["hasError"]) ? String(localized: "meldet einen Fehler") : nil])))
        }
        let tesla = c["tesla"] ?? .null
        if flag(tesla["enabled"]) {
            rows.append(SetupRow(id: "tesla", title: tesla["name"]?.string ?? "TeslaMate", state: flag(tesla["hasState"]) ? String(localized: "liefert Werte") : String(localized: "noch keine Werte"),
                                 tint: flag(tesla["hasState"]) ? Brand.green : Brand.orange,
                                 detail: date(tesla["lastUpdate"]).map { String(localized: "zuletzt \(Format.dateTime($0))") }))
        }
        let vrm = c["vrm"] ?? .null
        rows.append(SetupRow(id: "vrm", title: String(localized: "VRM-Import"), state: flag(vrm["enabled"]) ? on : off, tint: flag(vrm["enabled"]) ? Brand.green : Brand.dim,
                             detail: flag(vrm["enabled"]) ? (flag(vrm["tokenSet"]) && flag(vrm["portalIdSet"]) ? String(localized: "Zugang hinterlegt") : String(localized: "Zugang unvollständig")) : nil))
        for (key, title) in [("solcast", "Solcast"), ("pvnode", "pvnode")] {
            let p = c["forecastProviders"]?[key] ?? .null
            guard flag(p["enabled"]) || flag(p["apiKeySet"]) else { continue }
            rows.append(SetupRow(id: key, title: String(localized: "PV-Prognose \(title)"), state: flag(p["enabled"]) ? on : off, tint: flag(p["enabled"]) ? Brand.green : Brand.dim,
                                 detail: join([flag(p["apiKeySet"]) ? String(localized: "Schlüssel hinterlegt") : String(localized: "Schlüssel fehlt"),
                                               flag(p["nowcastEnabled"]) ? "Nowcast" : nil])))
        }
        let notif = c["notifications"] ?? .null
        let providers = (notif["providers"]?.array ?? []).filter { flag($0["enabled"]) }.compactMap { $0["name"]?.string }
        rows.append(SetupRow(id: "notifications", title: String(localized: "Benachrichtigungen"), state: flag(notif["enabled"]) ? on : off,
                             tint: flag(notif["enabled"]) ? Brand.green : Brand.dim, detail: providers.isEmpty ? nil : providers.joined(separator: ", ")))
        let p14 = c["p14a"] ?? .null
        if flag(p14["available"]) {
            rows.append(SetupRow(id: "p14a", title: String(localized: "§ 14a"), state: flag(p14["active"]) ? String(localized: "begrenzt gerade") : String(localized: "bereit"),
                                 tint: flag(p14["active"]) ? Brand.orange : Brand.green,
                                 detail: join([p14["devices"]?.number.map { String(localized: "\(Int($0)) Geräte") }, p14["limitW"]?.number.map { String(localized: "Grenze \(Format.power($0))") }])))
        }
        let eebus = c["eebus"] ?? .null
        if flag(eebus["enabled"]) {
            rows.append(SetupRow(id: "eebus", title: "EEBUS", state: eebus["statusLabel"]?.string ?? on, tint: eebus["status"]?.string == "running" ? Brand.green : Brand.orange,
                                 detail: join([flag(eebus["gridPeer"]) ? (flag(eebus["gridConnected"]) ? String(localized: "Netzbetreiber verbunden") : String(localized: "Netzbetreiber nicht verbunden")) : nil,
                                               eebus["devices"]?.number.flatMap { $0 > 0 ? String(localized: "\(Int($0)) Geräte") : nil }])))
        }
        if flag(c["loxone"]?["configured"]) { rows.append(SetupRow(id: "loxone", title: "Loxone", state: set, tint: Brand.green)) }
        if flag(c["luox"]?["configured"]) { rows.append(SetupRow(id: "luox", title: "LUOX", state: set, tint: Brand.green)) }
        let sched = c["schedulable"] ?? .null
        if let n = sched["total"]?.number, n > 0 {
            rows.append(SetupRow(id: "schedulable", title: String(localized: "Planbare Verbraucher"), state: String(Int(n)), tint: Brand.cyan,
                                 detail: flag(sched["eosActive"]) ? String(localized: "EOS plant sie ein") : nil))
        }
        let pv = c["pvStrings"] ?? .null
        if flag(pv["enabled"]) {
            rows.append(SetupRow(id: "pvStrings", title: String(localized: "PV-Strings"), state: flag(pv["hasError"]) ? String(localized: "Fehler") : on, tint: flag(pv["hasError"]) ? Brand.orange : Brand.green,
                                 detail: join([pv["sourceCount"]?.number.map { String(localized: "\(Int($0)) Quellen") }, date(pv["lastSyncAt"]).map { String(localized: "zuletzt \(Format.dateTime($0))") }])))
        }
        return rows
    }

    private func setupCard(_ c: JSONValue, columns: Int) -> some View {
        let rows = Self.setupRows(c)
        return GlassCard(tint: Brand.violet) {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Eingerichtet", icon: "checklist", tint: Brand.violet)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 24, alignment: .top), count: columns), spacing: 0) {
                    ForEach(rows) { r in
                        VStack(spacing: 0) {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(r.title).font(.subheadline).foregroundStyle(Brand.text)
                                    if let d = r.detail { Text(d).font(.caption2).foregroundStyle(Brand.dim).fixedSize(horizontal: false, vertical: true) }
                                }
                                Spacer(minLength: 8)
                                Text(r.state).font(.footnote.weight(.semibold)).foregroundStyle(r.tint).multilineTextAlignment(.trailing)
                            }
                            .padding(.vertical, 7)
                            Hairline()
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("setup.\(r.id)")
                    }
                }
            }
        }
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
        case "gridSetpointW": return String(localized: "Netz-Sollwert")
        case "chargeCurrentA": return String(localized: "Ladestrom")
        case "minSocPct": return String(localized: "Mindest-Ladestand")
        case "maxDischargeW": return String(localized: "Max. Entladeleistung")
        case "feedExcessDcPv": return String(localized: "DC-Überschuss einspeisen")
        default: return String(localized: "Vorgabe")
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
