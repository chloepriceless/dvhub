// MoreView.swift — „Mehr“: Fahrplan, Integrationen, System, Steuern, Anlagen,
// Darstellung, Widgets, Über.

import SwiftUI
import WidgetKit
import DVhubLink

struct MoreView: View {
    @Environment(AppModel.self) private var model
    @Binding var showPairing: Bool

    var body: some View {
        AuroraPage { width in
            if let c = model.selected {
                GlassCard(tint: Brand.cyan) {
                    VStack(alignment: .leading, spacing: 8) {
                        Eyebrow(text: "Anlage", icon: "house.fill", tint: Brand.cyan)
                        Text(c.credentials.boxName).font(.title2.weight(.bold)).foregroundStyle(Brand.text)
                        ConnectionBadge(controller: c)
                    }
                }
            }
            let cols = Array(repeating: GridItem(.flexible(), spacing: 12), count: Layout.isWide(width) ? 3 : 2)
            SectionTitle(text: "Anlage")
            LazyVGrid(columns: cols, spacing: 12) {
                MoreTile(route: .plan, title: "Fahrplan", text: "EOS-Plan und Zeitplan", icon: "calendar.day.timeline.left", tint: Brand.violet)
                MoreTile(route: .integrations, title: "Integrationen", text: "Zustand der Anbindungen", icon: "point.3.connected.trianglepath.dotted", tint: Brand.cyan)
                MoreTile(route: .system, title: "System", text: "Einstellungen ansehen", icon: "gearshape.2.fill", tint: Brand.blue)
                if model.selected?.canControl == true {
                    MoreTile(route: .control, title: "Steuern", text: "Not-Halt", icon: "exclamationmark.octagon.fill", tint: Brand.red)
                }
            }
            SectionTitle(text: "App")
            LazyVGrid(columns: cols, spacing: 12) {
                MoreTile(route: .systems, title: "Anlagen", text: "\(model.systems.count) gekoppelt", icon: "qrcode.viewfinder", tint: Brand.green)
                MoreTile(route: .appearance, title: "Darstellung", text: "Farben, Navigation, Widgets", icon: "paintpalette.fill", tint: Brand.pink)
                MoreTile(route: .about, title: "Über", text: "Version, Datenschutz", icon: "info.circle.fill", tint: Brand.yellow)
            }
            if let err = model.storageError { NoticeBanner(text: err, icon: "exclamationmark.triangle") }
        }
        .navigationTitle("Mehr")
    }
}

private struct MoreTile: View {
    let route: MoreRoute
    let title: String
    let text: String
    let icon: String
    let tint: Color

    var body: some View {
        NavigationLink(value: route) {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: icon).font(.title2).foregroundStyle(tint)
                    .frame(width: 44, height: 44)
                    .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                Text(title).font(.headline).foregroundStyle(Brand.text)
                Text(text).font(.caption).foregroundStyle(Brand.text2).lineLimit(2).multilineTextAlignment(.leading)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 124, alignment: .topLeading)
            .background(CardBackground(tint: tint))
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityIdentifier("more.\(route.rawValue)")
    }
}

// MARK: - Darstellung

enum Appearance: String, CaseIterable, Identifiable {
    case dark, light, system
    var id: String { rawValue }
    var title: String {
        switch self {
        case .dark: return "Dunkel"
        case .light: return "Hell"
        case .system: return "Wie das iPhone"
        }
    }
    var scheme: ColorScheme? {
        switch self {
        case .dark: return .dark
        case .light: return .light
        case .system: return nil
        }
    }
}

struct AppearanceView: View {
    @AppStorage("appearance") private var appearance = Appearance.dark.rawValue
    @AppStorage("navPlacement") private var placement = Chrome.Placement.auto.rawValue
    @Environment(Chrome.self) private var chrome

