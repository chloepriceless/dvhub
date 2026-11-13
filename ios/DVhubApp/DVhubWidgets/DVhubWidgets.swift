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

// MARK: - Gemeinsame Bausteine

private extension WidgetSnapshot {
    var gridW: Double { max(gridImportW ?? 0, gridExportW ?? 0) }
    var exporting: Bool { (gridExportW ?? 0) > (gridImportW ?? 0) }
    var gridTitle: String { gridW < 20 ? "Netz" : (exporting ? "Einspeisung" : "Bezug") }
    var batteryText: String {
        guard let w = batteryW, abs(w) >= 20 else { return "Ruhe" }
        return (w > 0 ? "lädt " : "entlädt ") + Format.power(w)
    }
    var alert: String? {
        if emergencyStop == true { return "Not-Halt" }
        if let a = alarmsActive, a > 0 { return a == 1 ? "1 Alarm" : "\(a) Alarme" }
        return nil
    }
    var netPositive: Bool { (todayNetEur ?? 0) >= 0 }
}

private struct Missing: View {
    let groupAvailable: Bool
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "bolt.fill").font(.title2).foregroundStyle(Brand.yellow)
            Text(groupAvailable ? "DVhub öffnen, um Werte zu laden" : "Widgets brauchen eine App-Gruppe")
                .font(.caption2).multilineTextAlignment(.center).foregroundStyle(Brand.text2)
        }
        .padding(4)
    }
}

private struct Stand: View {
    let at: Date
    var body: some View {
        Text("Stand \(Format.time(at))").font(.system(size: 10, weight: .medium).monospacedDigit()).foregroundStyle(Brand.dim)
    }
}

private struct Ring: View {
    let soc: Double?
    var lineWidth: CGFloat = 9
    var body: some View {
        let f = max(0, min(1, (soc ?? 0) / 100))
        ZStack {
            Circle().stroke(Brand.hairline, lineWidth: lineWidth)
            Circle().trim(from: 0, to: f)
                .stroke(AngularGradient(colors: [Brand.cyan, Brand.battery], center: .center, startAngle: .degrees(0), endAngle: .degrees(360 * f)),
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
    }
}

private struct Cell: View {
    let icon: String
    let title: String
    let value: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Label(title, systemImage: icon).font(.system(size: 10, weight: .semibold)).foregroundStyle(tint).lineLimit(1)
            Text(value).font(.system(.callout, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
                .lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct WidgetBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Brand.bg1, Brand.bg0], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [Color(hex: 0x34dbff, opacity: 0.20), .clear], center: .topLeading, startRadius: 0, endRadius: 170)
            RadialGradient(colors: [Color(hex: 0xa78bff, opacity: 0.16), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 170)
        }
    }
}

// MARK: - Anlage (klein, mittel, Sperrbildschirm)

struct StatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatusEntry

    var body: some View {
        Group {
            if let s = entry.snapshot {
                switch family {
                case .systemMedium: medium(s)
                case .accessoryCircular: circular(s)
                case .accessoryRectangular: rectangular(s)
                case .accessoryInline: inline(s)
                default: small(s)
                }
            } else if family == .accessoryInline {
                Text("DVhub öffnen")
            } else if family == .accessoryCircular {
                Image(systemName: "bolt.slash")
            } else {
                Missing(groupAvailable: entry.groupAvailable)
            }
        }
        .containerBackground(for: .widget) { WidgetBackground() }
        .environment(\.colorScheme, .dark)
    }

