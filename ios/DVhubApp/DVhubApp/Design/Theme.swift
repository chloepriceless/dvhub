// Theme.swift — Bausteine des Aurora-Designs: Glas-Karten, Überzeilen in
// Monospace-Versalien, große runde Ziffern, Pillen. Farben: Shared/Brand.swift.

import SwiftUI
import DVhubLink

// MARK: Karte

struct GlassCard<Content: View>: View {
    var tint: Color? = nil
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .background(CardBackground(tint: tint))
    }
}

struct CardBackground: View {
    var tint: Color? = nil
    var radius: CGFloat = 22
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        shape
            .fill(.ultraThinMaterial)
            .overlay(shape.fill(Brand.glass))
            .overlay(alignment: .topLeading) {
                // Farbiger Lichtschein in der Ecke — die Karte „gehört“ ihrer Energieart.
                if let tint {
                    shape.fill(RadialGradient(colors: [tint.opacity(scheme == .dark ? 0.20 : 0.12), .clear],
                                              center: .topLeading, startRadius: 0, endRadius: 180))
                }
            }
            .overlay(shape.strokeBorder(LinearGradient(colors: [(tint ?? Brand.cyan).opacity(0.45), Brand.border, Brand.hairline],
                                                       startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1))
            .shadow(color: .black.opacity(scheme == .dark ? 0.28 : 0.08), radius: 14, y: 8)
    }
}

/// Drückt sich leicht ein — für antippbare Karten.
struct CardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// MARK: Text
//
// Beschriftungen nehmen wie SwiftUIs `Text` entweder ein Literal (Schlüssel im
// String-Katalog, wird übersetzt) oder einen fertigen String (bleibt, wie er ist).

/// Überzeile wie im Leitstand: Monospace, Versalien, gesperrt.
struct Eyebrow: View {
    private let label: Text
    var icon: String? = nil
    var tint: Color = Brand.dim

    init(text: LocalizedStringKey, icon: String? = nil, tint: Color = Brand.dim) {
        label = Text(text); self.icon = icon; self.tint = tint
    }

    @_disfavoredOverload
    init<S: StringProtocol>(text: S, icon: String? = nil, tint: Color = Brand.dim) {
        label = Text(text); self.icon = icon; self.tint = tint
    }

    var body: some View {
        HStack(spacing: 6) {
            if let icon { Image(systemName: icon).imageScale(.small) }
            label
                .textCase(.uppercase)
                .tracking(1.4)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .font(.caption2.monospaced().weight(.semibold))
        .foregroundStyle(tint)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

struct MetricValue: View {
    let value: String
    var style: Font.TextStyle = .title
    var color: Color = Brand.text
    var id: String? = nil

    var body: some View {
        Text(value)
            .font(.system(style, design: .rounded).weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(color)
            .contentTransition(.numericText())
            .lineLimit(1)
            .minimumScaleFactor(0.55)
            .accessibilityIdentifier(id ?? "")
    }
}

struct Pill: View {
    private let label: Text
    var icon: String? = nil
    var tint: Color = Brand.cyan
    var filled = false

    init(text: LocalizedStringKey, icon: String? = nil, tint: Color = Brand.cyan, filled: Bool = false) {
        label = Text(text); self.icon = icon; self.tint = tint; self.filled = filled
    }

    @_disfavoredOverload
    init<S: StringProtocol>(text: S, icon: String? = nil, tint: Color = Brand.cyan, filled: Bool = false) {
        label = Text(text); self.icon = icon; self.tint = tint; self.filled = filled
    }

    var body: some View {
        HStack(spacing: 5) {
            if let icon { Image(systemName: icon).imageScale(.small) }
            label.lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .foregroundStyle(filled ? Brand.bg0 : tint)
        .background(Capsule().fill(filled ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.16))))
        .overlay(Capsule().strokeBorder(tint.opacity(filled ? 0 : 0.35), lineWidth: 1))
    }
}

/// Zeile „Bezeichnung … Wert“ in Detailansichten.
struct ValueRow: View {
    private let label: Text
    let value: String
    var tint: Color? = nil
    var hint: String? = nil

    init(label: LocalizedStringKey, value: String, tint: Color? = nil, hint: String? = nil) {
        self.label = Text(label); self.value = value; self.tint = tint; self.hint = hint
    }

    @_disfavoredOverload
    init<S: StringProtocol>(label: S, value: String, tint: Color? = nil, hint: String? = nil) {
        self.label = Text(label); self.value = value; self.tint = tint; self.hint = hint
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                label.font(.subheadline).foregroundStyle(Brand.text2)
                if let hint { Text(hint).font(.caption2).foregroundStyle(Brand.dim) }
            }
            Spacer(minLength: 8)
            Text(value)
                .font(.system(.body, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(tint ?? Brand.text)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 7)
        .accessibilityElement(children: .combine)
    }
}

struct Hairline: View {
    var body: some View { Rectangle().fill(Brand.hairline).frame(height: 1) }
}

/// Zeilen mit Haarlinien dazwischen.
struct RowStack<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        _VariadicView.Tree(RowStackLayout()) { content }
    }
}

private struct RowStackLayout: _VariadicView_MultiViewRoot {
    func body(children: _VariadicView.Children) -> some View {
        let last = children.last?.id
        VStack(spacing: 0) {
            ForEach(children) { child in
                child
                if child.id != last { Hairline() }
            }
        }
    }
}

struct SectionTitle: View {
    private let label: Text
    init(text: LocalizedStringKey) { label = Text(text) }
    @_disfavoredOverload
    init<S: StringProtocol>(text: S) { label = Text(text) }

