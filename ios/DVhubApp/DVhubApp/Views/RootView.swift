// RootView.swift — Grundgerüst nach Apples Richtlinien für das iPhone Duo
// (HIG „Designing for iPhone Duo“, Tech Talk 111461; siehe ios/README.md).
//
// Die App nutzt die Standard-Bausteine TabView, NavigationStack und .toolbar.
// Gebaut mit dem iOS-27.1-SDK legt das System deren Leisten selbst um:
//   • zugeklappt (und aufgeklappt im Querformat) an den rechten Rand,
//   • aufgeklappt im Hochformat waagerecht oben und unten — der Inhalt füllt
//     die ganze Fläche und bricht nach Breite in Spalten um (AuroraPage).
// Älteren SDKs fehlt die seitliche Leiste. Dafür gibt es hier einen Ersatz
// mit derselben Anordnung (SideRail): Reiter und Aktionen der Ansicht stehen
// rechts. Er schaltet sich ab, sobald das System die Leisten selbst umlegt.
//
// Auf-/Zuklappen und Drehen bauen nur die Ansicht neu — Verbindung, Auswahl
// und Navigationspfade leben im AppModel bzw. hier im Zustand.

import SwiftUI
import DVhubLink

enum AppTab: String, CaseIterable, Identifiable, Hashable {
    case dashboard, market, history, news, more
    var id: String { rawValue }

    var title: String {
        switch self {
        case .dashboard: return String(localized: "Leitstand")
        case .market: return String(localized: "Markt")
        case .history: return String(localized: "Historie")
        case .news: return String(localized: "Nachrichten")
        case .more: return String(localized: "Mehr")
        }
    }

    var icon: String {
        switch self {
        case .dashboard: return "bolt.circle.fill"
        case .market: return "chart.bar.xaxis"
        case .history: return "calendar"
        case .news: return "newspaper.fill"
        case .more: return "square.grid.2x2.fill"
        }
    }
}

enum MoreRoute: String, Hashable, Identifiable {
    var id: String { rawValue }
    case plan, integrations, system, control, systems, appearance, about
}

// MARK: - Leisten

/// Eine Aktion der gerade sichtbaren Ansicht (Aktualisieren, Heute …).
struct ScreenAction: Identifiable, Equatable {
    let id: String
    let title: String
    let icon: String
    var disabled = false
    let run: () -> Void

    static func == (a: ScreenAction, b: ScreenAction) -> Bool {
        a.id == b.id && a.title == b.title && a.icon == b.icon && a.disabled == b.disabled
    }
}

@MainActor
@Observable
final class Chrome {
    /// Aktionen je Reiter — die seitliche Leiste zeigt die des gewählten.
    var actions: [String: [ScreenAction]] = [:]
    /// Die Ersatz-Seitenleiste ist aktiv (dann keine Toolbar-Knöpfe oben).
    var railActive = false
    /// Zählt angetippte Aktionen (Aktualisieren, Heute …) — löst die Haptik aus.
    var actionTaps = 0

    enum Placement: String, CaseIterable, Identifiable {
        case auto, bottom, side
        var id: String { rawValue }
        var title: String {
            switch self {
            case .auto: return String(localized: "Automatisch")
            case .bottom: return String(localized: "Unten")
            case .side: return String(localized: "Rechts")
            }
        }
    }

    /// Legt das System die Leisten selbst seitlich (Build mit iOS-27.1-SDK oder neuer)?
    static let systemPlacesBars: Bool = {
        guard let sdk = Bundle.main.object(forInfoDictionaryKey: "DTSDKName") as? String else { return false }
        // „iphoneos27.1“, „iphonesimulator27.0“ …
        let digits = sdk.drop { !$0.isNumber }
        let parts = digits.split(separator: ".").compactMap { Int($0) }
        guard let major = parts.first else { return false }
        return major > 27 || (major == 27 && (parts.count > 1 ? parts[1] : 0) >= 1)
    }()

    /// Fläche, Bildschirm und Größenklassen als Text — unter Mehr → Darstellung
    /// ablesbar, um das Verhalten am echten Gerät nachzuvollziehen.
    var diagnostics = ""

