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
                row(.plan, String(localized: "Fahrplan"), String(localized: "EOS-Plan und Zeitplan"), "calendar.day.timeline.left", Brand.violet)
                row(.integrations, String(localized: "Integrationen"), String(localized: "Zustand der Anbindungen"), "point.3.connected.trianglepath.dotted", Brand.cyan)
                row(.system, String(localized: "System"), String(localized: "Einstellungen ansehen"), "gearshape.2.fill", Brand.blue)
                if model.selected?.canControl == true {
                    row(.control, String(localized: "Steuern"), String(localized: "Not-Halt"), "exclamationmark.octagon.fill", Brand.red)
                }
            }
            SwiftUI.Section("App") {
                row(.systems, String(localized: "Anlagen"), String(localized: "\(model.systems.count) gekoppelt"), "qrcode.viewfinder", Brand.green)
                row(.appearance, String(localized: "Darstellung"), String(localized: "Farben, Navigation, Widgets, Live-Aktivität"), "paintpalette.fill", Brand.pink)
                row(.about, String(localized: "Über"), String(localized: "Version, Datenschutz"), "info.circle.fill", Brand.yellow)
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
                    Text(chrome.railActive ? String(localized: "Gerade aktiv: Seitenleiste rechts.") : String(localized: "Gerade aktiv: Leiste unten bzw. oben."))
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
