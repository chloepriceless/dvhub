// EVView.swift — E-Auto: Zustand, Planung (EOS plant mit, Mindest- und
// Max-Ladestand), Einmal-Ziel und Wochenplan. Lesen und Schreiben über
// /api/ev; Vorbild ist die E-Auto-Kachel der Weboberfläche (ev-tile.js).
//
// Alles steht auf der Seite selbst (keine Blätter): So verhält es sich auf dem
// zugeklappten und dem aufgeklappten iPhone Duo gleich.

import SwiftUI
import DVhubLink

struct EVView: View {
    let controller: SystemController
    @State private var ev: EVState?
    @State private var loadError: String?
    @State private var loading = false
    @State private var busy = false
    @State private var feedback: WriteFeedback?

    // Entwurf der Planung — gespeichert wird erst mit „Speichern“.
    @State private var optimize = false
    @State private var onlyPlugged = true
    @State private var planDepartures = false
    @State private var minSoc = 80.0
    @State private var maxOn = false
    @State private var maxSoc = 80.0
    // Einmal-Ziel
    @State private var onceDate = EVView.defaultOnce()
    @State private var onceSoc = 80.0
    // Wochenplan: aufgeklappte Zeile
    @State private var editingRow: Int?
    @State private var rowHasDeparture = true
    @State private var rowTime = ClockTime.date("07:00")
    @State private var rowOwnTarget = false
    @State private var rowSoc = 80.0

    private var canEdit: Bool { controller.canControl && controller.isOnline && !busy }

    var body: some View {
        AuroraPage(inlineTitle: true) { width in
            ControlHint(controller: controller)
            if let loadError, ev == nil { NoticeBanner(text: loadError, icon: "info.circle", tint: Brand.violet) }
            if let ev {
                if Layout.isWide(width) {
                    HStack(alignment: .top, spacing: 14) {
                        VStack(spacing: 14) { vehicleCard(ev); onceCard(ev) }
                        VStack(spacing: 14) { planningCard(ev); weekCard(ev) }
                    }
                } else {
                    vehicleCard(ev)
                    planningCard(ev)
                    onceCard(ev)
                    weekCard(ev)
                }
                Text("Die E-Auto-Planung baut auf EOS auf und braucht in DVhub Pro. Fahrzeug, Wallbox und Fahrtwerte richtest du in der Weboberfläche ein.")
                    .font(.caption2).foregroundStyle(Brand.dim)
            } else if loading {
                ProgressView().frame(maxWidth: .infinity, minHeight: 200)
            }
        }
        .navigationTitle("E-Auto")
        .screenActions(.more, [
            ScreenAction(id: "ev.refresh", title: String(localized: "Aktualisieren"), icon: "arrow.clockwise", disabled: loading) { Task { await load() } },
        ])
        .refreshable { await load() }
        .task(id: controller.isOnline) { await load() }
    }

    static func defaultOnce() -> Date {
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        return Calendar.current.date(bySettingHour: 7, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }

    /// „Morgen 07:00“, „Fr 07:00“ — kurz genug für eine Zeile; ab einer Woche mit Datum.
    static func when(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) || cal.isDateInTomorrow(d) || abs(d.timeIntervalSinceNow) < 6 * 86400 {
            let day = cal.isDateInToday(d) ? String(localized: "Heute") : cal.isDateInTomorrow(d) ? String(localized: "Morgen")
                : d.formatted(.dateTime.weekday(.abbreviated).locale(Format.locale))
            return "\(day) \(Format.time(d))"
        }
        return d.formatted(.dateTime.day().month(.twoDigits).hour().minute().locale(Format.locale))
    }

    // MARK: Fahrzeug