    /// Seitenleiste statt Leiste unten? Zugeklappt (Außendisplay) und überall,
    /// wo die Fläche niedrig ist (Querformat) — aufgeklappt hochkant nie: Dort
    /// stehen die Leisten waagerecht, und der Inhalt füllt die Fläche. Nur nach
    /// Fläche und Größenklasse, nie nach Gerätetyp (BarPlacementRule im Paket).
    static func wantsRail(size: CGSize, screen: CGSize = .zero, vertical: UserInterfaceSizeClass?, placement: Placement) -> Bool {
        switch placement {
        case .side: return true
        case .bottom: return false
        case .auto:
            if systemPlacesBars { return false }
            // Die Regel selbst liegt im Paket DVhubLink (BarPlacementRule) und ist dort getestet.
            return BarPlacementRule.sideRail(windowWidth: size.width, windowHeight: size.height, screenWidth: screen.width,
                                             screenHeight: screen.height, verticalCompact: vertical == .compact)
        }
    }
}

private struct ScreenActionsModifier: ViewModifier {
    let owner: AppTab
    let actions: [ScreenAction]
    @Environment(Chrome.self) private var chrome

    func body(content: Content) -> some View {
        content
            .toolbar {
                // Mit Seitenleiste stehen die Aktionen dort, nicht doppelt oben.
                if !chrome.railActive {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        ForEach(actions) { a in
                            Button { chrome.actionTaps += 1; a.run() } label: { Label(a.title, systemImage: a.icon) }
                                .disabled(a.disabled)
                        }
                    }
                }
            }
            .onAppear { chrome.actions[owner.rawValue] = actions }
            .onChange(of: actions) { _, new in chrome.actions[owner.rawValue] = new }
            // Nur die eigenen Aktionen abräumen: In der geteilten Ansicht kann die
            // nächste Seite schon erschienen sein, bevor diese verschwindet.
            .onDisappear { if chrome.actions[owner.rawValue] == actions { chrome.actions[owner.rawValue] = nil } }
    }
}

extension View {
    /// Aktionen dieser Ansicht: als Toolbar-Knöpfe (Label mit Symbol und
    /// Titel — das System legt sie auf dem iPhone Duo an die Seite) bzw. in
    /// der Ersatz-Seitenleiste.
    func screenActions(_ owner: AppTab, _ actions: [ScreenAction]) -> some View {
        modifier(ScreenActionsModifier(owner: owner, actions: actions))
    }
}

/// Leiste am rechten Rand: Reiter oben, Aktionen der Ansicht unten.
struct SideRail: View {
    @Binding var tab: AppTab
    let actions: [ScreenAction]
    let badges: [AppTab: Int]
    var compact = false
    /// Schmales Fenster (Außendisplay mit Systemspalte, 386 pt): Leiste schlanker.
    var narrow = false
    let reselect: (AppTab) -> Void
    @Environment(Chrome.self) private var chrome
    private var width: CGFloat { narrow ? 56 : 66 }
    // Wie die Leisten des Systems wächst diese nicht mit der Schriftgröße mit
    // (feste Maße unten). Dafür zeigt langes Drücken jeden Eintrag groß an
    // (Large Content Viewer) — so macht es auch die Tab-Leiste des Systems.

