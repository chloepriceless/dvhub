// MoreView.swift — „Mehr“: Fahrplan, Integrationen, System, Steuern, Anlagen,
// Darstellung, Widgets, Über.

import SwiftUI
import WidgetKit
import DVhubLink

/// Liste der Bereiche — die Seitenspalte der geteilten Ansicht. Eine
/// System-Liste mit Auswahl: zugeklappt führt sie in den Bereich hinein,
/// aufgeklappt steht der Bereich daneben.
struct MoreView: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: MoreRoute?

    var body: some View {
        List(selection: $selection) {
            if let c = model.selected {
                SwiftUI.Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(c.credentials.boxName).font(.title3.weight(.bold)).foregroundStyle(Brand.text)
                        ConnectionBadge(controller: c)
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 8, trailing: 4))
                }
            }
            SwiftUI.Section("Anlage") {
                row(.plan, "Fahrplan", "EOS-Plan und Zeitplan", "calendar.day.timeline.left", Brand.violet)
                row(.integrations, "Integrationen", "Zustand der Anbindungen", "point.3.connected.trianglepath.dotted", Brand.cyan)
                row(.system, "System", "Einstellungen ansehen", "gearshape.2.fill", Brand.blue)
                if model.selected?.canControl == true {
                    row(.control, "Steuern", "Not-Halt", "exclamationmark.octagon.fill", Brand.red)
                }
            }
            SwiftUI.Section("App") {
                row(.systems, "Anlagen", "\(model.systems.count) gekoppelt", "qrcode.viewfinder", Brand.green)
                row(.appearance, "Darstellung", "Farben, Navigation, Widgets", "paintpalette.fill", Brand.pink)
                row(.about, "Über", "Version, Datenschutz", "info.circle.fill", Brand.yellow)
            }
            if let err = model.storageError {
                SwiftUI.Section { Label(err, systemImage: "exclamationmark.triangle").foregroundStyle(Brand.orange) }
            }
        }
        .navigationTitle("Mehr")
        .auroraList()
    }

    private func row(_ route: MoreRoute, _ title: String, _ text: String, _ icon: String, _ tint: Color) -> some View {
        NavigationLink(value: route) {
            Label {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.body.weight(.semibold))
                    Text(text).font(.caption).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: icon).foregroundStyle(tint)
            }
        }
        .accessibilityIdentifier("more.\(route.rawValue)")
    }
}

/// Aufgeklappt, noch nichts gewählt: der Platz neben der Liste.
struct MoreOverview: View {
    var body: some View {
        ContentUnavailableView("Bereich wählen", systemImage: "sidebar.left",
                               description: Text("Fahrplan, Integrationen, System und Einstellungen der App stehen links."))
            .background(AuroraBackground())
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
        AuroraPage(inlineTitle: true) { _ in
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
                    if !chrome.diagnostics.isEmpty {
                        Text(chrome.diagnostics).font(.caption2.monospaced()).foregroundStyle(Brand.dim)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("layoutDiagnostics")
                    }
                }
            }
            WidgetInfoCard()
        }
        .navigationTitle("Darstellung")
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
                WidgetGallery(snapshot: SharedStore.read() ?? .sample)
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
        AuroraPage(inlineTitle: true) { _ in
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

/// So sehen die Widgets aus — dieselben Ansichten wie in der Erweiterung.
struct WidgetGallery: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 12) {
                tile(StatusWidgetContent(snapshot: snapshot, family: .systemSmall), CGSize(width: 158, height: 158))
                tile(StatusWidgetContent(snapshot: snapshot, family: .systemMedium), CGSize(width: 338, height: 158))
                tile(MoneyWidgetContent(snapshot: snapshot, family: .systemSmall), CGSize(width: 158, height: 158))
                VStack(alignment: .leading, spacing: 8) {
                    lock(StatusWidgetContent(snapshot: snapshot, family: .accessoryRectangular), CGSize(width: 160, height: 66))
                    HStack(spacing: 8) {
                        lock(StatusWidgetContent(snapshot: snapshot, family: .accessoryCircular), CGSize(width: 66, height: 66))
                        lock(MoneyWidgetContent(snapshot: snapshot, family: .accessoryRectangular), CGSize(width: 160, height: 66))
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .padding(.horizontal, -16)
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Vorschau der Widgets")
        .accessibilityIdentifier("widgetGallery")
    }

    private func tile<V: View>(_ v: V, _ size: CGSize) -> some View {
        v.padding(14)
            .frame(width: size.width, height: size.height)
            .background(WidgetBackground())
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Brand.border, lineWidth: 1))
    }

    /// Sperrbildschirm: einfarbig auf dunklem Grund.
    private func lock<V: View>(_ v: V, _ size: CGSize) -> some View {
        v.foregroundStyle(.white)
            .tint(.white)
            .padding(6)
            .frame(width: size.width, height: size.height)
            .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
