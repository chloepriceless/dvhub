// EmergencyStopActivity.swift — Live-Aktivität „Not-Halt aktiv“: Daten und
// Ansichten. Die Daten brauchen App (startet, aktualisiert, beendet) und
// Widget-Erweiterung (zeichnet Sperrbildschirm und Dynamic Island).
//
// Ohne eigenen Push-Server: Die App aktualisiert die Aktivität lokal — solange
// sie offen ist und bei jedem Hintergrundabruf, den das System ihr gewährt.
// Dazwischen bleibt der letzte Stand stehen; die Uhr („seit …“) läuft im
// System weiter, und nach `staleDate` kennzeichnet die Ansicht die Werte als alt.

import ActivityKit
import SwiftUI
import WidgetKit

struct EmergencyStopAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// Seit wann dieses Gerät den Not-Halt kennt.
        var since: Date
        /// Von wann die Werte darunter sind.
        var updatedAt: Date
        var soc: Double?
        var pvW: Double?
        var loadW: Double?
        var gridImportW: Double?
        var gridExportW: Double?
    }

    var boxName: String
    var boxId: String
}

extension EmergencyStopAttributes.ContentState {
    init(_ s: WidgetSnapshot, since: Date) {
        self.init(since: since, updatedAt: s.at, soc: s.soc, pvW: s.pvW, loadW: s.loadW, gridImportW: s.gridImportW, gridExportW: s.gridExportW)
    }

    var exporting: Bool { (gridExportW ?? 0) > (gridImportW ?? 0) }
    var gridW: Double { max(gridImportW ?? 0, gridExportW ?? 0) }
}

/// Link in die App: `dvhub://open/<Bereich>` (siehe RootView).
enum DeepLink {
    static func open(_ target: String) -> URL { URL(string: "dvhub://open/\(target)")! }
    static let control = open("control")
    static let dashboard = open("dashboard")
    static let money = open("money")
}

// MARK: - Ansichten

/// Laufende Dauer seit Beginn des Not-Halts — zählt das System selbst weiter.
struct StopTimer: View {
    let since: Date
    var body: some View {
        Text(timerInterval: since...Date.distantFuture, countsDown: false)
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
    }
}

/// Sperrbildschirm und Banner.
struct EmergencyStopLockScreenView: View {
    let attributes: EmergencyStopAttributes
    let state: EmergencyStopAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "exclamationmark.octagon.fill")
                    .font(.title2).foregroundStyle(Brand.red)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Not-Halt aktiv").font(.headline)
                    Text(attributes.boxName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 1) {
                    StopTimer(since: state.since).font(.system(.title3, design: .rounded).weight(.semibold))
                        .frame(maxWidth: 110, alignment: .trailing)
                        .accessibilityLabel("Dauer")
                    Text("seit \(Format.time(state.since))").font(.caption2).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 14) {
                value("battery.75percent", "Akku", Format.percent(state.soc), Brand.battery)
                value("sun.max.fill", "PV", Format.power(state.pvW), Brand.pv)
                value(state.exporting ? "arrow.up.to.line" : "arrow.down.to.line",
                      state.exporting ? String(localized: "Einspeisung") : String(localized: "Bezug"), Format.power(state.gridW),
                      state.exporting ? Brand.cyan : Brand.grid)
            }
            Text(isStale ? "DVhub schreibt keine Sollwerte. Werte von \(Format.time(state.updatedAt)) – zum Aktualisieren DVhub öffnen."
                         : "DVhub schreibt keine Sollwerte. Stand \(Format.time(state.updatedAt)).")
                .font(.caption2).foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(16)
        .activityBackgroundTint(Color(hex: 0x1a0d12, opacity: 0.85))
        .activitySystemActionForegroundColor(.white)
        .environment(\.colorScheme, .dark)
    }

    private func value(_ icon: String, _ title: String, _ text: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Label(title, systemImage: icon).font(.caption2.weight(.semibold)).foregroundStyle(tint).lineLimit(1)
            Text(text).font(.system(.callout, design: .rounded).weight(.bold)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.7)
                .privacySensitive(false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