    var body: some View {
        VStack(spacing: compact ? 2 : 6) {
            ForEach(AppTab.allCases) { t in
                Button {
                    if tab == t { reselect(t) } else { tab = t }
                } label: {
                    VStack(spacing: 2) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(tab == t ? AnyShapeStyle(Brand.cyan.opacity(0.22)) : AnyShapeStyle(Color.clear))
                                .frame(width: 44, height: compact ? 30 : 34)
                            Image(systemName: t.icon).font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(tab == t ? Brand.cyan : Brand.text2)
                        }
                        .overlay(alignment: .topTrailing) {
                            if let n = badges[t], n > 0 {
                                Text(n > 9 ? "9+" : "\(n)").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                                    .padding(.horizontal, 4).padding(.vertical, 1)
                                    .background(Brand.red, in: Capsule()).offset(x: 4, y: -3)
                            }
                        }
                        Text(t.title).font(.system(size: 9.5, weight: .semibold)).foregroundStyle(tab == t ? Brand.cyan : Brand.dim)
                            .lineLimit(1).minimumScaleFactor(0.55).frame(width: width - 6)
                    }
                    .frame(width: width - 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t.title)
                .accessibilityAddTraits(tab == t ? [.isSelected, .isButton] : .isButton)
                .accessibilityShowsLargeContentViewer { Label(t.title, systemImage: t.icon) }
                .accessibilityIdentifier("rail.\(t.rawValue)")
            }
            Spacer(minLength: 4)
            if !actions.isEmpty {
                Rectangle().fill(Brand.border).frame(width: 30, height: 1)
                ForEach(actions) { a in
                    Button { chrome.actionTaps += 1; a.run() } label: {
                        Image(systemName: a.icon).font(.system(size: 18, weight: .semibold))
                            .frame(width: 44, height: 40)
                            .background(Brand.glassStrong, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(a.disabled ? Brand.dim : Brand.text)
                    .disabled(a.disabled)
                    .accessibilityLabel(a.title)
                    .accessibilityShowsLargeContentViewer { Label(a.title, systemImage: a.icon) }
                }
            }
        }
        .padding(.vertical, 10)
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(
            Rectangle().fill(.ultraThinMaterial)
                .overlay(Brand.bg0.opacity(0.35))
                .overlay(alignment: .leading) { Rectangle().fill(Brand.border).frame(width: 1) }
                .ignoresSafeArea()
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Seitenleiste")
    }
}

// MARK: - Wurzel

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(NewsStore.self) private var news
    @Environment(\.verticalSizeClass) private var vSize
    @AppStorage("navPlacement") private var placementRaw = Chrome.Placement.auto.rawValue
    @State private var chrome = Chrome()
    @State private var tab: AppTab = .dashboard
    @State private var dashboardPath: [DetailKind] = []
    @State private var moreRoute: MoreRoute?
    @State private var showPairing = false
    @State private var size: CGSize = .zero
    @State private var screen: CGSize = .zero

    private var rail: Bool {
        Chrome.wantsRail(size: size, screen: screen, vertical: vSize, placement: Chrome.Placement(rawValue: placementRaw) ?? .auto)
    }

    var body: some View {
        Group {
            if !model.loaded {
                ZStack { AuroraBackground(); ProgressView() }
            } else {
                shell
            }
        }
        .background(GeometryReader { g in
            Color.clear
                .onAppear { size = g.size; logGeometry(g) }
                .onChange(of: g.size) { _, s in size = s; logGeometry(g) }
        }.ignoresSafeArea())
        .environment(chrome)
        .onChange(of: rail, initial: true) { _, r in chrome.railActive = r }
        // Haptik des Systems: leichter Anschlag beim Auslösen einer Aktion
        // (Aktualisieren …), Erfolg bzw. Fehler am Ende einer Kopplung.
        .sensoryFeedback(.impact(weight: .light), trigger: chrome.actionTaps)
        .sensoryFeedback(trigger: model.pairState) { _, new in
            switch new {
            case .done: return .success
            case .failed: return .error
            default: return nil
            }
        }
        .sheet(isPresented: $showPairing) {
            NavigationStack { PairView(onboarding: false, initialText: model.pendingPairLink) }
        }
        .onChange(of: model.pendingPairLink) { _, link in
            if link != nil { showPairing = true }
        }
        // Link, Widget, Live-Aktivität oder Kontrollzentrum wollen einen Bereich öffnen.
        .onChange(of: model.pendingOpen, initial: true) { _, target in
            guard let target else { return }
            model.pendingOpen = nil
            open(target)
        }
        .onChange(of: showPairing) { _, shown in
            if !shown { model.pendingPairLink = nil; model.resetPairState() }
        }
        .onAppear {
            model.activate()
            #if DEBUG
            applyDebugArguments()
            #endif
        }
    }

    /// Fläche und Bildschirm merken; als Diagnose ablegen (Mehr → Darstellung)
    /// und im Debug-Build in die Konsole schreiben
    /// (`xcrun devicectl device process launch --console …`).
    private func logGeometry(_ g: GeometryProxy) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let win = scene?.windows.first
        if let b = scene?.screen.bounds.size { screen = b }
        let sdk = Bundle.main.object(forInfoDictionaryKey: "DTSDKName") as? String ?? "?"
        // Diagnosezeile für Rückfragen — bewusst nicht übersetzt.
        let text = "Fenster \(Int(g.size.width))×\(Int(g.size.height)) pt · Bildschirm \(Int(screen.width))×\(Int(screen.height)) pt · Breite \(win?.traitCollection.horizontalSizeClass == .regular ? "regular" : "compact"), Höhe \(vSize == .compact ? "compact" : "regular") · SDK \(sdk)"
        chrome.diagnostics = text
        #if DEBUG
        print("DVHUB_GEOMETRY \(text) rail=\(rail)")
        #endif
    }

