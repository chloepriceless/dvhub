// RootView.swift — anpassbares Grundgerüst.
//
// Schmale Breite (iPhone, iPhone Duo zugeklappt): Tab-Leiste, eine Spalte.
// Breite Darstellung (iPhone Duo aufgeklappt, iPad): Seitenleiste mit Anlagen
// und Bereichen, Inhalt zweispaltig. Der Wechsel baut nur die Ansicht neu —
// die Verbindung hält der SystemController im AppModel.

import SwiftUI
import DVhubLink

enum Section: String, CaseIterable, Identifiable, Hashable {
    case overview, history, plan, control, systems
    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "Übersicht"
        case .history: return "Verlauf"
        case .plan: return "Plan"
        case .control: return "Steuern"
        case .systems: return "Anlagen"
        }
    }

    var icon: String {
        switch self {
        case .overview: return "bolt.circle"
        case .history: return "chart.xyaxis.line"
        case .plan: return "calendar.day.timeline.left"
        case .control: return "switch.2"
        case .systems: return "house"
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var section: Section = .overview
    @State private var showPairing = false

    var body: some View {
        Group {
            if model.systems.isEmpty {
                NavigationStack { PairView(onboarding: true) }
            } else if sizeClass == .regular {
                wideLayout
            } else {
                compactLayout
            }
        }
        .sheet(isPresented: $showPairing) {
            NavigationStack { PairView(onboarding: false, initialText: model.pendingPairLink) }
        }
        .onChange(of: model.pendingPairLink) { _, link in
            if link != nil { showPairing = true }
        }
        .onChange(of: showPairing) { _, shown in
            if !shown { model.pendingPairLink = nil; model.resetPairState() }
        }
        .onAppear {
            model.activate()
            #if DEBUG
            // Nur für Simulator-Tests: xcrun simctl launch … -DVHUB_PAIR '<QR-Text>' -DVHUB_TAB history
            let d = UserDefaults.standard
            if let tab = d.string(forKey: "DVHUB_TAB").flatMap(Section.init(rawValue:)) { section = tab }
            if let qr = d.string(forKey: "DVHUB_PAIR"), !qr.isEmpty, model.pendingPairLink == nil,
               !model.systems.contains(where: { (try? PairPayload(qr).boxId) == $0.id }) {
                model.pendingPairLink = qr
            }
            #endif
        }
    }

    private var sections: [Section] {
        let control = model.selected?.canControl == true
        return Section.allCases.filter { $0 != .control || control }
    }

    // MARK: Schmal

    private var compactLayout: some View {
        TabView(selection: $section) {
            ForEach(sections) { s in
                NavigationStack { content(for: s) }
                    .tabItem { Label(s.title, systemImage: s.icon) }
                    .tag(s)
            }
        }
    }

    // MARK: Breit

    private var wideLayout: some View {
        NavigationSplitView {
            List {
                SwiftUI.Section("Anlage") {
                    ForEach(model.systems) { sys in
                        Button {
                            model.select(sys.id)
                        } label: {
                            HStack {
                                Label(sys.boxName, systemImage: "house.fill")
                                Spacer()
                                if sys.id == model.selectedId { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    Button { showPairing = true } label: { Label("Anlage koppeln", systemImage: "qrcode.viewfinder") }
                }
                SwiftUI.Section("Bereiche") {
                    ForEach(sections.filter { $0 != .systems }) { s in
                        Button { section = s } label: {
                            Label(s.title, systemImage: s.icon)
                                .fontWeight(section == s ? .semibold : .regular)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(section == s ? Color.accentColor.opacity(0.15) : nil)
                    }
                }
                if let c = model.selected { SwiftUI.Section("Verbindung") { ConnectionBadge(controller: c) } }
            }
            .navigationTitle("DVhub")
        } detail: {
            NavigationStack { content(for: section == .systems ? .overview : section) }
        }
    }

    @ViewBuilder
    private func content(for s: Section) -> some View {
        if let c = model.selected {
            switch s {
            case .overview: OverviewView(controller: c)
            case .history: HistoryView(controller: c)
            case .plan: PlanView(controller: c)
            case .control: ControlView(controller: c)
            case .systems: SystemsView(showPairing: $showPairing)
            }
        } else {
            SystemsView(showPairing: $showPairing)
        }
    }
}
