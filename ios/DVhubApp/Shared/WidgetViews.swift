// WidgetViews.swift — Inhalt der Widgets. Liegt in Shared/, damit die App
// dieselben Ansichten als Vorschau zeigen kann (Mehr → Darstellung).

import WidgetKit
import SwiftUI
import AppIntents
import DVhubLink

// MARK: - Gemeinsame Bausteine

private extension WidgetSnapshot {
    var gridW: Double { max(gridImportW ?? 0, gridExportW ?? 0) }
    var exporting: Bool { (gridExportW ?? 0) > (gridImportW ?? 0) }
    var gridTitle: String { gridW < 20 ? String(localized: "Netz") : (exporting ? String(localized: "Einspeisung") : String(localized: "Bezug")) }
    var batteryText: String {
        guard let w = batteryW, abs(w) >= 20 else { return String(localized: "Ruhe") }
        return w > 0 ? String(localized: "lädt \(Format.power(w))") : String(localized: "entlädt \(Format.power(w))")
    }
    var alert: String? {
        if emergencyStop == true { return String(localized: "Not-Halt") }
        if let a = alarmsActive, a > 0 { return a == 1 ? String(localized: "1 Alarm") : String(localized: "\(a) Alarme") }
        return nil
    }
    var netPositive: Bool { (todayNetEur ?? 0) >= 0 }
    /// Die Tagessummen gehören zum Tag des Stands — nach Mitternacht nicht mehr
    /// „heute“. `now` ist der Zeitpunkt des Timeline-Eintrags (SnapshotDay im Paket DVhubLink).
    func isToday(_ now: Date) -> Bool { SnapshotDay.of(at, now: now) == .today }
    func dayWord(_ now: Date) -> String { SnapshotDay.of(at, now: now).word }
    /// „Heute verdient“, „Gestern gekostet“ … — als ganze Wendung, damit sie sich übersetzen lässt.
    func netTitle(_ now: Date) -> String {
        switch (SnapshotDay.of(at, now: now), netPositive) {
        case (.today, true): return String(localized: "Heute verdient")
        case (.today, false): return String(localized: "Heute gekostet")
        case (.yesterday, true): return String(localized: "Gestern verdient")
        case (.yesterday, false): return String(localized: "Gestern gekostet")
        case (.older, true): return String(localized: "Zuletzt verdient")
        case (.older, false): return String(localized: "Zuletzt gekostet")
        }
    }
    func standText(_ now: Date) -> String {
        isToday(now) ? Format.time(at) : Format.shortDateTime(at)
    }
}

private struct Missing: View {
    let groupAvailable: Bool
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "bolt.fill").font(.title2).foregroundStyle(Brand.yellow)
            Text(groupAvailable ? String(localized: "DVhub öffnen, um Werte zu laden") : String(localized: "Widgets brauchen eine App-Gruppe"))
                .font(.caption2).multilineTextAlignment(.center).foregroundStyle(Brand.text2)
        }
        .padding(4)
    }
}