    /// Inhalt links, Seitenleiste rechts daneben (nicht darüber gelegt — die
    /// Navigationsleisten der Reiter enden an der Leiste).
    private var shell: some View {
        HStack(spacing: 0) {
            tabs
            if rail {
                SideRail(tab: $tab, actions: chrome.actions[tab.rawValue] ?? [], badges: [.news: news.unseenCount],
                         compact: size.height < 520, narrow: size.width < 420) { t in
                    // Gewählten Reiter erneut antippen: zurück zur ersten Ebene.
                    if t == .dashboard { dashboardPath = [] }
                    if t == .more { moreRoute = nil }
                }
                .transition(.move(edge: .trailing))
            }
        }
        .animation(.snappy, value: rail)
        .tint(Brand.cyan)
    }

    /// Reiter als System-TabView. `.sidebarAdaptable`: Wo die Fläche breit ist
    /// (aufgeklappt, iPad), bietet das System von sich aus die Leiste oben und
    /// die ausklappbare Seitenleiste an; schmal bleibt es die Tab-Leiste.
    private var tabs: some View {
        TabView(selection: $tab) {
            Tab(AppTab.dashboard.title, systemImage: AppTab.dashboard.icon, value: AppTab.dashboard) {
                NavigationStack(path: $dashboardPath) {
                    dashboardRoot
                        .navigationDestination(for: DetailKind.self) { kind in
                            if let c = model.selected {
                                DetailView(kind: kind, controller: c) { tab = .history }
                                    .id(c.credentials.boxId)
                            }
                        }
                }
                .tabBarHidden(rail)
            }
            Tab(AppTab.market.title, systemImage: AppTab.market.icon, value: AppTab.market) {
                NavigationStack { MarketView(controller: model.selected) }
                    .tabBarHidden(rail)
            }
            Tab(AppTab.history.title, systemImage: AppTab.history.icon, value: AppTab.history) {
                NavigationStack {
                    if let c = model.selected {
                        // Je Anlage eigene Ansichts-Identität: Werte der vorigen
                        // Anlage dürfen nach dem Wechsel nicht stehen bleiben.
                        HistoryView(controller: c).id(c.credentials.boxId)
                    } else {
                        needsSystem(String(localized: "Historie"))
                    }
                }
                .tabBarHidden(rail)
            }
            Tab(AppTab.news.title, systemImage: AppTab.news.icon, value: AppTab.news) {
                NavigationStack { NewsView() }
                    .tabBarHidden(rail)
            }
            .badge(news.unseenCount)
            Tab(AppTab.more.title, systemImage: AppTab.more.icon, value: AppTab.more) {
                // Geteilte Ansicht des Systems: zugeklappt eine Liste, die in den
                // Bereich hineinführt; aufgeklappt Liste und Bereich nebeneinander
                // (HIG: auf dem Innendisplay eine Ebene mehr zeigen).
                NavigationSplitView {
                    MoreView(selection: $moreRoute)
                } detail: {
                    NavigationStack {
                        if let route = moreRoute {
                            moreDestination(route)
                        } else {
                            MoreOverview()
                        }
                    }
                }
                .tabBarHidden(rail)
            }
        }
        .tabViewStyle(.sidebarAdaptable)
    }

    @ViewBuilder
    private var dashboardRoot: some View {
        if let c = model.selected {
            DashboardView(controller: c, open: { dashboardPath = [$0] }, openMarket: { tab = .market })
                .id(c.credentials.boxId)
                .toolbar {
                    if model.systems.count > 1 {
                        ToolbarItem(placement: .topBarLeading) { systemMenu }
                    }
                }
        } else {
            PairView(onboarding: true)
        }
    }

    private var systemMenu: some View {
        Menu {
            ForEach(model.systems) { sys in
                Button { model.select(sys.id) } label: {
                    Label(sys.boxName, systemImage: sys.id == model.selectedId ? "checkmark" : "house")
                }
            }
        } label: {
            Label("Anlage wechseln", systemImage: "house.and.flag")
        }
    }