    private func small(_ s: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                ZStack {
                    Ring(soc: s.soc, lineWidth: 7)
                    Text(Format.percent(s.soc)).font(.system(.footnote, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
                        .minimumScaleFactor(0.6).padding(6)
                }
                .frame(width: 58, height: 58)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Akku \(Format.percent(s.soc))")
                Spacer()
                if let a = s.alert {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Brand.red).accessibilityLabel(a)
                } else {
                    Image(systemName: "bolt.fill").foregroundStyle(Brand.yellow).accessibilityHidden(true)
                }
            }
            Spacer(minLength: 0)
            Cell(icon: "sun.max.fill", title: "Erzeugung", value: Format.power(s.pvW), tint: Brand.pv)
            Stand(at: s.at)
        }
    }

    private func medium(_ s: WidgetSnapshot) -> some View {
        HStack(spacing: 14) {
            VStack(spacing: 4) {
                ZStack {
                    Ring(soc: s.soc)
                    VStack(spacing: 0) {
                        Text(Format.percent(s.soc)).font(.system(.title3, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
                            .minimumScaleFactor(0.6)
                        Text("Akku").font(.system(size: 9, weight: .semibold)).foregroundStyle(Brand.text2)
                    }
                    .padding(8)
                }
                .frame(width: 84, height: 84)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Akku \(Format.percent(s.soc)), \(s.batteryText)")
                Text(s.batteryText).font(.system(size: 10, weight: .medium)).foregroundStyle(Brand.text2).lineLimit(1).minimumScaleFactor(0.7)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Cell(icon: "sun.max.fill", title: "Erzeugung", value: Format.power(s.pvW), tint: Brand.pv)
                    Cell(icon: "house.fill", title: "Verbrauch", value: Format.power(s.loadW), tint: Brand.home)
                }
                HStack(spacing: 8) {
                    Cell(icon: s.exporting ? "arrow.up.to.line" : "arrow.down.to.line", title: s.gridTitle, value: Format.power(s.gridW),
                         tint: s.exporting ? Brand.cyan : Brand.grid)
                    Cell(icon: "eurosign.circle.fill", title: s.netPositive ? "Heute verdient" : "Heute gekostet",
                         value: Format.euro(abs(s.todayNetEur ?? 0)), tint: s.netPositive ? Brand.money : Brand.red)
                }
                HStack {
                    if let a = s.alert {
                        Label(a, systemImage: "exclamationmark.triangle.fill").font(.system(size: 10, weight: .bold)).foregroundStyle(Brand.red)
                    } else {
                        Text(s.boxName).font(.system(size: 10, weight: .semibold)).foregroundStyle(Brand.text2).lineLimit(1)
                    }
                    Spacer()
                    Stand(at: s.at)
                }
            }
        }
    }

    private func circular(_ s: WidgetSnapshot) -> some View {
        Gauge(value: max(0, min(100, s.soc ?? 0)), in: 0...100) {
            Image(systemName: "bolt.fill")
        } currentValueLabel: {
            Text("\(Int((s.soc ?? 0).rounded()))")
        }
        .gaugeStyle(.accessoryCircular)
        .accessibilityLabel("Akku \(Format.percent(s.soc))")
    }

    private func rectangular(_ s: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Image(systemName: "bolt.fill")
                Text("DVhub").fontWeight(.bold)
                Spacer()
                Text(Format.time(s.at)).font(.caption2.monospacedDigit())
            }
            .font(.caption)
            Text("Akku \(Format.percent(s.soc)) · PV \(Format.power(s.pvW))").font(.caption.monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7)
            Text("\(s.gridTitle) \(Format.power(s.gridW)) · Haus \(Format.power(s.loadW))").font(.caption.monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7)
        }
        .accessibilityElement(children: .combine)
    }

    private func inline(_ s: WidgetSnapshot) -> some View {
        Label("\(Format.percent(s.soc)) · PV \(Format.power(s.pvW)) · \(Format.euro(s.todayNetEur))", systemImage: "bolt.fill")
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

// MARK: - Heute verdient / gekostet

struct MoneyWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatusEntry

    var body: some View {
        Group {
            if let s = entry.snapshot {
                if family == .accessoryRectangular { rectangular(s) } else { small(s) }
            } else {
                Missing(groupAvailable: entry.groupAvailable)
            }
        }
        .containerBackground(for: .widget) { WidgetBackground() }
        .environment(\.colorScheme, .dark)
    }

    private func small(_ s: WidgetSnapshot) -> some View {
        let tint = s.netPositive ? Brand.money : Brand.red
        return VStack(alignment: .leading, spacing: 4) {
            Label(s.netPositive ? "Heute verdient" : "Heute gekostet", systemImage: "eurosign.circle.fill")
                .font(.system(size: 11, weight: .semibold)).foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.8)
            Text(Format.euro(abs(s.todayNetEur ?? 0)))
                .font(.system(.title, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
                .lineLimit(1).minimumScaleFactor(0.5)
            Spacer(minLength: 0)
            HStack {
                Image(systemName: "arrow.up.right").foregroundStyle(Brand.money)
                Text(Format.euro(s.todayRevenueEur)).foregroundStyle(Brand.text)
            }
            .font(.system(.caption, design: .rounded).weight(.semibold)).monospacedDigit()
            .accessibilityElement(children: .ignore).accessibilityLabel("Erlös \(Format.euro(s.todayRevenueEur))")
            HStack {
                Image(systemName: "arrow.down.right").foregroundStyle(Brand.red)
                Text(Format.euro(s.todayCostEur)).foregroundStyle(Brand.text)
            }
            .font(.system(.caption, design: .rounded).weight(.semibold)).monospacedDigit()
            .accessibilityElement(children: .ignore).accessibilityLabel("Kosten \(Format.euro(s.todayCostEur))")
            Stand(at: s.at)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rectangular(_ s: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Label(s.netPositive ? "Heute verdient" : "Heute gekostet", systemImage: "eurosign.circle.fill").font(.caption.weight(.bold))
            Text(Format.euro(abs(s.todayNetEur ?? 0))).font(.system(.title3, design: .rounded).weight(.bold)).monospacedDigit()
            Text("Erlös \(Format.euro(s.todayRevenueEur)) · Kosten \(Format.euro(s.todayCostEur))").font(.caption2.monospacedDigit())
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .accessibilityElement(children: .combine)
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
