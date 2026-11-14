// MoreView.swift — „Mehr“ (schmal) und die Seitenleiste (breit): Fahrplan,
// E-Auto, Integrationen, System, Steuern, Anlagen, Darstellung, Widgets, Über.

import SwiftUI
import WidgetKit
import DVhubLink

extension MoreRoute {
    /// Bereiche der Anlage bzw. der App — in dieser Reihenfolge in „Mehr“ und in der Seitenleiste.
    static let plantRoutes: [MoreRoute] = [.plan, .ev, .integrations, .system, .control]
    static let appRoutes: [MoreRoute] = [.systems, .appearance, .about]

    var title: String {
        switch self {
        case .plan: return String(localized: "Fahrplan")
        case .ev: return String(localized: "E-Auto")
        case .integrations: return String(localized: "Integrationen")
        case .system: return String(localized: "System")
        case .control: return String(localized: "Steuern")
        case .systems: return String(localized: "Anlagen")
        case .appearance: return String(localized: "Darstellung")
        case .about: return String(localized: "Über")
        }
    }

    var icon: String {
        switch self {
        case .plan: return "calendar.day.timeline.left"
        case .ev: return "car.fill"
        case .integrations: return "point.3.connected.trianglepath.dotted"
        case .system: return "gearshape.2.fill"
        case .control: return "exclamationmark.octagon.fill"
        case .systems: return "qrcode.viewfinder"
        case .appearance: return "paintpalette.fill"
        case .about: return "info.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .plan: return Brand.violet
        case .ev: return Brand.green
        case .integrations: return Brand.cyan
        case .system: return Brand.blue
        case .control: return Brand.red
        case .systems: return Brand.green
        case .appearance: return Brand.pink
        case .about: return Brand.yellow
        }
    }

    /// „Steuern“ gibt es nur mit der Freigabe dafür.
    @MainActor static func visible(_ routes: [MoreRoute], model: AppModel) -> [MoreRoute] {
        routes.filter { $0 != .control || model.selected?.canControl == true }
    }
}

/// Kopf beider Listen: Name der Anlage und Verbindung.
private struct SystemHeaderRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
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
    }
}

/// „Mehr“ auf schmaler Fläche: Liste der Bereiche, die in den Bereich hineinführt.
struct MoreView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            SystemHeaderRow()
            SwiftUI.Section("Anlage") {
                ForEach(MoreRoute.visible(MoreRoute.plantRoutes, model: model)) { row($0) }
            }
            SwiftUI.Section("App") {
                ForEach(MoreRoute.visible(MoreRoute.appRoutes, model: model)) { row($0) }
            }
            if let err = model.storageError {
                SwiftUI.Section { Label(err, systemImage: "exclamationmark.triangle").foregroundStyle(Brand.orange) }
            }
        }
        .navigationTitle("Mehr")
        .auroraList()
    }

    private func subtitle(_ route: MoreRoute) -> String {
        switch route {
        case .plan: return String(localized: "EOS-Plan, Zeitplan, Börsenautomatik")
        case .ev: return String(localized: "Laden planen, Ziele setzen")
        case .integrations: return String(localized: "Zustand und Einrichtung")
        case .system: return String(localized: "Einstellungen ansehen")
        case .control: return String(localized: "Not-Halt")
        case .systems: return String(localized: "\(model.systems.count) gekoppelt")
        case .appearance: return String(localized: "Farben, Navigation, Widgets, Live-Aktivität")
        case .about: return String(localized: "Version, Datenschutz")
        }
    }

    private func row(_ route: MoreRoute) -> some View {
        NavigationLink(value: route) {
            Label {
                VStack(alignment: .leading, spacing: 1) {
                    Text(route.title).font(.body.weight(.semibold))
                    Text(subtitle(route)).font(.caption).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: route.icon).foregroundStyle(route.tint)
            }
        }
        .accessibilityIdentifier("more.\(route.rawValue)")
    }
}

