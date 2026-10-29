// Components.swift — Kacheln und Verbindungsanzeige.

import SwiftUI
import DVhubLink

struct Tile<Content: View>: View {
    let title: String
    let icon: String
    let tint: Color
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            content
        }
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct BigValue: View {
    let value: String
    var caption: String?
    var id: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(.title, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .accessibilityIdentifier(id ?? "")
            if let caption {
                Text(caption).font(.footnote).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
            }
        }
    }
}

struct ConnectionBadge: View {
    let controller: SystemController

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 10, height: 10)
            Text(text).font(.footnote)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("connectionState")
    }

    private var color: Color {
        switch controller.state {
        case .online: return .green
        case .connecting, .idle: return .yellow
        case .boxOffline: return .orange
        case .offline: return .red
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
