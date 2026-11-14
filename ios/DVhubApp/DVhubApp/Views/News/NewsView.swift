// NewsView.swift — Nachrichten-Leser: Energie-Meldungen von dvhub.online
// (RSS-Sammlung, u. a. pv magazine, Erneuerbare Energien). Liste mit Bildern,
// Filter nach Quelle, Artikel im eingebauten Browser mit Lesemodus.

import SwiftUI
import SafariServices
import DVhubLink

struct NewsView: View {
    @Environment(NewsStore.self) private var news
    @State private var source: String?
    @State private var reading: NewsItem?

    private var items: [NewsItem] {
        guard let source else { return news.items }
        return news.items.filter { $0.source == source }
    }

    private var sources: [String] {
        var seen = Set<String>()
        return news.items.map(\.source).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    var body: some View {
        AuroraPage { width in
            if let err = news.error {
                NoticeBanner(text: news.items.isEmpty ? err : String(localized: "\(err) Gezeigt wird der letzte Stand."), icon: "wifi.slash")
            }
            if sources.count > 1 { sourceChips }
            if items.isEmpty {
                if news.loading {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 240)
                } else {
                    GlassCard { EmptyState(title: "Keine Nachrichten", icon: "newspaper", text: String(localized: "Zum Aktualisieren nach unten ziehen.")) }
                }
            } else {
                let wide = Layout.isWide(width)
                if let first = items.first {
                    NewsHero(item: first, unseen: isUnseen(first)) { reading = first }
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: wide ? 2 : 1), spacing: 12) {
                    ForEach(items.dropFirst()) { item in
                        NewsRow(item: item, unseen: isUnseen(item)) { reading = item }
                            .onAppear { if item.id == items.last?.id { Task { await news.loadMore() } } }
                    }
                }
                if news.loading { ProgressView().frame(maxWidth: .infinity).padding() }
                if source != nil, news.hasMore {
                    Button { Task { await news.loadMore() } } label: { Label("Ältere Meldungen laden", systemImage: "arrow.down.circle") }
                        .font(.footnote.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 8)
                }
                Text("Quelle: DVhub-Nachrichten (dvhub.online). Die Artikel gehören den genannten Redaktionen.")
                    .font(.caption2).foregroundStyle(Brand.dim)
            }
        }
        .navigationTitle("Nachrichten")
        .screenActions(.news, [
            ScreenAction(id: "refresh", title: String(localized: "Aktualisieren"), icon: "arrow.clockwise", disabled: news.loading) {
                Task { await news.refresh(force: true) }
            },
        ])
        .refreshable { await news.refresh(force: true) }
        .task { await news.refresh() }
        .onDisappear { news.markSeen() }
        .sheet(item: $reading) { item in
            ArticleSheet(item: item)
        }
    }

    private func isUnseen(_ item: NewsItem) -> Bool {
        guard let seen = news.lastSeen, let at = item.publishedAt else { return false }
        return at > seen
    }

    private var sourceChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                chip(String(localized: "Alle"), nil)
                ForEach(sources, id: \.self) { chip($0, $0) }
            }
            .padding(.horizontal, 16)
        }
        .padding(.horizontal, -16)
    }

    private func chip(_ title: String, _ value: String?) -> some View {
        Button { withAnimation(.snappy) { source = value } } label: {
            Pill(text: title, tint: Brand.cyan, filled: source == value)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(source == value ? .isSelected : [])
    }
}

enum NewsText {
    static func age(_ d: Date?) -> String {
        guard let d else { return "" }
        let s = Date().timeIntervalSince(d)
        // „vor 5 Min.“, „gestern“ — in der Gerätesprache, vom System formatiert.
        if s < 2 * 86400 {
            let f = RelativeDateTimeFormatter()
            f.locale = Format.locale
            f.unitsStyle = .short
            f.dateTimeStyle = .named
            return f.localizedString(for: min(d, Date().addingTimeInterval(-60)), relativeTo: Date())
        }
        return d.formatted(.dateTime.day().month(.abbreviated).locale(Format.locale))
    }
}

private struct NewsImage: View {
    let item: NewsItem

    var body: some View {
        ZStack {
            // Platzhalter: Aurora mit dem Anfangsbuchstaben der Quelle.
            LinearGradient(colors: [Brand.bg2, Brand.blue.opacity(0.35), Brand.violet.opacity(0.3)], startPoint: .topLeading, endPoint: .bottomTrailing)
            // Platzhalter-Grafik in fester Größe (kein Lesetext).
            Text(String(item.source.prefix(1))).font(.system(size: 34, weight: .bold, design: .rounded)).foregroundStyle(Brand.text.opacity(0.25))
                .accessibilityHidden(true)
            if let url = item.imageURL {
                AsyncImage(url: url, transaction: Transaction(animation: .easeIn(duration: 0.2))) { phase in
                    if case .success(let img) = phase { img.resizable().scaledToFill() }
                }
            }
        }
        .clipped()
        .accessibilityHidden(true)
    }
}