    private func needsSystem(_ title: String) -> some View {
        AuroraPage { _ in
            GlassCard {
                VStack(spacing: 12) {
                    EmptyState(title: "Noch keine Anlage gekoppelt", icon: "qrcode.viewfinder",
                               text: String(localized: "Markt und Nachrichten gehen ohne Anlage. Für \(title) koppelst du DVhub per QR-Code."))
                    Button { showPairing = true } label: { Label("Anlage koppeln", systemImage: "qrcode.viewfinder") }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle(title)
    }

    @ViewBuilder
    private func moreDestination(_ route: MoreRoute) -> some View {
        switch route {
        case .systems: SystemsView(showPairing: $showPairing)
        case .appearance: AppearanceView()
        case .about: AboutView()
        default:
            if let c = model.selected {
                Group {
                    switch route {
                    case .plan: PlanView(controller: c)
                    case .integrations: IntegrationsView(controller: c)
                    case .system: SystemInfoView(controller: c)
                    default: ControlView(controller: c)
                    }
                }
                .id(c.credentials.boxId)
            } else {
                needsSystem(String(localized: "diesen Bereich"))
            }
        }
    }

    /// Bereich nach Namen öffnen: Reiter (`market`), Bereich unter „Mehr“
    /// (`control`) oder Detailansicht des Leitstands (`money`).
    private func open(_ name: String) {
        if let known = AppTab(rawValue: name) {
            tab = known
            if known == .dashboard { dashboardPath = [] }
        } else if name == "overview" {
            tab = .dashboard
        } else if let route = MoreRoute(rawValue: name) {
            tab = .more
            moreRoute = route
        } else if let detail = DetailKind(rawValue: name) {
            tab = .dashboard
            dashboardPath = [detail]
        }
    }

    #if DEBUG
    /// Nur für Simulator-Tests und Bildschirmfotos:
    ///   -DVHUB_PAIR '<QR-Text>'   beim Start koppeln
    ///   -DVHUB_TAB  dashboard|market|history|news|more|plan|integrations|system|control|systems
    ///   -DVHUB_OPEN pv|battery|grid|home|money|state
    private func applyDebugArguments() {
        let d = UserDefaults.standard
        if let t = d.string(forKey: "DVHUB_TAB") { open(t) }
        if let o = d.string(forKey: "DVHUB_OPEN"), DetailKind(rawValue: o) != nil { open(o) }
        if let qr = d.string(forKey: "DVHUB_PAIR"), !qr.isEmpty, model.pendingPairLink == nil,
           !model.systems.contains(where: { (try? PairPayload(qr).boxId) == $0.id }) {
            model.pendingPairAutoStart = true
            model.pendingPairLink = qr
        }
    }
    #endif
}

private extension View {
    /// Mit Seitenleiste entfällt die Leiste unten.
    func tabBarHidden(_ hidden: Bool) -> some View {
        toolbar(hidden ? .hidden : .automatic, for: .tabBar)
    }
}

#if DEBUG
/// Bildschirmfotos ohne iPhone-Duo-Simulator (den gibt es erst ab Xcode 27.1):
/// zeigt die App in der Fläche des Außen- bzw. Innendisplays.
///   -DVHUB_DUO closed   466 × 678 pt (Annahme, aus 1398 × 2034 px bei @3x)
///   -DVHUB_DUO open     669 × 951 pt (Annahme, aus 2007 × 2853 px bei @3x)
///   -DVHUB_DUO closed-27.0 | open-landscape   am Gerät gemessene Flächen (iOS-27.0-SDK)
struct DuoPreviewFrame<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        switch UserDefaults.standard.string(forKey: "DVHUB_DUO") {
        case "closed-27.0": framed(CGSize(width: 386, height: 678), .compact, "iPhone Duo zugeklappt, Build mit iOS-27.0-SDK · 386 × 678 pt (am Gerät gemessen)")
        case "open-landscape": framed(CGSize(width: 871, height: 669), .regular, "iPhone Duo aufgeklappt quer · 871 × 669 pt (am Gerät gemessen)")
        case "closed": framed(CGSize(width: 466, height: 678), .compact, "iPhone Duo zugeklappt · 466 × 678 pt (Nachbildung)")
        case "closed-landscape": framed(CGSize(width: 678, height: 466), .compact, "iPhone Duo zugeklappt quer · 678 × 466 pt (Nachbildung)", vertical: .compact)
        case "open": framed(CGSize(width: 669, height: 951), .regular, "iPhone Duo aufgeklappt · 669 × 951 pt (Nachbildung)")
        default: content
        }
    }

    private func framed(_ s: CGSize, _ h: UserInterfaceSizeClass, _ label: String, vertical: UserInterfaceSizeClass = .regular) -> some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 10) {
                content
                    .environment(\.horizontalSizeClass, h)
                    .environment(\.verticalSizeClass, vertical)
                    .frame(width: s.width, height: s.height)
                    .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 34, style: .continuous).strokeBorder(Color.white.opacity(0.25), lineWidth: 2))
                Text(label).font(.caption.monospaced()).foregroundStyle(.white.opacity(0.6))
            }
        }
    }
}
#endif
