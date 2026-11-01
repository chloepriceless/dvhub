// SystemsView.swift — gekoppelte Anlagen verwalten.

import SwiftUI
import DVhubLink

struct SystemsView: View {
    @Environment(AppModel.self) private var model
    @Binding var showPairing: Bool
    @State private var removeId: String?

    var body: some View {
        List {
            if let err = model.storageError {
                SwiftUI.Section { Label(err, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            }
            SwiftUI.Section("Gekoppelte Anlagen") {
                ForEach(model.systems) { sys in
                    Button { model.select(sys.id) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(sys.boxName).font(.headline)
                                Spacer()
                                if sys.id == model.selectedId { Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint) }
                            }
                            Text(sys.canControl ? "Anzeigen und steuern" : "Nur anzeigen").font(.footnote).foregroundStyle(.secondary)
                            Text(routeText(sys) + " · Kennung " + String(sys.boxId.prefix(6))).font(.caption).foregroundStyle(.secondary)
                            if let c = model.controllers[sys.id], sys.id == model.selectedId { ConnectionBadge(controller: c) }
                        }
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button("Entfernen", role: .destructive) { removeId = sys.id }
                    }
                }
            }
            SwiftUI.Section {
                Button { showPairing = true } label: { Label("Anlage koppeln", systemImage: "qrcode.viewfinder") }
            } footer: {
                Text("Entfernen löscht die Zugangsdaten nur auf diesem Gerät. In DVhub unter Einstellungen → „Handy-App“ die Kopplung ebenfalls entfernen.")
            }
        }
        .navigationTitle("Anlagen")
        .confirmationDialog("Anlage von diesem Gerät entfernen?", isPresented: Binding(get: { removeId != nil }, set: { if !$0 { removeId = nil } }), titleVisibility: .visible) {
            Button("Entfernen", role: .destructive) { if let id = removeId { model.remove(id) }; removeId = nil }
        }
    }

    private func routeText(_ s: LinkCredentials) -> String {
        var parts: [String] = []
        if !s.lan.isEmpty { parts.append("Heimnetz") }
        if s.relay != nil { parts.append("Relay") }
        return "Wege: " + (parts.isEmpty ? "keine" : parts.joined(separator: ", "))
    }
}
