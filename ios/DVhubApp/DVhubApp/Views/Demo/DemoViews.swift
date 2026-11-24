// DemoViews.swift — Bausteine der Demo in der Oberfläche: der Einstieg
// („Demo ansehen“), die Kennzeichnung (damit Demo und echte Anlage nie
// verwechselt werden) und das Beenden.
//
// Die Ansichten der App wissen sonst nichts von der Demo — sie bekommen ihre
// Daten über denselben Controller wie bei einer gekoppelten Anlage
// (SystemController, `DemoDialer`).

import SwiftUI
import DVhubLink

/// „DEMO“ als Marke: auf Aurora-Verlauf, überall dieselbe.
struct DemoTag: View {
    var body: some View {
        Text(verbatim: "DEMO")
            .font(.caption2.weight(.heavy))
            .tracking(1.4)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(Color(hex: 0x030610))
            .background(Brand.auroraLinear, in: Capsule())
            .accessibilityLabel("Demo")
    }
}

/// Einstieg in die Demo — auf dem Startbildschirm, unter „Anlagen“ und überall,
/// wo sonst nur „Anlage koppeln“ stünde.
struct DemoStartButton: View {
    @Environment(AppModel.self) private var model
    var compact = false
    @State private var started = 0

    var body: some View {
        Button {
            started += 1
            model.startDemo()
        } label: {
            Label("Demo ansehen", systemImage: "play.circle.fill")
                .font(compact ? .subheadline.weight(.bold) : .headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, compact ? 10 : 14)
                .foregroundStyle(Color(hex: 0x030610))
                .background(LinearGradient(colors: [Color(hex: 0x34dbff), Color(hex: 0xa78bff), Color(hex: 0xffd421)], startPoint: .leading, endPoint: .trailing),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(CardButtonStyle())
        .sensoryFeedback(.success, trigger: started)
        .accessibilityHint("Zeigt die App mit einer Beispielanlage. Geschaltet wird nichts.")
        .accessibilityIdentifier("demoStart")
    }
}

/// Karte „Noch keine Anlage?“ mit dem Einstieg — für den Startbildschirm.
struct DemoInvite: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(Brand.auroraLinear).accessibilityHidden(true)
                Text("Erst einmal ansehen?").font(.headline)
            }
            Text("Die Demo zeigt DVhub mit einer Beispielanlage: 20 kWp Photovoltaik, 20 kWh Akku, Wallbox und dynamischer Tarif. Alles lässt sich ausprobieren – geschaltet wird nichts.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            DemoStartButton()
        }
        .padding(.vertical, 6)
    }
}

/// Rückfrage „Demo beenden?“ — an jeder Stelle dieselbe.
private struct DemoEndDialog: ViewModifier {
    @Binding var shown: Bool
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content.confirmationDialog("Demo beenden?", isPresented: $shown, titleVisibility: .visible) {
            Button("Demo beenden", role: .destructive) { model.endDemo() }
            Button("Weiter ansehen", role: .cancel) {}
        } message: {
            Text("Die Beispielanlage verschwindet aus der App – mit allem, was du darin geändert hast. Unter „Anlagen“ lässt sie sich jederzeit wieder starten.")
        }
    }
}

extension View {
    func demoEndDialog(_ shown: Binding<Bool>) -> some View { modifier(DemoEndDialog(shown: shown)) }
}

/// Band am oberen Rand jeder Seite, solange die Demo gewählt ist. Es bleibt
/// beim Rollen stehen: Auf keinem Bild der Demo fehlt die Kennzeichnung.
/// Antippen erklärt die Demo und bietet „Demo beenden“ und „Anlage koppeln“.
struct DemoStrip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var info = false

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 17, style: .continuous) }

    var body: some View {
        Button { info = true } label: {
            HStack(spacing: 8) {
                DemoTag()
                Text("Beispielanlage · nichts wird geschaltet")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Brand.text)
                    // In den Bedienungshilfen-Größen umbrechen statt abschneiden.
                    .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                    .minimumScaleFactor(typeSize.isAccessibilitySize ? 1 : 0.7)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Brand.text2).accessibilityHidden(true)
            }
            .padding(.leading, 6)
            .padding(.trailing, 12)
            .padding(.vertical, 5)
            .background(.ultraThinMaterial, in: shape)
            .overlay(shape.strokeBorder(Brand.auroraLinear, lineWidth: 1).opacity(0.7))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .frame(maxWidth: 1100)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Demo: Beispielanlage, nichts wird geschaltet")
        .accessibilityHint("Erklärt die Demo und bietet an, sie zu beenden")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("demoStrip")
        .confirmationDialog("Du siehst die Demo", isPresented: $info, titleVisibility: .visible) {
            Button("Eigene Anlage koppeln") { model.pendingOpen = "pair" }
            Button("Demo beenden", role: .destructive) { model.endDemo() }
            Button("Weiter ansehen", role: .cancel) {}
        } message: {
            Text("Alle Werte stammen von einer Beispielanlage und entstehen im Gerät – auch Preise und Meldungen. Du kannst alles bedienen: Es ändert sich nur die Demo, keine Anlage wird erreicht. „Demo beenden“ entfernt sie samt deinen Änderungen.")
        }
    }
}

/// Die Demo in Listen („Mehr“, Seitenleiste): Hinweis, Beenden, eigene Anlage koppeln.
struct DemoSection: View {
    @Environment(AppModel.self) private var model
    @State private var ending = false

    var body: some View {
        SwiftUI.Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    DemoTag()
                    Text("Du siehst die Demo").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.text)
                }
                Text("Beispielanlage mit Beispielwerten. Alles lässt sich bedienen – geschaltet wird nichts.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
            Button(role: .destructive) { ending = true } label: { Label("Demo beenden", systemImage: "xmark.circle.fill") }
                .accessibilityIdentifier("demoEnd")
                .demoEndDialog($ending)
            Button { model.pendingOpen = "pair" } label: { Label("Eigene Anlage koppeln", systemImage: "qrcode.viewfinder") }
                .accessibilityIdentifier("demoPair")
        }
    }
}
