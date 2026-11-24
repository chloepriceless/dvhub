// DVhubApp.swift — Einstieg der DVhub-App.

import SwiftUI

@main
struct DVhubApp: App {
    @State private var model = AppModel()
    @State private var market = MarketStore()
    @State private var news = NewsStore()
    @AppStorage("appearance") private var appearance = Appearance.dark.rawValue
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            root
                .environment(model)
                .environment(market)
                .environment(news)
                .preferredColorScheme((Appearance(rawValue: appearance) ?? .dark).scheme)
                .onOpenURL { model.handle(url: $0) }
        }
        // Hintergrundabruf (BGAppRefreshTask): hält Widgets und Live-Aktivität aktuell.
        .backgroundTask(.appRefresh(BackgroundRefresh.taskId)) {
            await BackgroundRefresh.run()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model.activate()
            case .background: model.deactivate()
            default: break
            }
        }
    }

    @ViewBuilder
    private var root: some View {
        #if DEBUG
        DuoPreviewFrame { RootView() }
        #else
        RootView()
        #endif
    }
}
