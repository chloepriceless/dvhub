// DVhubWidgets.swift — Widgets für Home- und Sperrbildschirm.
//
// So bleiben die Werte aktuell (Apple: „Keeping a widget up to date“):
//   1. Ist die App offen, schreibt sie alle 30 s den Stand in die App-Gruppe
//      und lässt die Widgets neu zeichnen.
//   2. Im Hintergrund holt die App ihn mit einer BGAppRefreshTask
//      (DVhubApp/BackgroundRefresh.swift), so oft das System das zulässt.
//   3. Zeichnet das System ein Widget neu und der Stand ist älter als zehn
//      Minuten, ruft das Widget selbst ab (Shared/LinkAccess.swift): Heimnetz
//      zuerst, sonst über das Relay — Ende zu Ende verschlüsselt wie die App.
// Die Zugangsdaten liegen dafür in einer geteilten Schlüsselbund-Gruppe, nie
// im Container der App-Gruppe. Der Geräteschlüssel bleibt in der Secure
// Enclave und ist nur bei entsperrtem Gerät nutzbar: Gesperrt bleibt der
// letzte Stand stehen, jedes Widget zeigt deshalb, von wann er ist.

import WidgetKit
import SwiftUI

struct StatusEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    /// Ohne App-Gruppe (Signatur ohne diese Fähigkeit) gibt es nie Daten.
    let groupAvailable: Bool
}

struct StatusProvider: TimelineProvider {
    /// Das System fragt frühestens nach dieser Zeit wieder (es entscheidet selbst, wann genau).
    static let reloadAfter: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> StatusEntry {
        StatusEntry(date: Date(), snapshot: .sample, groupAvailable: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : entry(SharedStore.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        Task {
            var snapshot = SharedStore.read()
            if !context.isPreview, SharedStore.isAvailable, SnapshotRefresher.isDue(snapshot) {
                if case .fresh(let fresh) = await SnapshotRefresher.refresh(timeout: 10) { snapshot = fresh }
            }
            // Dazu ein Eintrag zum Tageswechsel: Ab Mitternacht sind die
            // Tagessummen nicht mehr „heute“ — das darf nicht vom Neuladen abhängen.
            let now = entry(snapshot)
            var entries = [now]
            // Demo: Der Verlauf steht fest — die nächsten Stände gleich mitgeben (jeder mit seinen eigenen Tagessummen).
            let ahead = context.isPreview ? [] : SnapshotRefresher.ahead()
            entries += ahead.map { StatusEntry(date: $0.at, snapshot: $0, groupAvailable: now.groupAvailable) }
            let cal = Calendar.current
            if ahead.isEmpty, let midnight = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now.date)) {
                entries.append(StatusEntry(date: midnight, snapshot: now.snapshot, groupAvailable: now.groupAvailable))
            }
            completion(Timeline(entries: entries, policy: .after(Date().addingTimeInterval(Self.reloadAfter))))
        }
    }

    private func entry(_ snapshot: WidgetSnapshot?) -> StatusEntry {
        StatusEntry(date: Date(), snapshot: snapshot, groupAvailable: SharedStore.isAvailable)
    }
}

// MARK: - Widgets

struct StatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatusEntry

    var body: some View {
        StatusWidgetContent(snapshot: entry.snapshot, family: family, groupAvailable: entry.groupAvailable, now: entry.date, interactive: true)
            .containerBackground(for: .widget) { WidgetBackground() }
            .environment(\.colorScheme, .dark)
            .widgetURL(DeepLink.dashboard)
    }
}

struct DVhubStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: SharedStore.widgetKindStatus, provider: StatusProvider()) { entry in
            StatusWidgetView(entry: entry)
        }
        .configurationDisplayName("Anlage")
        .description("Akkustand, Erzeugung, Einspeisung und Hausverbrauch.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct MoneyWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatusEntry

    var body: some View {
        MoneyWidgetContent(snapshot: entry.snapshot, family: family, groupAvailable: entry.groupAvailable, now: entry.date)
            .containerBackground(for: .widget) { WidgetBackground() }
            .environment(\.colorScheme, .dark)
            .widgetURL(DeepLink.money)
    }
}

