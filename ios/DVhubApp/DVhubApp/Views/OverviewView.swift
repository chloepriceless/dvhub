// OverviewView.swift — Live-Übersicht: PV, Akku, Netz, Haus, Ertrag, Zustand.

import SwiftUI

struct OverviewView: View {
    let controller: SystemController

    /// Breite des Inhalts, nicht die Größenklasse: Aufgeklappt mit Seitenleiste
    /// bleibt manchmal weniger Platz als gedacht.
    @State private var width: CGFloat = 0
    private var sideColumn: Bool { width >= 760 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ConnectionBadge(controller: controller)
                if let banner { StaleBanner(text: banner) }
                if let s = controller.displayStatus {
                    if sideColumn {
                        HStack(alignment: .top, spacing: 14) {
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
                                energyTiles(s)
                            }
                            VStack(spacing: 14) {
                                moneyTile(s)
                                stateTile(s)
                            }
                            .frame(width: min(360, width * 0.36))
                        }
                    } else {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                            energyTiles(s)
                            moneyTile(s)
                            stateTile(s)
                        }
                    }
                } else {
                    ContentUnavailableView("Noch keine Werte", systemImage: "antenna.radiowaves.left.and.right",
                                           description: Text("Sobald die Anlage antwortet, erscheinen hier die Live-Werte."))
                        .frame(maxWidth: .infinity, minHeight: 280)
                }
                if let at = controller.displayAt {
                    Text("Stand \(Format.dateTime(at))").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding()
            .animation(.default, value: controller.displayStatus)
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { width = g.size.width }
                    .onChange(of: g.size.width) { _, w in width = w }
            })
        }
        .navigationTitle(controller.credentials.boxName)
    }

    private var banner: String? {
        switch controller.state {
        case .online: return nil
        case .boxOffline, .offline:
            if let at = controller.mailboxAt { return "Anlage gerade nicht erreichbar – letzter Stand von \(Format.dateTime(at))." }
            return "Anlage gerade nicht erreichbar."
        default: return nil
        }
    }

    @ViewBuilder
    private func energyTiles(_ s: LiveStatus) -> some View {
        Tile(title: "PV", icon: "sun.max.fill", tint: .yellow) {
            BigValue(value: Format.power(s.pvTotalW), caption: "Erzeugung", id: "pvValue")
        }
        Tile(title: "Akku", icon: batteryIcon(s.soc), tint: .green) {
            BigValue(value: Format.percent(s.soc), caption: batteryCaption(s))
        }
        Tile(title: "Netz", icon: "bolt.horizontal.fill", tint: .blue) {
            BigValue(value: Format.power(gridValue(s)), caption: gridCaption(s))
        }
        Tile(title: "Haus", icon: "house.fill", tint: .orange) {
            BigValue(value: Format.power(s.loadW), caption: "Verbrauch", id: "loadValue")
        }
    }

    private func moneyTile(_ s: LiveStatus) -> some View {
        Tile(title: "Heute", icon: "eurosign.circle.fill", tint: .mint) {
            BigValue(value: Format.euro(s.todayNetEur), caption: "netto")
            ViewThatFits(in: .horizontal) {
                HStack {
                    Text("Erlös \(Format.euro(s.todayRevenueEur))")
                    Spacer(minLength: 8)
                    Text("Kosten \(Format.euro(s.todayCostEur))")
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Erlös \(Format.euro(s.todayRevenueEur))")
                    Text("Kosten \(Format.euro(s.todayCostEur))")
                }
            }
            .lineLimit(1)
            .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func stateTile(_ s: LiveStatus) -> some View {
        Tile(title: "Zustand", icon: "checkmark.shield.fill", tint: stateColor(s)) {
            VStack(alignment: .leading, spacing: 4) {
                if s.emergencyStop == true { Label("Not-Halt aktiv", systemImage: "exclamationmark.octagon.fill").foregroundStyle(.red) }
                let alarms = s.alarmsActive ?? 0
                Label(alarms == 0 ? "Keine Alarme" : "\(alarms) Alarm\(alarms == 1 ? "" : "e") aktiv",
                      systemImage: alarms == 0 ? "bell" : "bell.badge.fill")
                    .foregroundStyle(alarms == 0 ? Color.secondary : Color.red)
                if s.controls?.dv?.curtailed == true { Label("Abregelung durch Direktvermarkter", systemImage: "arrow.down.to.line") }
                if s.controls?.negativePrice?.active == true { Label("Negativpreis-Schutz aktiv", systemImage: "minus.circle") }
                if s.controls?.p14a?.active == true { Label("§14a-Begrenzung aktiv", systemImage: "gauge.with.dots.needle.33percent") }
                if s.telemetryFrozen == true { Label("Messwerte eingefroren", systemImage: "snowflake").foregroundStyle(.orange) }
            }
            .font(.footnote)
        }
    }

    private func stateColor(_ s: LiveStatus) -> Color {
        if s.emergencyStop == true || (s.alarmsActive ?? 0) > 0 { return .red }
        if s.telemetryFrozen == true { return .orange }
        return .green
    }

    private func batteryIcon(_ soc: Double?) -> String {
        guard let soc else { return "battery.0percent" }
        switch soc {
        case ..<13: return "battery.0percent"
        case ..<38: return "battery.25percent"
        case ..<63: return "battery.50percent"
        case ..<88: return "battery.75percent"
        default: return "battery.100percent"
        }
    }

    /// DVhub: + = Laden, − = Entladen.
    private func batteryCaption(_ s: LiveStatus) -> String {
        guard let w = s.batteryPowerW else { return "–" }
        if abs(w) < 20 { return "Ruhe" }
        return (w > 0 ? "lädt " : "entlädt ") + Format.power(w)
    }

    private func gridValue(_ s: LiveStatus) -> Double? {
        let imp = s.gridImportW ?? 0, exp = s.gridExportW ?? 0
        if s.gridImportW == nil && s.gridExportW == nil { return nil }
        return imp >= exp ? imp : exp
    }

    private func gridCaption(_ s: LiveStatus) -> String {
        guard s.gridImportW != nil || s.gridExportW != nil else { return "kein Zähler" }
        let imp = s.gridImportW ?? 0, exp = s.gridExportW ?? 0
        if max(imp, exp) < 20 { return "ausgeglichen" }
        return imp >= exp ? "Bezug" : "Einspeisung"
    }
}

struct StaleBanner: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "clock.arrow.circlepath")
            .font(.footnote)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
    }
}
