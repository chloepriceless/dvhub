// DVhubWidgets.swift — Widgets für Home- und Sperrbildschirm.
//
// Die Widgets lesen nur den letzten Stand, den die App in den Container der
// App-Gruppe gelegt hat (Shared/WidgetSnapshot.swift). Sie bauen selbst keine
// Verbindung auf: Der Geräteschlüssel liegt in der Secure Enclave der App und
// ist nur dort und nur bei entsperrtem Gerät nutzbar. Jedes Widget zeigt
// deshalb, von wann sein Stand ist.

import WidgetKit
import SwiftUI

struct StatusEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    /// Ohne App-Gruppe (Signatur ohne diese Fähigkeit) gibt es nie Daten.
    let groupAvailable: Bool
}

struct StatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry {
        StatusEntry(date: Date(), snapshot: .sample, groupAvailable: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        // Neu lesen, sobald die App schreibt (reloadAllTimelines); sonst alle
        // 30 min, damit die Altersangabe stimmt.
        completion(Timeline(entries: [entry()], policy: .after(Date().addingTimeInterval(1800))))
    }

    private func entry() -> StatusEntry {
        StatusEntry(date: Date(), snapshot: SharedStore.read(), groupAvailable: SharedStore.isAvailable)
    }
}

// MARK: - Widgets

struct StatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatusEntry

    var body: some View {
        StatusWidgetContent(snapshot: entry.snapshot, family: family, groupAvailable: entry.groupAvailable)
            .containerBackground(for: .widget) { WidgetBackground() }
            .environment(\.colorScheme, .dark)
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
        MoneyWidgetContent(snapshot: entry.snapshot, family: family, groupAvailable: entry.groupAvailable)
            .containerBackground(for: .widget) { WidgetBackground() }
            .environment(\.colorScheme, .dark)
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

@main
struct DVhubWidgetBundle: WidgetBundle {
    var body: some Widget {
        DVhubStatusWidget()
        DVhubMoneyWidget()
    }
}
