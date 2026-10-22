// PairView.swift — Koppeln per QR-Code, Link oder eingefügtem Text.

import SwiftUI
import VisionKit
import DVhubLink

struct PairView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onboarding: Bool
    var initialText: String?

    @State private var text = ""
    @State private var scanning = false

    private var scannerAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        Form {
            if onboarding {
                SwiftUI.Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "bolt.horizontal.circle.fill").font(.system(size: 44)).foregroundStyle(.tint)
                        Text("DVhub koppeln").font(.title2.bold())
                        Text("Öffne in der DVhub-Oberfläche Einstellungen → „Handy-App“ und tippe auf „Handy koppeln“. Scanne dann den QR-Code.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
            }

            SwiftUI.Section("QR-Code") {
                if scannerAvailable {
                    Button { scanning = true } label: { Label("QR-Code scannen", systemImage: "qrcode.viewfinder") }
                } else {
                    Text("Die Kamera ist hier nicht verfügbar. Den Text des QR-Codes unten einfügen.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                TextField("dvhub://pair?…", text: $text, axis: .vertical)
                    .lineLimit(2...5)
                    .font(.footnote.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("pairText")
                HStack {
                    Button("Einfügen") { if let s = UIPasteboard.general.string { text = s } }
                    Spacer()
                    Button("Koppeln") { start(text) }
                        .buttonStyle(.borderedProminent)
                        .disabled(text.isEmpty || busy)
                        .accessibilityIdentifier("pairButton")
                }
            }

            SwiftUI.Section { status }
        }
        .navigationTitle(onboarding ? "Willkommen" : "Anlage koppeln")
        .toolbar {
            if !onboarding {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
            }
        }
        .sheet(isPresented: $scanning) {
            QRScannerView { code in
                scanning = false
                text = code
                start(code)
            }
            .ignoresSafeArea()
        }
        .onAppear {
            if let initialText, text.isEmpty {
                text = initialText
                start(initialText)
            } else if let link = model.pendingPairLink, text.isEmpty {
                text = link
                start(link)
            }
        }
        .onChange(of: model.pendingPairLink) { _, link in
            if let link { text = link; start(link) }
        }
        .onChange(of: model.pairState) { _, s in
            if case .done = s, !onboarding {
                Task { try? await Task.sleep(nanoseconds: 1_200_000_000); dismiss() }
            }
        }
    }

    private var busy: Bool {
        switch model.pairState {
        case .connecting, .waitingForApproval: return true
        default: return false
        }
    }

    @ViewBuilder private var status: some View {
        switch model.pairState {
        case .idle:
            Text("Der Code gilt 5 Minuten und nur für ein Gerät.").font(.footnote).foregroundStyle(.secondary)
        case .connecting:
            HStack { ProgressView(); Text("Verbinde mit der Anlage …") }
        case .waitingForApproval(let name, let code):
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    ProgressView()
                    VStack(alignment: .leading) {
                        Text("Warte auf Freigabe in DVhub …").font(.headline)
                        Text("Bestätige die Kopplung in der Oberfläche von \(name.isEmpty ? "DVhub" : name).")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Vergleichscode").font(.caption).foregroundStyle(.secondary)
                    Text(Self.grouped(code))
                        .font(.system(size: 40, weight: .semibold, design: .monospaced))
                        .accessibilityIdentifier("pairCode")
                    Text("Muss in DVhub genauso stehen. Steht dort ein anderer Code: ablehnen.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("waitingForApproval")
        case .done(let name):
            Label("Gekoppelt mit \(name)", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
        case .failed(let msg):
            Label(msg, systemImage: "xmark.octagon.fill").foregroundStyle(.red)
        }
    }

    /// „637690“ → „637 690“
    static func grouped(_ code: String) -> String {
        code.count == 6 ? String(code.prefix(3)) + " " + String(code.suffix(3)) : code
    }

    private func start(_ code: String) {
        guard !busy else { return }
        let c = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !c.isEmpty else { return }
        model.pendingPairLink = nil
        Task { await model.pair(qr: c) }
    }
}

/// Kamera-Scanner für QR-Codes (VisionKit). Nur auf echten Geräten verfügbar.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true
        )
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var delivered = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in items {
                if case .barcode(let b) = item, let s = b.payloadStringValue, s.hasPrefix(pairPrefix), !delivered {
                    delivered = true
                    scanner.stopScanning()
                    onCode(s)
                }
            }
        }
    }
}