    private func vehicleCard(_ ev: EVState) -> some View {
        let v = ev.vehicle
        let charging = v.charging == true
        let connected = v.connected == true || v.plugged == true
        let tint = charging ? Brand.green : (connected ? Brand.cyan : Brand.dim)
        return GlassCard(tint: tint) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Eyebrow(text: v.title ?? String(localized: "E-Auto"), icon: "car.fill", tint: tint)
                    Spacer()
                    Pill(text: charging ? String(localized: "lädt") : (connected ? String(localized: "angesteckt") : String(localized: "nicht angesteckt")), tint: tint)
                }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    MetricValue(value: Format.percent(v.socPct), style: .largeTitle, id: "ev.soc")
                    if let r = v.rangeKm { Text("\(Int(r)) km").font(.subheadline).foregroundStyle(Brand.text2) }
                    Spacer()
                    if charging, let w = v.chargePowerW, w > 0 {
                        Text(Format.power(w)).font(.system(.headline, design: .rounded)).monospacedDigit().foregroundStyle(Brand.green)
                    }
                }
                RowStack {
                    if let at = ev.nextDeparture {
                        ValueRow(label: "Nächste Abfahrt", value: Self.when(at),
                                 hint: ev.nextTargetSocPct.map { String(localized: "mindestens \(Format.percent($0))") })
                    } else {
                        ValueRow(label: "Nächste Abfahrt", value: String(localized: "keine geplant"))
                    }
                    if let kwh = ev.planEnergyKwh {
                        ValueRow(label: "EOS lädt bis dahin", value: Format.energy(kwh),
                                 hint: ev.planSocAtDeparture.map { String(localized: "Ladestand bei Abfahrt \(Format.percent($0))") })
                    } else if ev.optimizeEv, ev.planError != nil {
                        ValueRow(label: "EOS-Plan", value: String(localized: "noch keiner"))
                    }
                }
                if let o = ev.override {
                    // Sofort laden / Laden stoppen startet man in der Weboberfläche; hier steht nur, dass es läuft.
                    let until = o.until.map { String(localized: " bis \(Format.time($0))") } ?? ""
                    NoticeBanner(text: o.stop ? String(localized: "Laden ist gestoppt\(until).") : String(localized: "Sofort laden läuft mit \(Format.power(o.powerW))\(until)."),
                                 icon: o.stop ? "pause.circle" : "bolt.car", tint: Brand.yellow)
                }
                if ev.lastCommandError != nil {
                    NoticeBanner(text: "Der letzte Befehl an die Wallbox ist fehlgeschlagen. Einzelheiten stehen in der Weboberfläche.", icon: "exclamationmark.triangle")
                }
            }
        }
    }

    // MARK: Planung

    private func planningDirty(_ ev: EVState) -> Bool {
        optimize != ev.optimizeEv || onlyPlugged != ev.onlyWhenPlugged || planDepartures != ev.departureEnabled
            || minSoc != (ev.defaultMinSocPct ?? 80).rounded() || maxOn != (ev.maxSocPct != nil) || (maxOn && maxSoc != (ev.maxSocPct ?? 80).rounded())
    }

    private func planningCard(_ ev: EVState) -> some View {
        GlassCard(tint: Brand.violet) {
            VStack(alignment: .leading, spacing: 12) {
                Eyebrow(text: "Planung", icon: "slider.horizontal.3", tint: Brand.violet)
                Toggle("Auto bei EOS mitplanen", isOn: $optimize).accessibilityIdentifier("ev.optimize")
                if optimize {
                    Toggle("Nur planen, wenn angesteckt", isOn: $onlyPlugged)
                }
                Toggle("Abfahrten planen", isOn: $planDepartures)
                Hairline()
                PercentField(title: "Mindest-Ladestand bis zur Abfahrt", value: $minSoc, id: "ev.minSoc")
                FormNote(text: "So voll ist das Auto zur Abfahrt mindestens – auch wenn der Strom gerade teuer ist.")
                Toggle("Weiter laden, wenn es günstig ist", isOn: $maxOn)
                if maxOn {
                    PercentField(title: "Höchstens bis", value: $maxSoc)
                    FormNote(text: "Über dem Mindest-Ladestand lädt EOS nur, wenn es sich lohnt. Bei diesem Stand beendet DVhub das Laden.")
                }
                if maxOn && maxSoc < minSoc {
                    Label("Der Höchststand liegt unter dem Mindest-Ladestand.", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Brand.orange)
                }
                HStack {
                    Button { Task { await savePlanning(ev) } } label: { Label("Speichern", systemImage: "checkmark") }
                        .buttonStyle(.borderedProminent)
                        .disabled(!canEdit || !planningDirty(ev) || (maxOn && maxSoc < minSoc))
                        .accessibilityIdentifier("ev.save")
                    if planningDirty(ev) {
                        Button("Verwerfen") { apply(ev) }.disabled(busy)
                    }
                }
                WriteStatus(busy: busy, feedback: feedback, id: "ev.status")
            }
            .font(.subheadline)
            .tint(Brand.cyan)
            .disabled(!controller.canControl)
        }
    }

    private func savePlanning(_ ev: EVState) async {
        var parts: [JSONValue] = []
        if optimize != ev.optimizeEv { parts.append(EVEdit.optimize(optimize)) }
        if onlyPlugged != ev.onlyWhenPlugged { parts.append(EVEdit.onlyWhenPlugged(onlyPlugged)) }
        if planDepartures != ev.departureEnabled { parts.append(EVEdit.departurePlanning(planDepartures)) }
        if minSoc != (ev.defaultMinSocPct ?? 80).rounded(), let b = EVEdit.minSoc(minSoc) { parts.append(b) }
        if maxOn != (ev.maxSocPct != nil) || (maxOn && maxSoc != (ev.maxSocPct ?? 80).rounded()), let b = EVEdit.maxSoc(maxOn ? maxSoc : nil) { parts.append(b) }
        guard !parts.isEmpty else { return }
        await send(EVEdit.merge(parts), reason: String(localized: "E-Auto-Planung ändern"))
    }

    // MARK: Einmal-Ziel

    private func onceCard(_ ev: EVState) -> some View {
        GlassCard(tint: Brand.yellow) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Eyebrow(text: "Einmal-Ziel", icon: "flag.checkered", tint: Brand.yellow)
                    Spacer()
                    if ev.once != nil { Pill(text: "aktiv", tint: Brand.yellow) }
                }
                if let at = ev.once {
                    Text("Bis \(Self.when(at)) mindestens \(Format.percent(ev.onceMinSocPct ?? ev.nextTargetSocPct)).")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.text)
                        .accessibilityIdentifier("ev.onceActive")
                    FormNote(text: "Das Einmal-Ziel gilt einmal und ersetzt die nächste Abfahrt aus dem Wochenplan. Danach gilt wieder der Wochenplan.")
                    Button(role: .destructive) {
                        Task { await send(EVEdit.clearOnce(), reason: String(localized: "Einmal-Ziel löschen")) }
                    } label: { Label("Einmal-Ziel löschen", systemImage: "trash") }
                        .disabled(!canEdit)
                        .accessibilityIdentifier("ev.onceClear")
                } else {
                    FormNote(text: "Für eine Fahrt außer der Reihe: bis zu einem Zeitpunkt einmal auf einen bestimmten Stand laden.")
                }
                DatePicker("Abfahrt", selection: $onceDate, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                PercentField(title: "Ladestand zur Abfahrt", value: $onceSoc, range: 10...100, id: "ev.onceSoc")
                Button {
                    guard let body = EVEdit.once(at: onceDate, minSocPct: onceSoc) else {
                        feedback = WriteFeedback(ok: false, text: String(localized: "Die Abfahrt muss in der Zukunft liegen."))
                        return
                    }
                    Task { await send(body, reason: String(localized: "Einmal-Ziel setzen")) }
                } label: { Label(ev.once == nil ? "Einmal-Ziel setzen" : "Einmal-Ziel ändern", systemImage: "flag") }
                    .buttonStyle(.bordered)
                    .disabled(!canEdit)
                    .accessibilityIdentifier("ev.onceSet")
            }
            .font(.subheadline)
            .tint(Brand.cyan)
            .disabled(!controller.canControl)
        }
    }

    // MARK: Wochenplan

    private func weekCard(_ ev: EVState) -> some View {
        GlassCard(tint: Brand.cyan) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Eyebrow(text: "Wochenplan", icon: "calendar", tint: Brand.cyan)
                    Spacer()
                    if !ev.departureEnabled { Pill(text: "aus", tint: Brand.dim) }
                }
                if ev.week.isEmpty {
                    FormNote(text: "Noch kein Wochenplan. Angelegt wird er in der Weboberfläche; hier lassen sich Abfahrtszeit und Ziel je Tag ändern.")
                } else {
                    RowStack {
                        ForEach(ev.week) { row in
                            VStack(alignment: .leading, spacing: 8) {
                                Button {
                                    withAnimation(.snappy) { editingRow = editingRow == row.index ? nil : row.index }
                                    if editingRow == row.index { begin(row, ev) }
                                } label: {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(ClockTime.weekday(row.day)).font(.subheadline).foregroundStyle(Brand.text)
                                        Spacer(minLength: 8)
                                        Text(row.departure.isEmpty ? String(localized: "keine Abfahrt")
                                             : String(localized: "\(row.departure) · mind. \(Format.percent(row.minSocPct ?? ev.defaultMinSocPct))"))
                                            .font(.system(.subheadline, design: .rounded).weight(.semibold)).monospacedDigit()
                                            .foregroundStyle(row.departure.isEmpty ? Brand.dim : Brand.text)
                                        Image(systemName: editingRow == row.index ? "chevron.up" : "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Brand.dim)
                                    }
                                    .padding(.vertical, 7)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("ev.week.\(row.index)")
                                if editingRow == row.index { rowEditor(row, ev) }
                            }
                        }
                    }
                    if !ev.departureEnabled {
                        FormNote(text: "Der Wochenplan ist ausgeschaltet („Abfahrten planen“). Ein Einmal-Ziel gilt trotzdem.")
                    }
                }
            }
            .tint(Brand.cyan)
        }
    }

    private func begin(_ row: EVState.WeekRow, _ ev: EVState) {
        rowHasDeparture = !row.departure.isEmpty
        rowTime = ClockTime.date(row.departure.isEmpty ? "07:00" : row.departure)
        rowOwnTarget = row.minSocPct != nil
        rowSoc = (row.minSocPct ?? ev.defaultMinSocPct ?? 80).rounded()
    }

    private func rowEditor(_ row: EVState.WeekRow, _ ev: EVState) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Abfahrt an diesem Tag", isOn: $rowHasDeparture)
            if rowHasDeparture {
                DatePicker("Abfahrt um", selection: $rowTime, displayedComponents: .hourAndMinute)
                Toggle("Eigenes Ziel für diesen Tag", isOn: $rowOwnTarget)
                if rowOwnTarget { PercentField(title: "Mindest-Ladestand", value: $rowSoc, range: 0...100) }
            }
            Button {
                let body = EVEdit.week(ev.week, changing: row.index, departure: rowHasDeparture ? ClockTime.string(rowTime) : "",
                                       minSocPct: rowHasDeparture && rowOwnTarget ? rowSoc : nil)
                guard let body else { return }
                Task {
                    await send(body, reason: String(localized: "Wochenplan ändern"))
                    if feedback?.ok == true { editingRow = nil }
                }
            } label: { Label("Tag speichern", systemImage: "checkmark") }
                .buttonStyle(.bordered)
                .disabled(!canEdit)
                .accessibilityIdentifier("ev.week.save")
        }
        .font(.subheadline)
        .padding(.bottom, 8)
        .disabled(!controller.canControl)
    }

    // MARK: Laden und Schreiben

    private func apply(_ s: EVState) {
        optimize = s.optimizeEv
        onlyPlugged = s.onlyWhenPlugged
        planDepartures = s.departureEnabled
        minSoc = (s.defaultMinSocPct ?? 80).rounded()
        maxOn = s.maxSocPct != nil
        maxSoc = (s.maxSocPct ?? 80).rounded()
        if let at = s.once, at > Date() { onceDate = at }
        if let soc = s.onceMinSocPct { onceSoc = soc.rounded() }
    }

    private func load() async {
        guard controller.isOnline, !loading else {
            if ev == nil { loadError = String(localized: "Das E-Auto braucht eine Verbindung zur Anlage.") }
            return
        }
        loading = true
        defer { loading = false }
        do {
            let r = try await controller.request("GET", "/api/ev")
            guard r.status == 200, let s = EVState.from(r.body) else {
                loadError = String(localized: "E-Auto nicht verfügbar (HTTP \(r.status)).")
                return
            }
            // Ungespeicherte Eingaben nicht überschreiben: nur übernehmen, wenn der Entwurf dem alten Stand entspricht.
            let untouched = ev.map { !planningDirty($0) } ?? true
            ev = s
            loadError = nil
            if untouched { apply(s) }
        } catch {
            loadError = userMessage(for: error)
        }
    }

    private func send(_ body: JSONValue, reason: String) async {
        feedback = nil
        busy = true
        let result = await controller.confirmedPost("/api/ev", body: body, reason: reason)
        busy = false
        feedback = result
        // Gespeichert: frisch von der Box lesen. Ein noch offener Entwurf der Planung bleibt stehen.
        if result.ok { await load() }
    }
}