private struct Stand: View {
    let snapshot: WidgetSnapshot
    let now: Date
    var body: some View {
        // Mit Datum, sobald der Stand nicht von heute ist. Werte der Beispielanlage sind als Demo gekennzeichnet.
        Text(snapshot.isDemo ? "Demo · \(snapshot.standText(now))" : "Stand \(snapshot.standText(now))")
            .font(.caption2.weight(.medium).monospacedDigit()).foregroundStyle(Brand.dim)
            .lineLimit(1).minimumScaleFactor(0.7)
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
    /// Geldwerte: bei gesperrtem Gerät und in der Vorschau des Systems unkenntlich.
    var sensitive = false

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Label(title, systemImage: icon).font(.caption2.weight(.semibold)).foregroundStyle(tint).lineLimit(1)
            Text(value).font(.system(.callout, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
                .lineLimit(1).minimumScaleFactor(0.6)
                .privacySensitive(sensitive)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct WidgetBackground: View {
    var body: some View {
        ZStack {
            // Feste dunkle Farben, nicht die anpassenden aus Brand: Den Hintergrund zeichnet
            // das System in seiner eigenen Umgebung — im hellen Modus wäre er sonst hell,
            // mit der hellen Schrift des (immer dunklen) Widgets darauf.
            LinearGradient(colors: [Color(hex: 0x0a1226), Color(hex: 0x030610)], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [Color(hex: 0x34dbff, opacity: 0.20), .clear], center: .topLeading, startRadius: 0, endRadius: 170)
            RadialGradient(colors: [Color(hex: 0xa78bff, opacity: 0.16), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 170)
        }
    }
}

// MARK: - Anlage (klein, mittel, Sperrbildschirm)

struct StatusWidgetContent: View {
    let snapshot: WidgetSnapshot?
    let family: WidgetFamily
    var groupAvailable = true
    /// Zeitpunkt, für den gezeichnet wird (Timeline-Eintrag).
    var now = Date()
    /// Im echten Widget: Aktualisieren-Knopf zeigen (in der Vorschau der App nicht).
    var interactive = false

    var body: some View {
        Group {
            if let s = snapshot {
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
                Missing(groupAvailable: groupAvailable)
            }
        }
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
            Cell(icon: "sun.max.fill", title: String(localized: "Erzeugung"), value: Format.power(s.pvW), tint: Brand.pv)
            Stand(snapshot: s, now: now)
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
                        Text("Akku").font(.caption2.weight(.semibold)).foregroundStyle(Brand.text2)
                    }
                    .padding(8)
                }
                .frame(width: 84, height: 84)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Akku \(Format.percent(s.soc)), \(s.batteryText)")
                Text(s.batteryText).font(.caption2.weight(.medium)).foregroundStyle(Brand.text2).lineLimit(1).minimumScaleFactor(0.7)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Cell(icon: "sun.max.fill", title: String(localized: "Erzeugung"), value: Format.power(s.pvW), tint: Brand.pv)
                    Cell(icon: "house.fill", title: String(localized: "Verbrauch"), value: Format.power(s.loadW), tint: Brand.home)
                }
                HStack(spacing: 8) {
                    Cell(icon: s.exporting ? "arrow.up.to.line" : "arrow.down.to.line", title: s.gridTitle, value: Format.power(s.gridW),
                         tint: s.exporting ? Brand.cyan : Brand.grid)
                    Cell(icon: "eurosign.circle.fill", title: s.netTitle(now),
                         value: Format.euro(abs(s.todayNetEur ?? 0)), tint: s.netPositive ? Brand.money : Brand.red, sensitive: true)
                }
                HStack {
                    if let a = s.alert {
                        Label(a, systemImage: "exclamationmark.triangle.fill").font(.caption2.weight(.bold)).foregroundStyle(Brand.red)
                    } else {
                        Text(s.boxName).font(.caption2.weight(.semibold)).foregroundStyle(Brand.text2).lineLimit(1)
                    }
                    Spacer()
                    Stand(snapshot: s, now: now)
                    if interactive {
                        // Nur Lesen: holt einen frischen Stand (Shared/SharedIntents.swift).
                        Button(intent: RefreshSnapshotIntent()) {
                            Image(systemName: "arrow.clockwise").font(.caption2.weight(.bold)).foregroundStyle(Brand.cyan)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Aktualisieren")
                    }
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
        .accessibilityLabel(s.isDemo ? "Demo: Akku \(Format.percent(s.soc))" : "Akku \(Format.percent(s.soc))")
    }

    private func rectangular(_ s: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Image(systemName: "bolt.fill")
                Text(s.isDemo ? "DVhub Demo" : "DVhub").fontWeight(.bold)
                Spacer()
                Text(s.isToday(now) ? Format.time(s.at) : s.dayWord(now)).font(.caption2.monospacedDigit())
            }
            .font(.caption)
            Text("Akku \(Format.percent(s.soc)) · PV \(Format.power(s.pvW))").font(.caption.monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7)
            Text("\(s.gridTitle) \(Format.power(s.gridW)) · Haus \(Format.power(s.loadW))").font(.caption.monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func inline(_ s: WidgetSnapshot) -> some View {
        // Nach Mitternacht ist die Tagessumme von gestern — dann stattdessen sagen, von wann der Stand ist.
        // Einzeilig über der Uhr: nur Akku und Erzeugung. Geldwerte stehen dort
        // bewusst nicht — die Zeile ist auch bei gesperrtem Gerät lesbar.
        if s.isDemo {
            Label("Demo · \(Format.percent(s.soc)) · PV \(Format.power(s.pvW))", systemImage: "bolt.fill")
        } else {
            Label(s.isToday(now) ? "\(Format.percent(s.soc)) · PV \(Format.power(s.pvW))" : "\(Format.percent(s.soc)) · \(s.dayWord(now))",
                  systemImage: "bolt.fill")
        }
    }
}

// MARK: - Heute verdient / gekostet

struct MoneyWidgetContent: View {
    let snapshot: WidgetSnapshot?
    let family: WidgetFamily
    var groupAvailable = true
    /// Zeitpunkt, für den gezeichnet wird (Timeline-Eintrag).
    var now = Date()

    var body: some View {
        Group {
            if let s = snapshot {
                if family == .accessoryRectangular { rectangular(s) } else { small(s) }
            } else {
                Missing(groupAvailable: groupAvailable)
            }
        }
    }

    private func small(_ s: WidgetSnapshot) -> some View {
        let tint = s.netPositive ? Brand.money : Brand.red
        return VStack(alignment: .leading, spacing: 4) {
            Label(s.netTitle(now), systemImage: "eurosign.circle.fill")
                .font(.caption.weight(.semibold)).foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.8)
            Text(Format.euro(abs(s.todayNetEur ?? 0)))
                .privacySensitive()
                .font(.system(.title, design: .rounded).weight(.bold)).monospacedDigit().foregroundStyle(Brand.text)
                .lineLimit(1).minimumScaleFactor(0.5)
            Spacer(minLength: 0)
            HStack {
                Image(systemName: "arrow.up.right").foregroundStyle(Brand.money)
                Text(Format.euro(s.todayRevenueEur)).foregroundStyle(Brand.text).privacySensitive()
            }
            .font(.system(.caption, design: .rounded).weight(.semibold)).monospacedDigit()
            .accessibilityElement(children: .ignore).accessibilityLabel("Erlös \(Format.euro(s.todayRevenueEur))")
            HStack {
                Image(systemName: "arrow.down.right").foregroundStyle(Brand.red)
                Text(Format.euro(s.todayCostEur)).foregroundStyle(Brand.text).privacySensitive()
            }
            .font(.system(.caption, design: .rounded).weight(.semibold)).monospacedDigit()
            .accessibilityElement(children: .ignore).accessibilityLabel("Kosten \(Format.euro(s.todayCostEur))")
            Stand(snapshot: s, now: now)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rectangular(_ s: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Label(s.isDemo ? "Demo · \(s.netTitle(now))" : s.netTitle(now), systemImage: "eurosign.circle.fill").font(.caption.weight(.bold))
            Text(Format.euro(abs(s.todayNetEur ?? 0))).font(.system(.title3, design: .rounded).weight(.bold)).monospacedDigit()
                .privacySensitive()
            Text("Erlös \(Format.euro(s.todayRevenueEur)) · Kosten \(Format.euro(s.todayCostEur))").font(.caption2.monospacedDigit())
                .lineLimit(1).minimumScaleFactor(0.7)
                .privacySensitive()
        }
        .accessibilityElement(children: .combine)
    }
}