/// Seitenleiste auf breiter Fläche (iPhone Duo aufgeklappt, iPad): alle
/// Bereiche der App in einer Liste des Systems — die Reiter und darunter, was
/// schmal unter „Mehr“ steht.
struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: SidebarItem?
    let newsBadge: Int

    var body: some View {
        List(selection: $selection) {
            SystemHeaderRow()
            SwiftUI.Section {
                ForEach(AppTab.allCases.filter { $0 != .more }) { t in
                    Label(t.title, systemImage: t.icon)
                        .badge(t == .news ? newsBadge : 0)
                        .tag(SidebarItem.tab(t))
                        .accessibilityIdentifier("side.\(t.rawValue)")
                }
            }
            SwiftUI.Section("Anlage") {
                ForEach(MoreRoute.visible(MoreRoute.plantRoutes, model: model)) { row($0) }
            }
            SwiftUI.Section("App") {
                ForEach(MoreRoute.visible(MoreRoute.appRoutes, model: model)) { row($0) }
            }
            if let err = model.storageError {
                SwiftUI.Section { Label(err, systemImage: "exclamationmark.triangle").foregroundStyle(Brand.orange) }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle(Text(verbatim: "DVhub"))
        .auroraList()
        .accessibilityIdentifier("sidebar")
    }

    private func row(_ route: MoreRoute) -> some View {
        Label(route.title, systemImage: route.icon)
            .tag(SidebarItem.more(route))
            .accessibilityIdentifier("side.\(route.rawValue)")
    }
}

/// Breit, „Mehr“ gewählt, aber noch kein Bereich: der Platz neben der Seitenleiste.
struct MoreOverview: View {
    var body: some View {
        ContentUnavailableView("Bereich wählen", systemImage: "sidebar.left",
                               description: Text("Fahrplan, E-Auto, Integrationen, System und Einstellungen der App stehen links."))
            .background(AuroraBackground())
    }
}

// MARK: - Darstellung

enum Appearance: String, CaseIterable, Identifiable {
    case dark, light, system
    var id: String { rawValue }
    var title: String {
        switch self {
        case .dark: return String(localized: "Dunkel")
        case .light: return String(localized: "Hell")
        case .system: return String(localized: "Wie das iPhone")
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
                         ? String(localized: "Automatisch: Das iPhone legt die Leisten selbst – zugeklappt (iPhone Duo) und im Querformat an den rechten Rand.")
                         : String(localized: "Automatisch: Im Querformat und auf dem zugeklappten iPhone Duo stehen Reiter und Aktionen rechts, sonst unten. „Rechts“ erzwingt die Seitenleiste überall."))
                        .font(.caption).foregroundStyle(Brand.text2)
                    Text(chrome.railActive ? String(localized: "Gerade aktiv: Seitenleiste rechts.")
                         : Chrome.systemPlacesBars ? String(localized: "Gerade aktiv: Leisten des Systems.")
                         : String(localized: "Gerade aktiv: Leiste unten bzw. oben."))
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
    @State private var liveActivity = LiveActivityManager.enabled
    @State private var reloads = 0

    var body: some View {
        GlassCard(tint: Brand.yellow) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Eyebrow(text: "Widgets", icon: "square.grid.2x2.fill", tint: Brand.yellow)
                    Spacer()
                    Pill(text: SharedStore.isAvailable ? String(localized: "bereit") : String(localized: "nicht verfügbar"), tint: SharedStore.isAvailable ? Brand.green : Brand.orange)
                }
                WidgetGallery(snapshot: SharedStore.read() ?? .sample)
                if SharedStore.isAvailable {
                    Text("Home-Bildschirm lange drücken → „Bearbeiten“ → „Widget hinzufügen“ → DVhub. Für den Sperrbildschirm: Sperrbildschirm lange drücken → „Anpassen“.")
                    if LinkAccess.sharedGroupActive {
                        Text("Die Widgets halten sich selbst aktuell: Die App holt im Hintergrund neue Werte, und ein Widget ruft selbst ab, wenn sein Stand älter als zehn Minuten ist – Ende zu Ende verschlüsselt wie die App. Wie oft das geschieht, entscheidet iOS.")
                        Text("Bei gesperrtem iPhone ist der Geräteschlüssel nicht nutzbar. Dann bleibt der letzte Stand stehen, mit Uhrzeit; Geldwerte sind auf dem Sperrbildschirm verdeckt.")
                    } else {
                        Text("Die Widgets zeigen den letzten Stand, den die App gesehen hat. Selbst abrufen können sie in dieser Installation nicht: Ihr fehlt die geteilte Schlüsselbund-Gruppe für die Zugangsdaten.")
                    }
                    if let s = SharedStore.read() {
                        Text("Letzter Stand für die Widgets: \(Format.dateTime(s.at)).").foregroundStyle(Brand.dim)
                    }
                    Button {
                        reloads += 1
                        WidgetCenter.shared.reloadAllTimelines()
                    } label: { Label("Widgets jetzt aktualisieren", systemImage: "arrow.clockwise") }
                        .font(.footnote.weight(.semibold))
                        .sensoryFeedback(.impact(weight: .light), trigger: reloads)
                } else {
                    Text("Diese Installation hat keine App-Gruppe, über die App und Widgets Daten teilen. Die App läuft normal; die Widgets zeigen einen Hinweis. Mit einer Signatur, die App-Gruppen erlaubt, gehen sie ohne weitere Änderung.")
                }
            }
            .font(.caption)
            .foregroundStyle(Brand.text2)
        }
        GlassCard(tint: Brand.red) {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Live-Aktivität", icon: "platter.filled.top.iphone", tint: Brand.red)
                Toggle("Not-Halt auf dem Sperrbildschirm zeigen", isOn: $liveActivity)
                    .font(.subheadline)
                    .foregroundStyle(Brand.text)
                    .onChange(of: liveActivity) { _, on in LiveActivityManager.enabled = on }
                Text("Solange der Not-Halt aktiv ist, zeigt das iPhone ihn auf dem Sperrbildschirm und in der Dynamic Island, mit Dauer und letzten Werten. Die Werte kommen von der App: sofort, solange sie offen ist, sonst bei jedem Hintergrundabruf, den iOS zulässt.")
                if !LiveActivityManager.allowedBySystem {
                    Text("Live-Aktivitäten sind für DVhub in den iOS-Einstellungen ausgeschaltet.").foregroundStyle(Brand.orange)
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
                    Text(verbatim: "DVhub").font(.system(.largeTitle, design: .rounded).weight(.heavy)).foregroundStyle(Brand.auroraLinear)
                    Text(verbatim: "The unofficial DV interface").font(.subheadline).foregroundStyle(Brand.text2)
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
                    link(String(localized: "Residuallast-Frühwarnung"), "https://dvhub.online/tools/residuallast/")
                    link(String(localized: "Nachrichten im Browser"), "https://dvhub.online/nachrichten")
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
