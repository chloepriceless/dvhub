// Components.swift — Verbindungsanzeige.

import SwiftUI
import DVhubLink

struct ConnectionBadge: View {
    let controller: SystemController

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 8, height: 8)
                .shadow(color: color.opacity(0.8), radius: 4)
            Text(text).font(.caption.weight(.semibold)).foregroundStyle(Brand.text).lineLimit(1).minimumScaleFactor(0.75)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Capsule().fill(color.opacity(0.12)))
        .overlay(Capsule().strokeBorder(color.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
        .accessibilityIdentifier("connectionState")
    }

    private var color: Color {
        switch controller.state {
        case .online: return Brand.green
        case .connecting, .idle: return Brand.yellow
        case .boxOffline: return Brand.orange
        case .offline: return Brand.red
        }
    }

    private var text: String {
        switch controller.state {
        case .idle: return "Getrennt"
        case .connecting: return "Verbinde …"
        case .online(let k): return k == .lan ? "Verbunden im Heimnetz" : "Verbunden über Relay"
        case .boxOffline(let k): return k == .lan ? "Anlage antwortet nicht (Heimnetz)" : "Anlage nicht mit dem Relay verbunden"
        case .offline(let e): return "Keine Verbindung – \(e)"
        }
    }
}
