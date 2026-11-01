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
        default: return "Gerätecode"
        }
    }

    /// Biometrie, sonst Gerätecode.
    static func confirm(_ reason: String) async -> Result<Void, Error> {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Abbrechen"
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
    @State private var confirmStop = false
    @State private var confirmResume = false
    @State private var busy = false
    @State private var result: String?

    private var stopped: Bool { controller.displayStatus?.emergencyStop == true }

    var body: some View {
        Form {
            SwiftUI.Section {
                HStack {
                    Image(systemName: stopped ? "exclamationmark.octagon.fill" : "checkmark.circle.fill")
                        .foregroundStyle(stopped ? .red : .green)
                        .font(.title2)
                    VStack(alignment: .leading) {
                        Text(stopped ? "Not-Halt ist aktiv" : "Regelung läuft").font(.headline)
                        Text(stopped ? "DVhub schreibt keine Sollwerte an die Anlage." : "DVhub regelt die Anlage normal.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
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
        }
        .navigationTitle("Steuern")
        .confirmationDialog("Not-Halt auslösen?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Not-Halt auslösen", role: .destructive) { Task { await send("/api/control/stop", "Not-Halt auslösen") } }
        } message: { Text("DVhub hört auf, Sollwerte an die Anlage zu schreiben.") }
        .confirmationDialog("Not-Halt aufheben?", isPresented: $confirmResume, titleVisibility: .visible) {
            Button("Not-Halt aufheben") { Task { await send("/api/control/resume", "Not-Halt aufheben") } }
        }
    }

    private func send(_ path: String, _ reason: String) async {
        result = nil
        if case .failure(let e) = await DeviceAuth.confirm("\(reason) an \(controller.credentials.boxName)") {
            result = "Nicht bestätigt: \(e.localizedDescription)"
            return
        }
        busy = true
        defer { busy = false }
        do {
            let r = try await controller.request("POST", path, body: [:])
            switch r.status {
            case 200:
                // Not-Halt: Schreibsperre greift, aber der alte Sollwert konnte
                // nicht zurückgesetzt werden — wie im Browser deutlich warnen (Codex R8).
                if r.body["ok"]?.bool == false {
                    result = "Die Anlage meldet einen Fehler: \(r.body["error"]?.string ?? "unbekannt")."
                } else if let n = r.body["neutralize"], n["ok"]?.bool != true, n["skipped"]?.bool != true, !n.isNull {
                    let why = r.body["neutralize"]?["error"]?.string.map { " (\($0))" } ?? ""
                    result = "Not-Halt ist aktiv, aber der Wechselrichter konnte nicht auf 0 W gesetzt werden\(why). Der letzte Sollwert kann noch wirken — bitte an der Anlage prüfen."
                } else {
                    result = "Erledigt."
                }
            case 403: result = "Dieses Gerät darf nicht steuern. In DVhub unter „Handy-App“ freigeben."
            case 429: result = "Gerade zu viele Anfragen. Bitte gleich noch einmal."
            default: result = "Die Anlage hat abgelehnt (HTTP \(r.status))."
            }
        } catch {
            result = userMessage(for: error)
        }
    }
}
