// ControlView.swift — Not-Halt auslösen/aufheben (nur mit Recht „Steuern“),
// jede Schaltung bestätigt per Touch ID (iPhone Duo), Face ID oder Gerätecode.

import SwiftUI
import LocalAuthentication
import DVhubLink

enum DeviceAuth {
    /// Beschriftung passend zum Gerät.
    static var methodName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .touchID: return "Touch ID"
        case .faceID: return "Face ID"
        case .opticID: return "Optic ID"
        default: return String(localized: "Gerätecode")
        }
    }

    /// Biometrie, sonst Gerätecode.
    static func confirm(_ reason: String) async -> Result<Void, Error> {
        let ctx = LAContext()
        ctx.localizedCancelTitle = String(localized: "Abbrechen")
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            return .failure(err ?? LAError(.passcodeNotSet))
        }
        do {
            _ = try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            return .success(())
        } catch {
            return .failure(error)
        }
    }
}

struct ControlView: View {
    let controller: SystemController
    @Environment(AppModel.self) private var model
    @State private var confirmStop = false
    @State private var confirmResume = false
    @State private var busy = false
    @State private var result: String?
    /// Zählt Erfolge bzw. Fehlschläge hoch — löst die Haptik aus.
    @State private var successes = 0
    @State private var failures = 0

    private var stopped: Bool { controller.displayStatus?.emergencyStop == true }

    var body: some View {
        Form {
            SwiftUI.Section {
                HStack {
                    Image(systemName: stopped ? "exclamationmark.octagon.fill" : "checkmark.circle.fill")
                        .foregroundStyle(stopped ? Brand.red : Brand.green)
                        .font(.title2)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading) {
                        Text(stopped ? "Not-Halt ist aktiv" : "Regelung läuft").font(.headline)
                        Text(stopped ? "DVhub schreibt keine Sollwerte an die Anlage." : "DVhub regelt die Anlage normal.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            } header: { Text("Not-Halt") }

            SwiftUI.Section {
                if stopped {
                    Button { confirmResume = true } label: {
                        Label("Not-Halt aufheben", systemImage: "play.circle")
                    }
                    .disabled(busy || !controller.isOnline)
                } else {
                    Button(role: .destructive) { confirmStop = true } label: {
                        Label("Not-Halt auslösen", systemImage: "stop.circle")
                            .foregroundStyle(.red)
                    }
                    .disabled(busy || !controller.isOnline)
                }
                if busy { ProgressView() }
                if let result { Text(result).font(.footnote) }
            } footer: {
                Text("Jede Schaltung bestätigst du mit \(DeviceAuth.methodName). Sie steht mit dem Namen dieses Geräts im DVhub-Protokoll.")
            }
            if !controller.isOnline {
                SwiftUI.Section { Text("Schalten geht nur, wenn die Anlage verbunden ist.").foregroundStyle(.secondary) }
            }
            SwiftUI.Section {
                Label("Kontrollzentrum: Knopf „Not-Halt“ hinzufügen – er öffnet diese Rückfrage.", systemImage: "switch.2")
                Label("Kurzbefehle und Siri: „Not-Halt auslösen“ fragt nach und verlangt das entsperrte iPhone.", systemImage: "mic")
            } header: { Text("Schneller Zugriff") }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .navigationTitle("Steuern")
        .auroraList()
        .confirmationDialog("Not-Halt auslösen?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Not-Halt auslösen", role: .destructive) { Task { await send("/api/control/stop", String(localized: "Not-Halt auslösen")) } }
        } message: { Text("DVhub hört auf, Sollwerte an die Anlage zu schreiben.") }
        .confirmationDialog("Not-Halt aufheben?", isPresented: $confirmResume, titleVisibility: .visible) {
            Button("Not-Halt aufheben") { Task { await send("/api/control/resume", String(localized: "Not-Halt aufheben")) } }
        }
        // Haptik des Systems: Warnung beim Öffnen der Rückfrage, Erfolg bzw. Fehler nach dem Schalten.
        .sensoryFeedback(.warning, trigger: confirmStop) { _, shown in shown }
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.error, trigger: failures)
        // Rückfrage von außen (Kontrollzentrum): erst zeigen, wenn die Anlage
        // verbunden ist und ein Live-Wert da ist. Die Richtung bestimmt allein der
        // Live-Zustand — der Knopf im Kontrollzentrum kennt nur den gespeicherten
        // Stand (ohne App-Gruppe gar keinen), und der kann veraltet sein.
        .task(id: externalRequestKey) { applyExternalRequest() }
    }

    private var externalRequestKey: String {
        "\(model.pendingStopRequest != nil)-\(controller.isOnline)-\(controller.liveAt != nil)-\(busy)"
    }

    private func applyExternalRequest() {
        guard model.pendingStopRequest != nil, controller.isOnline, controller.liveAt != nil, !busy else { return }
        model.pendingStopRequest = nil
        if stopped { confirmResume = true } else { confirmStop = true }
    }

    private func send(_ path: String, _ reason: String) async {
        result = nil
        if case .failure(let e) = await DeviceAuth.confirm(String(localized: "\(reason) an \(controller.credentials.boxName)", comment: "Grund für Touch ID: z. B. Not-Halt auslösen an Meine Anlage")) {
            result = String(localized: "Nicht bestätigt: \(e.localizedDescription)")
            failures += 1
            return
        }
        busy = true
        defer { busy = false }
        do {
            let outcome = ControlOutcome.from(try await controller.request("POST", path, body: [:]))
            result = outcome.message
            if outcome == .done { successes += 1 } else { failures += 1 }
        } catch {
            result = userMessage(for: error)
            failures += 1
        }
    }
}