private struct NewsMeta: View {
    let item: NewsItem
    let unseen: Bool

    var body: some View {
        HStack(spacing: 6) {
            if unseen { Circle().fill(Brand.cyan).frame(width: 7, height: 7).accessibilityLabel("neu") }
            Text(item.source.uppercased()).tracking(1).foregroundStyle(Brand.cyan)
            Text("·").foregroundStyle(Brand.dim)
            Text(NewsText.age(item.publishedAt)).foregroundStyle(Brand.dim)
        }
        .font(.caption2.monospaced().weight(.semibold))
        .lineLimit(1)
    }
}

private struct NewsHero: View {
    let item: NewsItem
    let unseen: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                NewsImage(item: item)
                    .frame(maxWidth: .infinity)
                    .frame(height: 190)
                    .overlay(LinearGradient(colors: [.clear, Brand.bg0.opacity(0.6)], startPoint: .center, endPoint: .bottom))
                VStack(alignment: .leading, spacing: 6) {
                    NewsMeta(item: item, unseen: unseen)
                    Text(item.title).font(.title3.weight(.bold)).foregroundStyle(Brand.text).multilineTextAlignment(.leading)
                    if !item.excerpt.isEmpty {
                        Text(item.excerpt).font(.subheadline).foregroundStyle(Brand.text2).lineLimit(3).multilineTextAlignment(.leading)
                    }
                }
                .padding(14)
            }
            .background(CardBackground(tint: Brand.cyan))
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("newsHero")
    }
}

private struct NewsRow: View {
    let item: NewsItem
    let unseen: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    NewsMeta(item: item, unseen: unseen)
                    Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.text).lineLimit(4).multilineTextAlignment(.leading)
                    if !item.excerpt.isEmpty {
                        Text(item.excerpt).font(.caption).foregroundStyle(Brand.text2).lineLimit(2).multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
                NewsImage(item: item)
                    .frame(width: 84, height: 84)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CardBackground(radius: 18))
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityElement(children: .combine)
    }
}

/// Meldung mit Bild und Auszug; der ganze Artikel öffnet im eingebauten Browser.
private struct ArticleSheet: View {
    let item: NewsItem
    @Environment(\.dismiss) private var dismiss
    @State private var showArticle = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    NewsImage(item: item)
                        .frame(maxWidth: .infinity).frame(height: 220)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    NewsMeta(item: item, unseen: false)
                    Text(item.title).font(.title2.weight(.bold)).foregroundStyle(Brand.text)
                    if let d = item.publishedAt {
                        Text(d.formatted(.dateTime.weekday(.wide).day().month(.wide).year().hour().minute().locale(Format.locale)))
                            .font(.caption).foregroundStyle(Brand.dim)
                    }
                    if !item.excerpt.isEmpty { Text(item.excerpt).font(.body).foregroundStyle(Brand.text2) }
                    if let url = item.linkURL {
                        Button { showArticle = true } label: {
                            Label("Ganzen Artikel lesen", systemImage: "doc.text.magnifyingglass")
                                .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
                                .foregroundStyle(Brand.bg0)
                                .background(LinearGradient(colors: [Color(hex: 0xffd421), Color(hex: 0xffab08)], startPoint: .top, endPoint: .bottom),
                                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        .accessibilityIdentifier("readArticle")
                        Text(url.host ?? "").font(.caption2.monospaced()).foregroundStyle(Brand.dim).frame(maxWidth: .infinity)
                    }
                }
                .padding(16)
            }
            .background(AuroraBackground())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Label("Schließen", systemImage: "xmark") } }
                if let url = item.linkURL {
                    ToolbarItem(placement: .topBarTrailing) { ShareLink(item: url) { Label("Teilen", systemImage: "square.and.arrow.up") } }
                }
            }
            .fullScreenCover(isPresented: $showArticle) {
                if let url = item.linkURL { SafariView(url: url).ignoresSafeArea() }
            }
        }
    }
}

/// Eingebauter Browser (Safari View Controller) mit Lesemodus, wenn die Seite ihn anbietet.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let cfg = SFSafariViewController.Configuration()
        cfg.entersReaderIfAvailable = true
        let vc = SFSafariViewController(url: url, configuration: cfg)
        vc.preferredControlTintColor = UIColor(hex: 0x34dbff)
        vc.dismissButtonStyle = .close
        return vc
    }

    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