    var body: some View {
        label
            .font(.title3.weight(.bold))
            .foregroundStyle(Brand.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Hinweis-Band (veraltete Werte, Fehler, Lizenz).
struct NoticeBanner: View {
    private let label: Text
    var icon: String = "clock.arrow.circlepath"
    var tint: Color = Brand.orange

    init(text: LocalizedStringKey, icon: String = "clock.arrow.circlepath", tint: Color = Brand.orange) {
        label = Text(text); self.icon = icon; self.tint = tint
    }

    @_disfavoredOverload
    init<S: StringProtocol>(text: S, icon: String = "clock.arrow.circlepath", tint: Color = Brand.orange) {
        label = Text(text); self.icon = icon; self.tint = tint
    }

    var body: some View {
        Label { label } icon: { Image(systemName: icon) }
            .font(.footnote)
            .foregroundStyle(Brand.text)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(tint.opacity(0.4), lineWidth: 1))
    }
}

struct EmptyState: View {
    private let title: Text
    let icon: String
    var text: String? = nil

    init(title: LocalizedStringKey, icon: String, text: String? = nil) {
        self.title = Text(title); self.icon = icon; self.text = text
    }

    @_disfavoredOverload
    init<S: StringProtocol>(title: S, icon: String, text: String? = nil) {
        self.title = Text(title); self.icon = icon; self.text = text
    }

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.largeTitle).imageScale(.large).foregroundStyle(Brand.auroraLinear)
                .accessibilityHidden(true)
            title.font(.headline).foregroundStyle(Brand.text)
            if let text { Text(text).font(.footnote).foregroundStyle(Brand.text2).multilineTextAlignment(.center) }
        }
        .frame(maxWidth: .infinity, minHeight: 180)
        .padding()
    }
}

// MARK: Seite

/// Rollbare Seite auf dem Aurora-Hintergrund. `width` meldet die Inhaltsbreite,
/// damit Ansichten nach Platz statt nach Gerät umbrechen (iPhone Duo auf/zu).
struct AuroraPage<Content: View>: View {
    var spacing: CGFloat = 14
    /// Detailseiten: kleiner Titel.
    var inlineTitle = false
    @ViewBuilder var content: (CGFloat) -> Content
    @State private var width: CGFloat = 0
    @Environment(Chrome.self) private var chrome
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Breite, nach der die Ansichten umbrechen. In den Bedienungshilfen-Größen
    /// braucht Text deutlich mehr Platz — dann zählt die Fläche entsprechend
    /// schmaler, und zweispaltige Anordnungen werden einspaltig.
    private var layoutWidth: CGFloat { typeSize.isAccessibilitySize ? width / 1.6 : width }

    var body: some View {
        // Ein Pfad für beide Fälle: Die Seite behält ihre Identität (Rollposition,
        // Zustand), wenn die Seitenleiste beim Drehen oder Auf-/Zuklappen kommt
        // oder geht. Mit Seitenleiste ist die Höhe knapp: dann immer kleiner Titel.
        page.navigationBarTitleDisplayMode(chrome.railActive || inlineTitle ? .inline : .automatic)
    }

    private var page: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: spacing) {
                content(layoutWidth)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: 1100)
            .frame(maxWidth: .infinity)
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { width = g.size.width }
                    .onChange(of: g.size.width) { _, w in width = w }
            })
        }
        .scrollContentBackground(.hidden)
        .background(AuroraBackground())
        .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
    }
}

enum Layout {
    /// Ab dieser Inhaltsbreite stehen zwei Spalten nebeneinander: iPhone Duo
    /// aufgeklappt (669 pt, auch wenn ein älteres SDK rechts eine Spalte abzieht)
    /// und iPad. Gewöhnliche iPhones (≤ 440 pt) und das Außendisplay bleiben einspaltig.
    static let twoColumns = CGFloat(BarPlacementRule.wideWidth)
    static func isWide(_ w: CGFloat) -> Bool { w >= twoColumns }
}

extension View {
    /// Karten-Liste im Formular-Stil auf Aurora-Hintergrund.
    func auroraList() -> some View {
        scrollContentBackground(.hidden)
            .background(AuroraBackground())
            .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
    }
}