struct DVhubMoneyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: SharedStore.widgetKindMoney, provider: StatusProvider()) { entry in
            MoneyWidgetView(entry: entry)
        }
        .configurationDisplayName("Heute")
        .description("Was die Anlage heute verdient oder gekostet hat.")
        .supportedFamilies([.systemSmall, .accessoryRectangular])
    }
}

// MARK: - Kontrollzentrum

/// Zustand für den Knopf: Ist der Not-Halt aktiv? Aus dem letzten Stand; ist
/// der alt, vorher ein eigener Abruf.
struct EmergencyStopValueProvider: ControlValueProvider {
    var previewValue: Bool { false }

    func currentValue() async throws -> Bool {
        var snapshot = SharedStore.read()
        if SharedStore.isAvailable, SnapshotRefresher.isDue(snapshot, maxAge: 120) {
            if case .fresh(let fresh) = await SnapshotRefresher.refresh(timeout: 8) { snapshot = fresh }
        }
        return snapshot?.emergencyStop == true
    }
}

struct EmergencyStopControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: SharedStore.controlKindStop, provider: EmergencyStopValueProvider()) { active in
            ControlWidgetButton(action: OpenEmergencyStopIntent()) {
                Label(active ? "Not-Halt aktiv" : "Not-Halt", systemImage: active ? "exclamationmark.octagon.fill" : "stop.circle")
            } actionLabel: { _ in
                Text(active ? "Aufheben …" : "Auslösen …")
            }
            .tint(.red)
        }
        .displayName("Not-Halt")
        .description("Öffnet DVhub mit der Rückfrage zum Not-Halt. Geschaltet wird erst nach Bestätigung in der App.")
    }
}

// MARK: - Live-Aktivität

struct EmergencyStopLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: EmergencyStopAttributes.self) { context in
            EmergencyStopLockScreenView(attributes: context.attributes, state: context.state, isStale: context.isStale)
                .widgetURL(DeepLink.control)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Not-Halt", systemImage: "exclamationmark.octagon.fill")
                        .font(.headline).foregroundStyle(Brand.red)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StopTimer(since: context.state.since)
                        .font(.system(.headline, design: .rounded))
                        .frame(maxWidth: 90, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.boxName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Label(Format.percent(context.state.soc), systemImage: "battery.75percent").foregroundStyle(Brand.battery)
                        Spacer()
                        Label(Format.power(context.state.pvW), systemImage: "sun.max.fill").foregroundStyle(Brand.pv)
                        Spacer()
                        Label(Format.power(context.state.gridW), systemImage: context.state.exporting ? "arrow.up.to.line" : "arrow.down.to.line")
                            .foregroundStyle(context.state.exporting ? Brand.cyan : Brand.grid)
                    }
                    .font(.system(.subheadline, design: .rounded).weight(.semibold)).monospacedDigit()
                    Text(context.isStale ? "Werte von \(Format.time(context.state.updatedAt)) – zum Aktualisieren DVhub öffnen"
                                         : "Stand \(Format.time(context.state.updatedAt)) · DVhub schreibt keine Sollwerte")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
                }
            } compactLeading: {
                Image(systemName: "exclamationmark.octagon.fill").foregroundStyle(Brand.red)
                    .accessibilityLabel("Not-Halt aktiv")
            } compactTrailing: {
                StopTimer(since: context.state.since).frame(maxWidth: 52)
                    .font(.system(.caption, design: .rounded).weight(.semibold))
            } minimal: {
                Image(systemName: "exclamationmark.octagon.fill").foregroundStyle(Brand.red)
                    .accessibilityLabel("Not-Halt aktiv")
            }
            .keylineTint(Brand.red)
            .widgetURL(DeepLink.control)
        }
    }
}

@main
struct DVhubWidgetBundle: WidgetBundle {
    var body: some Widget {
        DVhubStatusWidget()
        DVhubMoneyWidget()
        EmergencyStopControl()
        EmergencyStopLiveActivity()
    }
}
