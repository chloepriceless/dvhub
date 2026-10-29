// DVhubApp.swift — Einstieg der DVhub-App.

import SwiftUI

@main
struct DVhubApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { url in
                    // Kamera-App oder Link: dvhub://pair?…
                    if url.scheme == "dvhub" { model.pendingPairLink = url.absoluteString }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model.activate()
            case .background: model.deactivate()
            default: break
            }
        }
    }
}
