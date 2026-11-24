// EVView.swift — E-Auto voll bedienen: Zustand, Sofort laden / Laden stoppen
// (/api/ev/override), Planung (EOS plant mit, Mindest- und Max-Ladestand),
// Einmal-Ziel und der ganze Wochenplan (Abfahrten anlegen, ändern, löschen,
// „Zuhause ab“, Verbrauch der Fahrt) über /api/ev. Vorbild sind die
// E-Auto-Kachel und der Wochenplan der Weboberfläche (ev-tile.js,
// ev-weekly-editor.js).
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
    @State private var weekFeedback: WriteFeedback?
    @State private var chargeFeedback: WriteFeedback?

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
    // Wochenplan: aufgeklappte Zeile bzw. neue Abfahrt (Tag 1…7)
    @State private var editingRow: Int?
    @State private var newDay: Int?
    @State private var rowTime = ClockTime.date("07:00")
    @State private var rowOwnTarget = false
    @State private var rowSoc = 80.0
    @State private var rowTripOn = false
    @State private var rowTrip = 20.0
    @State private var rowHomeOn = false
    @State private var rowHome = ClockTime.date("18:00")
    @State private var rowHomePrev = true
    /// Hat man „am Vortag“ selbst gewählt? Sonst folgt es der Uhrzeit wie auf der Box.
    @State private var rowHomePrevTouched = false
    @State private var confirmRemove: EVState.WeekRow?
    // Sofort laden
    @State private var chargeW = 0.0
    @State private var chargeMinutes = 0
    @State private var confirmCharge: ChargeAction?

    private enum ChargeAction: String, Identifiable {
        case start, stop, end
        var id: String { rawValue }
    }

    private var canEdit: Bool { controller.canControl && controller.isOnline && !busy }

    var body: some View {
        AuroraPage(inlineTitle: true) { width in
            ControlHint(controller: controller)
            if let loadError, ev == nil { NoticeBanner(text: loadError, icon: "info.circle", tint: Brand.violet) }
            if let ev {
                if Layout.isWide(width) {
                    HStack(alignment: .top, spacing: 14) {
                        VStack(spacing: 14) { vehicleCard(ev); chargeNowCard(ev); onceCard(ev) }
                        VStack(spacing: 14) { planningCard(ev); weekCard(ev) }
                    }
                } else {
                    vehicleCard(ev)
                    chargeNowCard(ev)
                    planningCard(ev)
                    onceCard(ev)
                    weekCard(ev)
                }
                Text("Die E-Auto-Planung baut auf EOS auf und braucht in DVhub Pro. Fahrzeug und Wallbox richtest du in der Weboberfläche ein.")
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
        .confirmationDialog(confirmCharge.map(chargeTitle) ?? "", isPresented: Binding(get: { confirmCharge != nil }, set: { if !$0 { confirmCharge = nil } }), titleVisibility: .visible) {
            if let action = confirmCharge {
                Button(chargeTitle(action), role: action == .stop ? .destructive : nil) { Task { await runCharge(action) } }
            }
        } message: {
            if let action = confirmCharge { Text(chargeMessage(action)) }
        }
        .confirmationDialog("Abfahrt löschen?", isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }), titleVisibility: .visible) {
            Button("Abfahrt löschen", role: .destructive) {
                if let row = confirmRemove {
                    Task { await saveWeek(String(localized: "Abfahrt löschen"), original: row) { _ in .remove(index: row.index) } }
                }
            }
        } message: {
            if let r = confirmRemove { Text("\(ClockTime.weekday(r.day)) \(r.departure)") }
        }
        // Warnung beim Öffnen einer Rückfrage, wie beim Not-Halt.
        .sensoryFeedback(.warning, trigger: confirmCharge) { _, new in new != nil }
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

    // MARK: Sofort laden

    static let durations: [(minutes: Int, title: String)] = [
        (0, String(localized: "bis zum Abstecken")), (30, String(localized: "30 Minuten")), (60, String(localized: "1 Stunde")),
        (120, String(localized: "2 Stunden")), (240, String(localized: "4 Stunden")), (480, String(localized: "8 Stunden")),
    ]

    private func chargeTitle(_ a: ChargeAction) -> String {
        switch a {
        case .start: return String(localized: "Sofort laden")
        case .stop: return String(localized: "Laden stoppen")
        case .end: return String(localized: "Beenden und EOS wieder planen lassen")
        }
    }

    private var durationText: String {
        chargeMinutes == 0 ? String(localized: "bis zum Abstecken oder Beenden") : (Self.durations.first { $0.minutes == chargeMinutes }?.title ?? "")
    }

    private func chargeMessage(_ a: ChargeAction) -> String {
        switch a {
        case .start: return String(localized: "Die Wallbox lädt mit \(Format.power(chargeW)) – egal, was EOS plant und was der Strom gerade kostet. Dauer: \(durationText).")
        case .stop: return String(localized: "Die Wallbox lädt nicht – egal, was EOS plant. Auch ein Mindest-Ladestand zur Abfahrt wird dann nicht geladen. Dauer: \(durationText).")
        case .end: return String(localized: "Danach gilt wieder der Plan von EOS.")
        }
    }

    private func chargeNowCard(_ ev: EVState) -> some View {
        let limits = ev.overrideLimits
        return GlassCard(tint: Brand.orange) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Eyebrow(text: "Sofort laden", icon: "bolt.car.fill", tint: Brand.orange)
                    Spacer()
                    if let o = ev.override { Pill(text: o.stop ? String(localized: "gestoppt") : String(localized: "läuft"), tint: Brand.orange) }
                }
                if let o = ev.override {
                    let until = o.until.map { String(localized: " bis \(Self.when($0))") } ?? String(localized: " bis zum Abstecken oder Beenden")
                    Text(o.stop ? String(localized: "Laden ist gestoppt\(until).") : String(localized: "Sofort laden läuft mit \(Format.power(o.powerW))\(until)."))
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.text)
                        .accessibilityIdentifier("ev.overrideActive")
                    FormNote(text: "Solange das gilt, folgt die Wallbox nicht dem Plan von EOS.")
                    Button { confirmCharge = .end } label: { Label("Beenden", systemImage: "xmark.circle") }
                        .buttonStyle(.borderedProminent)
                        .disabled(!canEdit)
                        .accessibilityIdentifier("ev.overrideEnd")
                } else if !ev.chargerConfigured || limits == nil {
                    FormNote(text: "Dafür braucht DVhub eine Wallbox, die es steuern kann. Eingerichtet wird sie in der Weboberfläche.")
                } else if let limits {
                    FormNote(text: "Jetzt laden, egal was EOS plant – oder das Laden anhalten.")
                    if limits.maxPowerW > limits.minPowerW {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline) {
                                Text("Ladeleistung").foregroundStyle(Brand.text)
                                Spacer(minLength: 8)
                                Text(Format.power(chargeW)).font(.system(.body, design: .rounded).weight(.semibold)).monospacedDigit().foregroundStyle(Brand.text)
                            }
                            // Ohne Raster: Die Grenzen der Wallbox sind oft krumm (4140 … 11000 W), mit festen
                            // Schritten wäre der Höchstwert nicht zu erreichen. Gesendet werden ganze Watt.
                            Slider(value: $chargeW, in: limits.minPowerW...limits.maxPowerW)
                                .accessibilityLabel("Ladeleistung")
                                .accessibilityValue(Format.power(chargeW))
                                .accessibilityIdentifier("ev.chargePower")
                        }
                    } else {
                        ValueRow(label: "Ladeleistung", value: Format.power(limits.maxPowerW))
                    }
                    Picker("Dauer", selection: $chargeMinutes) {
                        ForEach(Self.durations, id: \.minutes) { Text($0.title).tag($0.minutes) }
                    }
                    .accessibilityIdentifier("ev.chargeDuration")
                    HStack(spacing: 12) {
                        Button { confirmCharge = .start } label: { Label("Sofort laden", systemImage: "bolt.fill") }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("ev.chargeNow")
                        Button { confirmCharge = .stop } label: { Label("Laden stoppen", systemImage: "pause.fill") }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("ev.chargeStop")
                    }
                    .disabled(!canEdit)
                }
                WriteStatus(busy: false, feedback: chargeFeedback, id: "ev.chargeStatus")
            }
            .font(.subheadline)
            .tint(Brand.cyan)
            .disabled(!controller.canControl)
        }
    }

    private func runCharge(_ action: ChargeAction) async {
        let duration = chargeMinutes == 0 ? nil : chargeMinutes
        let reason = chargeTitle(action)
        feedback = nil
        chargeFeedback = nil
        busy = true
        let result = await controller.confirmed(reason) {
            let r: LinkResponse
            switch action {
            case .start:
                guard let body = EVEdit.chargeNow(powerW: chargeW, durationMin: duration) else { return WriteFeedback(ok: false, text: String(localized: "Die Ladeleistung passt nicht.")) }
                r = try await controller.request("POST", "/api/ev/override", body: body)
            case .stop:
                guard let body = EVEdit.stopCharging(durationMin: duration) else { return WriteFeedback(ok: false, text: String(localized: "Die Dauer passt nicht.")) }
                r = try await controller.request("POST", "/api/ev/override", body: body)
            case .end:
                r = try await controller.request("DELETE", "/api/ev/override")
            }
            // „Gespeichert“ ist nicht „geschehen“: Not-Halt, fehlende Lizenz oder eine stumme Wallbox
            // meldet die Box im Ergebnis — ausgewertet im Paket (OverrideOutcome, getestet).
            let out = OverrideOutcome.from(r, action: action == .start ? .charge : (action == .stop ? .stop : .end))
            return WriteFeedback(ok: out.ok, text: out.message)
        }
        busy = false
        chargeFeedback = result
        await load()
    }

    // MARK: Wochenplan

    private func rowSubtitle(_ row: EVState.WeekRow) -> String? {
        var parts: [String] = []
        if !row.homeFrom.isEmpty { parts.append(row.homeFromPrevDay ? String(localized: "zuhause ab \(row.homeFrom) am Vortag") : String(localized: "zuhause ab \(row.homeFrom)")) }
        if let t = row.tripSocPct, t > 0 { parts.append(String(localized: "Fahrt braucht \(Format.percent(t))")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func weekCard(_ ev: EVState) -> some View {
        GlassCard(tint: Brand.cyan) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Eyebrow(text: "Wochenplan", icon: "calendar", tint: Brand.cyan)
                    Spacer()
                    if !ev.departureEnabled { Pill(text: "aus", tint: Brand.dim) }
                }
                if ev.week.isEmpty {
                    FormNote(text: "Noch keine Abfahrten. Mit „Abfahrt hinzufügen“ legst du die erste an.")
                } else {
                    RowStack {
                        ForEach(ev.week) { row in
                            VStack(alignment: .leading, spacing: 8) {
                                Button {
                                    let open = editingRow != row.index
                                    withAnimation(.snappy) { editingRow = open ? row.index : nil; newDay = nil }
                                    if open { begin(row, ev) }
                                } label: {
                                    HStack(alignment: .firstTextBaseline) {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(ClockTime.weekday(row.day)).font(.subheadline).foregroundStyle(Brand.text)
                                            if let sub = rowSubtitle(row) { Text(sub).font(.caption2).foregroundStyle(Brand.dim).fixedSize(horizontal: false, vertical: true) }
                                        }
                                        Spacer(minLength: 8)
                                        // Kurz halten: Die Spalte ist aufgeklappt schmal (zwei Karten nebeneinander).
                                        Text(row.departure.isEmpty ? String(localized: "keine Abfahrt")
                                             : "\(row.departure) · \(Format.percent(row.minSocPct ?? ev.defaultMinSocPct))")
                                            .font(.system(.subheadline, design: .rounded).weight(.semibold)).monospacedDigit()
                                            .foregroundStyle(row.departure.isEmpty ? Brand.dim : Brand.text)
                                            .fixedSize()
                                            .accessibilityLabel(row.departure.isEmpty ? String(localized: "keine Abfahrt")
                                                                : String(localized: "\(row.departure) · mind. \(Format.percent(row.minSocPct ?? ev.defaultMinSocPct))"))
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
                }
                if let day = newDay {
                    rowEditor(nil, ev, day: day)
                } else if controller.canControl {
                    // Auch eine zweite Abfahrt am selben Tag (z. B. morgens zur Arbeit, abends zum Sport).
                    Menu {
                        ForEach(1...7, id: \.self) { day in
                            Button(ClockTime.weekday(day)) { beginNew(day, ev) }
                        }
                    } label: { Label("Abfahrt hinzufügen", systemImage: "plus.circle.fill") }
                        .font(.subheadline.weight(.semibold))
                        .disabled(!canEdit || ev.week.filter { !$0.departure.isEmpty }.count >= EVEdit.maxWeeklyDepartures)
                        .accessibilityIdentifier("ev.week.add")
                }
                if !ev.departureEnabled {
                    FormNote(text: "Der Wochenplan ist ausgeschaltet („Abfahrten planen“). Ein Einmal-Ziel gilt trotzdem.")
                }
                WriteStatus(busy: false, feedback: weekFeedback, id: "ev.weekStatus")
            }
            .tint(Brand.cyan)
        }
    }

    private func begin(_ row: EVState.WeekRow, _ ev: EVState) {
        rowTime = ClockTime.date(row.departure.isEmpty ? "07:00" : row.departure)
        rowOwnTarget = row.minSocPct != nil
        rowSoc = row.minSocPct ?? (ev.defaultMinSocPct ?? 80).rounded()
        rowTripOn = row.tripSocPct != nil
        rowTrip = row.tripSocPct ?? 20
        rowHomeOn = !row.homeFrom.isEmpty
        rowHome = ClockTime.date(row.homeFrom.isEmpty ? "18:00" : row.homeFrom)
        rowHomePrev = row.homeFrom.isEmpty ? true : row.homeFromPrevDay
        rowHomePrevTouched = !row.homeFrom.isEmpty
        weekFeedback = nil
    }

    private func beginNew(_ day: Int, _ ev: EVState) {
        rowTime = ClockTime.date("07:00")
        rowOwnTarget = false
        rowSoc = (ev.defaultMinSocPct ?? 80).rounded()
        rowTripOn = false
        rowTrip = 20
        rowHomeOn = false
        rowHome = ClockTime.date("18:00")
        rowHomePrev = true
        rowHomePrevTouched = false
        weekFeedback = nil
        withAnimation(.snappy) { editingRow = nil; newDay = day }
    }

    /// Entwurf aus den Feldern des Editors.
    private func rowDraft(day: Int) -> EVEdit.WeekDraft {
        let dep = ClockTime.string(rowTime), home = rowHomeOn ? ClockTime.string(rowHome) : ""
        return EVEdit.WeekDraft(day: day, departure: dep, minSocPct: rowOwnTarget ? rowSoc : nil, tripSocPct: rowTripOn ? rowTrip : nil,
                                homeFrom: home, homeFromPrevDay: rowHomeOn ? (rowHomePrevTouched ? rowHomePrev : nil) : nil)
    }

    /// Bestehende Zeile (`row`) ändern oder eine neue Abfahrt für `day` anlegen.
    private func rowEditor(_ row: EVState.WeekRow?, _ ev: EVState, day: Int? = nil) -> some View {
        let theDay = row?.day ?? day ?? 1
        let draft = rowDraft(day: theDay)
        // Dieselbe Prüfung wie beim Speichern, damit der Hinweis vorher dasteht.
        let problem: EVEdit.WeekProblem? = {
            let change: EVEdit.WeekChange = row.map { .update(index: $0.index, draft) } ?? .add(draft)
            if case .failure(let p) = EVEdit.weekPlan(ev.week, change: change) { return p }
            return nil
        }()
        let autoPrev = EVEdit.defaultHomeFromPrevDay(homeFrom: draft.homeFrom, departure: draft.departure)
        return VStack(alignment: .leading, spacing: 10) {
            if row == nil { Text("Neue Abfahrt am \(ClockTime.weekday(theDay))").font(.subheadline.weight(.bold)).foregroundStyle(Brand.text) }
            DatePicker("Abfahrt um", selection: $rowTime, displayedComponents: .hourAndMinute)
            Toggle("Eigenes Ziel für diese Abfahrt", isOn: $rowOwnTarget)
            if rowOwnTarget { PercentField(title: "Mindest-Ladestand", value: $rowSoc, range: 0...100) }
            Toggle("Verbrauch der Fahrt angeben", isOn: $rowTripOn)
            if rowTripOn {
                PercentField(title: "Die Fahrt braucht", value: $rowTrip, range: 0...100)
                FormNote(text: "So viel Akku kostet die Fahrt ab dieser Abfahrt. DVhub schätzt damit, wie voll das Auto zurückkommt.")
            }
            Toggle("„Zuhause ab“ angeben", isOn: $rowHomeOn)
            if rowHomeOn {
                DatePicker("Zuhause ab", selection: $rowHome, displayedComponents: .hourAndMinute)
                Picker("Tag", selection: Binding(get: { rowHomePrevTouched ? rowHomePrev : autoPrev }, set: { rowHomePrev = $0; rowHomePrevTouched = true })) {
                    Text("am Vortag").tag(true)
                    Text("am selben Tag").tag(false)
                }
                .pickerStyle(.segmented)
                FormNote(text: "Ab dann steht das Auto vor dieser Abfahrt wieder an der Wallbox – vorher kann nicht geladen werden.")
            }
            if let problem { Label(problem.message, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Brand.orange) }
            HStack(spacing: 12) {
                Button {
                    Task {
                        let d = rowDraft(day: theDay)
                        if let row {
                            await saveWeek(String(localized: "Wochenplan ändern"), original: row) { _ in .update(index: row.index, d) }
                        } else {
                            await saveWeek(String(localized: "Abfahrt anlegen"), original: nil) { _ in .add(d) }
                        }
                    }
                } label: { Label(row == nil ? "Anlegen" : "Speichern", systemImage: "checkmark") }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canEdit || problem != nil)
                    .accessibilityIdentifier("ev.week.save")
                Button("Abbrechen") { withAnimation(.snappy) { editingRow = nil; newDay = nil } }.disabled(busy)
                Spacer()
                if let row, !row.departure.isEmpty {
                    Button(role: .destructive) { confirmRemove = row } label: { Label("Löschen", systemImage: "trash") }
                        .disabled(!canEdit)
                        .accessibilityIdentifier("ev.week.delete")
                }
            }
        }
        .font(.subheadline)
        .padding(12)
        .background(Brand.glassStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.bottom, 6)
        .disabled(!controller.canControl)
    }

    /// Der Wochenplan geht als Ganzes zur Box. Deshalb vor dem Speichern frisch
    /// lesen und nur die eine Zeile ändern — sonst nähme die App Änderungen
    /// zurück, die inzwischen in der Weboberfläche gemacht wurden. Steht die
    /// betroffene Zeile inzwischen anders da, wird nichts geschickt.
    private func saveWeek(_ reason: String, original: EVState.WeekRow?, _ change: @escaping ([EVState.WeekRow]) -> EVEdit.WeekChange) async {
        feedback = nil
        weekFeedback = nil
        busy = true
        let result = await controller.confirmed(reason) {
            let fresh = try await controller.request("GET", "/api/ev")
            guard fresh.status == 200, let now = EVState.from(fresh.body) else {
                return WriteFeedback(ok: false, text: String(localized: "E-Auto nicht verfügbar (HTTP \(fresh.status))."))
            }
            if let original {
                guard let same = now.week.first(where: { $0.index == original.index }), same.raw == original.raw else {
                    return WriteFeedback(ok: false, text: EVEdit.WeekProblem.unknownRow.message)
                }
            }
            switch EVEdit.weekPlan(now.week, change: change(now.week)) {
            case .failure(let p): return WriteFeedback(ok: false, text: p.message)
            case .success(let body):
                let out = WriteOutcome.from(try await controller.request("POST", "/api/ev", body: body))
                return WriteFeedback(ok: out.ok, text: out.message)
            }
        }
        busy = false
        weekFeedback = result
        // Stand die Zeile inzwischen anders da, den Editor ebenfalls schließen: Seine Felder zeigen den alten
        // Entwurf, der Index kann nach dem Neuladen eine andere Zeile meinen — ein zweites „Speichern“
        // überschriebe sie (Gegenprüfung 6d123f87).
        if result.ok || result.text == EVEdit.WeekProblem.unknownRow.message { editingRow = nil; newDay = nil }
        // Auch nach einer Ablehnung neu laden: Die Seite zeigt dann den Stand der Box.
        await load()
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
            // Ladeleistung: beim ersten Mal die höchste, danach in den Grenzen der Wallbox halten.
            if let lim = s.overrideLimits {
                chargeW = chargeW == 0 ? lim.maxPowerW : min(lim.maxPowerW, max(lim.minPowerW, chargeW))
            }
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