    var body: some View {
        AuroraPage { _ in
            GlassCard(tint: Brand.pink) {
                VStack(alignment: .leading, spacing: 10) {
                    Eyebrow(text: "Farben", icon: "circle.lefthalf.filled", tint: Brand.pink)
                    Picker("Farben", selection: $appearance) {
                        ForEach(Appearance.allCases) { Text($0.title).tag($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    Text("DVhub ist für das dunkle Aurora-Design gemacht; Hell eignet sich für direkte Sonne.")
                        .font(.caption).foregroundStyle(Brand.text2)
                }
            }
            GlassCard(tint: Brand.cyan) {
                VStack(alignment: .leading, spacing: 10) {
                    Eyebrow(text: "Navigation", icon: "sidebar.right", tint: Brand.cyan)
                    Picker("Navigation", selection: $placement) {
                        ForEach(Chrome.Placement.allCases) { Text($0.title).tag($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("navPlacement")
                    Text(Chrome.systemPlacesBars
                         ? "Automatisch: Das iPhone legt die Leisten selbst – zugeklappt (iPhone Duo) und im Querformat an den rechten Rand."
                         : "Automatisch: Im Querformat und auf dem zugeklappten iPhone Duo stehen Reiter und Aktionen rechts, sonst unten. „Rechts“ erzwingt die Seitenleiste überall.")
                        .font(.caption).foregroundStyle(Brand.text2)
                    Text(chrome.railActive ? "Gerade aktiv: Seitenleiste rechts." : "Gerade aktiv: Leiste unten bzw. oben.")
                        .font(.caption2).foregroundStyle(Brand.dim)
                }
            }
            WidgetInfoCard()
        }
        .navigationTitle("Darstellung")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct WidgetInfoCard: View {
    var body: some View {
        GlassCard(tint: Brand.yellow) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Eyebrow(text: "Widgets", icon: "square.grid.2x2.fill", tint: Brand.yellow)
                    Spacer()
                    Pill(text: SharedStore.isAvailable ? "bereit" : "nicht verfügbar", tint: SharedStore.isAvailable ? Brand.green : Brand.orange)
                }
                if SharedStore.isAvailable {
                    Text("Home-Bildschirm lange drücken → „Bearbeiten“ → „Widget hinzufügen“ → DVhub. Für den Sperrbildschirm: Sperrbildschirm lange drücken → „Anpassen“.")
                    Text("Die Widgets zeigen den letzten Stand, den die App gesehen hat (Akku, Erzeugung, Einspeisung, Verbrauch, heute verdient). Sie holen selbst nichts – die Verbindung zur Anlage braucht den Geräteschlüssel, und der ist nur in der geöffneten App nutzbar.")
                    if let s = SharedStore.read() {
                        Text("Letzter Stand für die Widgets: \(Format.dateTime(s.at)).").foregroundStyle(Brand.dim)
                    }
                    Button { WidgetCenter.shared.reloadAllTimelines() } label: { Label("Widgets jetzt aktualisieren", systemImage: "arrow.clockwise") }
                        .font(.footnote.weight(.semibold))
                } else {
                    Text("Diese Installation hat keine App-Gruppe, über die App und Widgets Daten teilen. Die App läuft normal; die Widgets zeigen einen Hinweis. Mit einer Signatur, die App-Gruppen erlaubt, gehen sie ohne weitere Änderung.")
                }
            }
            .font(.caption)
            .foregroundStyle(Brand.text2)
        }
    }
}

// MARK: - Über

struct AboutView: View {
    private var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "–"
        return "\(v) (\(b))"
    }

    var body: some View {
        AuroraPage { _ in
            GlassCard(tint: Brand.cyan) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("DVhub").font(.system(size: 40, weight: .heavy, design: .rounded)).foregroundStyle(Brand.auroraLinear)
                    Text("The unofficial DV interface").font(.subheadline).foregroundStyle(Brand.text2)
                    Text("Version \(version)").font(.caption.monospaced()).foregroundStyle(Brand.dim)
                }
            }
            GlassCard {
                VStack(alignment: .leading, spacing: 8) {
                    Eyebrow(text: "Womit die App spricht", icon: "lock.shield", tint: Brand.green)
                    Text("**Deine Anlage** – Ende zu Ende verschlüsselt, im Heimnetz direkt, unterwegs über das Relay. Das Relay sieht nur verschlüsselte Daten.")
                    Text("**dvhub.online** – Börsenpreise, Residuallast-Frühwarnung und Nachrichten. Öffentliche Daten; es gehen keine Anlagendaten, keine Kennung und keine Cookies mit.")
                    Text("**Redaktionen** – Vorschaubilder und Artikel der Nachrichten kommen direkt von den genannten Seiten.")
                }
                .font(.footnote)
                .foregroundStyle(Brand.text2)
            }
            GlassCard {
                VStack(alignment: .leading, spacing: 10) {
                    Eyebrow(text: "Links", icon: "link", tint: Brand.text2)
                    link("dvhub.online", "https://dvhub.online")
                    link("Residuallast-Frühwarnung", "https://dvhub.online/tools/residuallast/")
                    link("Nachrichten im Browser", "https://dvhub.online/nachrichten")
                }
            }
        }
        .navigationTitle("Über")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func link(_ title: String, _ url: String) -> some View {
        if let u = URL(string: url) {
            Link(destination: u) {
                HStack { Text(title); Spacer(); Image(systemName: "arrow.up.right") }
                    .font(.subheadline.weight(.semibold))
            }
        }
    }
}
