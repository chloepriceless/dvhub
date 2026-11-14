// ScheduleView.swift — Zeitplan der Steuerung bedienen: Regeln von Hand
// anlegen, ändern, löschen und umschalten, Grundwerte, Börsenautomatik und
// „Neu planen“. Vorbild ist der Fahrplan der Weboberfläche (app.js).
//
// Endpunkte: /api/schedule (lesen), /api/schedule/rules, /rules/toggle,
// /api/schedule/config, /api/schedule/automation/config und /replan.
// Der Regel-Endpunkt ersetzt alle Regeln von Hand — deshalb liest die App vor
// jedem Speichern den Stand frisch und ändert genau eine Regel
// (ScheduleEdit.payload im Paket, dort getestet).
//
// Die Editoren stehen auf der Seite selbst (keine Blätter): gleiches Verhalten
// zugeklappt und aufgeklappt.

import SwiftUI
import DVhubLink

/// Richtung des Netz-Sollwerts: DVhub schreibt Einspeisung negativ, Bezug positiv.
enum GridDirection: String, CaseIterable, Identifiable {
    case feedIn, draw
    var id: String { rawValue }
    var title: String {
        switch self {
        case .feedIn: return String(localized: "Einspeisen")
        case .draw: return String(localized: "Beziehen")
        }
    }
    static func of(_ watts: Double) -> GridDirection { watts < 0 ? .feedIn : .draw }
    func signed(_ amount: Double) -> Double { self == .feedIn ? -abs(amount) : abs(amount) }
}

struct ScheduleSection: View {
    let controller: SystemController
    let schedule: JSONValue
    /// Antwort von GET /api/schedule/automation/config (ältere DVhub-Stände geben sie der App nicht).
    let automation: JSONValue?
    let wide: Bool
    let reload: () async -> Void

    @State private var busy = false
    @State private var feedback: WriteFeedback?

    // Regel-Editor
    private enum Editing: Equatable { case new, rule(String) }
    @State private var editing: Editing?
    @State private var target = "gridSetpointW"
    @State private var start = ClockTime.date("12:00")
    @State private var end = ClockTime.date("14:00")
    @State private var direction = GridDirection.feedIn
    @State private var amount = ""
    @State private var stopOn = false
    @State private var stopSoc = 20.0
    @State private var enabled = true
    @State private var confirmDelete: ScheduleRule?

    // Grundwerte
    @State private var editingDefaults = false
    @State private var defDirection = GridDirection.feedIn
    @State private var defAmount = ""
    @State private var defCharge = ""
    @State private var defDcFeed = true

    // Börsenautomatik
    @State private var editingAutomation = false
    @State private var autoOn = false
    @State private var autoStart = ClockTime.date("14:00")
    @State private var autoEnd = ClockTime.date("09:00")
    @State private var autoReserve = 20.0
    @State private var autoMaxW = ""

    private var canEdit: Bool { controller.canControl && controller.isOnline && !busy }
    private var rules: [ScheduleRule] { ScheduleEdit.rules(from: schedule) }

    var body: some View {
        Group {
            if wide {
                HStack(alignment: .top, spacing: 14) {
                    rulesCard
                    VStack(spacing: 14) { defaultsCard; automationCard }
                }
            } else {
                rulesCard
                defaultsCard
                automationCard
            }
        }
        .confirmationDialog("Regel löschen?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Regel löschen", role: .destructive) {
                if let rule = confirmDelete { Task { await saveRule(.remove(rule), reason: String(localized: "Regel löschen")) } }
            }
        } message: {
            if let r = confirmDelete { Text("\(r.start)–\(r.end) · \(Self.summary(r))") }
        }
    }

    // MARK: Regeln

    static func summary(_ r: ScheduleRule) -> String {
        var text = IntegrationsView.targetName(r.target) + " " + PlanView.targetValue(r.target, r.value)
        if let stop = r.stopSocPct { text += String(localized: " · bis \(Format.percent(stop)) Akku") }
        return text
    }

    private var rulesCard: some View {
        let active = schedule["active"] ?? .null
        let manual = rules.filter { !$0.isAutomation }
        let planned = rules.filter(\.isAutomation)
        return GlassCard(tint: Brand.yellow) {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Zeitplan der Steuerung", icon: "clock.badge.checkmark", tint: Brand.yellow)
                RowStack {
                    ForEach(["gridSetpointW", "minSocPct", "maxDischargeW", "chargeCurrentA"], id: \.self) { t in
                        if let v = active[t]?["value"]?.number {
                            ValueRow(label: String(localized: "Jetzt: \(IntegrationsView.targetName(t))"), value: PlanView.targetValue(t, v),
                                     hint: active[t]?["source"]?.string.map(DetailView.sourceName))
                        }
                    }
                }
                Text("Regeln von Hand").font(.caption.weight(.bold)).foregroundStyle(Brand.text).padding(.top, 4)
                if manual.isEmpty {
                    Text("Keine Regeln von Hand.").font(.footnote).foregroundStyle(Brand.text2)
                } else {
                    RowStack {
                        ForEach(manual) { rule in
                            VStack(alignment: .leading, spacing: 8) {
                                ruleRow(rule)
                                if editing == .rule(rule.id) { editor(rule) }
                            }
                        }
                    }
                }
                if editing == .new {
                    editor(nil)
                } else if controller.canControl {
                    Button { beginNew() } label: { Label("Regel hinzufügen", systemImage: "plus.circle.fill") }
                        .font(.subheadline.weight(.semibold))
                        .disabled(!canEdit)
                        .accessibilityIdentifier("schedule.add")
                }
                if !planned.isEmpty {
                    Text(planned.count == 1 ? "1 Regel aus dem Plan" : "\(planned.count) Regeln aus dem Plan").font(.caption.weight(.bold)).foregroundStyle(Brand.text).padding(.top, 6)
                    RowStack {
                        ForEach(planned.prefix(12)) { ruleRow($0) }
                    }
                    if planned.count > 12 { Text("… und \(planned.count - 12) weitere").font(.caption2).foregroundStyle(Brand.dim) }
                    FormNote(text: "Regeln aus dem Plan erzeugt DVhub selbst (Optimierer, Börsenautomatik). Hier lassen sie sich einzeln aus- und einschalten.")
                }
                WriteStatus(busy: busy, feedback: feedback, id: "schedule.status")
            }
            .tint(Brand.cyan)
        }
    }

    private func ruleRow(_ rule: ScheduleRule) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Button {
                guard rule.isEditable, controller.canControl else { return }
                withAnimation(.snappy) {
                    if editing == .rule(rule.id) { editing = nil } else { begin(rule) }
                }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: "\(rule.start)–\(rule.end)")
                        .font(.system(.subheadline, design: .rounded).weight(.semibold)).monospacedDigit()
                        .foregroundStyle(rule.enabled ? Brand.text : Brand.dim)
                    Text(Self.summary(rule) + (rule.source.map { " · " + DetailView.sourceName($0) } ?? ""))
                        .font(.caption).foregroundStyle(rule.enabled ? Brand.text2 : Brand.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(rule.isEditable && controller.canControl ? Text("Öffnet die Regel zum Ändern") : Text(verbatim: ""))
            .accessibilityIdentifier("schedule.rule.\(rule.ruleId ?? rule.id)")
            if rule.isEditable && controller.canControl {
                Image(systemName: "pencil").font(.caption.weight(.bold)).foregroundStyle(Brand.dim).accessibilityHidden(true)
            }
            if rule.canToggle {
                Toggle("Regel aktiv", isOn: Binding(get: { rule.enabled }, set: { on in Task { await toggle(rule, on) } }))
                    .labelsHidden()
                    .disabled(!canEdit)
                    .accessibilityLabel("Regel \(rule.start) bis \(rule.end) aktiv")
                    .accessibilityIdentifier("schedule.toggle.\(rule.ruleId ?? rule.id)")
            } else if !rule.enabled {
                Pill(text: "aus", tint: Brand.dim)
            }
        }
        .padding(.vertical, 7)
    }

    private func beginNew() {
        target = "gridSetpointW"
        start = ClockTime.date("12:00")
        end = ClockTime.date("14:00")
        direction = .feedIn
        amount = ""
        stopOn = false
        stopSoc = 20
        enabled = true
        feedback = nil
        withAnimation(.snappy) { editing = .new }
    }

    private func begin(_ rule: ScheduleRule) {
        target = rule.target
        start = ClockTime.date(rule.start)
        end = ClockTime.date(rule.end)
        direction = GridDirection.of(rule.value ?? 0)
        amount = String(Int(abs(rule.value ?? 0).rounded()))
        stopOn = rule.stopSocPct != nil
        stopSoc = ((rule.stopSocPct ?? 20) / 5).rounded() * 5
        enabled = rule.enabled
        feedback = nil
        editing = .rule(rule.id)
    }

    private var draft: ScheduleEdit.Draft? {
        guard let n = Double(amount.replacingOccurrences(of: ",", with: ".")), n.isFinite, n >= 0 else { return nil }
        let grid = target == "gridSetpointW"
        return ScheduleEdit.Draft(target: target, start: ClockTime.string(start), end: ClockTime.string(end),
                                  value: grid ? direction.signed(n) : n, stopSocPct: grid && stopOn ? stopSoc : nil, enabled: enabled)
    }

    private func editor(_ rule: ScheduleRule?) -> some View {
        let problem = draft.map(ScheduleEdit.validate) ?? .some(.valueOutOfRange(max: target == "gridSetpointW" ? ScheduleEdit.maxGridSetpointW : ScheduleEdit.maxChargeCurrentA))
        return VStack(alignment: .leading, spacing: 10) {
            if rule == nil { Text("Neue Regel").font(.subheadline.weight(.bold)).foregroundStyle(Brand.text) }
            Picker("Art", selection: $target) {
                Text("Netz-Sollwert").tag("gridSetpointW")
                Text("Ladestrom").tag("chargeCurrentA")
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("schedule.edit.target")
            DatePicker("Von", selection: $start, displayedComponents: .hourAndMinute)
            DatePicker("Bis", selection: $end, displayedComponents: .hourAndMinute)
            if target == "gridSetpointW" {
                Picker("Richtung", selection: $direction) {
                    ForEach(GridDirection.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                numberField("Leistung am Netzpunkt", unit: "W", text: $amount, id: "schedule.edit.amount")
                Toggle("Beenden, wenn der Akku einen Stand erreicht", isOn: $stopOn)
                if stopOn { PercentField(title: "Akku-Stand", value: $stopSoc, range: 0...100) }
                FormNote(text: direction == .feedIn
                         ? "DVhub regelt in diesem Zeitfenster so, dass am Netzanschluss diese Leistung eingespeist wird – auch aus dem Akku."
                         : "DVhub regelt in diesem Zeitfenster so, dass am Netzanschluss diese Leistung bezogen wird – der Akku lädt dann auch aus dem Netz.")
            } else {
                numberField("Ladestrom", unit: "A", text: $amount, id: "schedule.edit.amount")
            }
            Toggle("Regel aktiv", isOn: $enabled)
            if !amount.isEmpty, let problem {
                Label(problem.message, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Brand.orange)
            }
            HStack(spacing: 12) {
                Button {
                    guard let draft else { return }
                    let change: ScheduleEdit.Change = rule.map { .update($0, draft) } ?? .add(draft)
                    Task { await saveRule(change, reason: rule == nil ? String(localized: "Regel anlegen") : String(localized: "Regel ändern")) }
                } label: { Label("Speichern", systemImage: "checkmark") }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canEdit || problem != nil)
                    .accessibilityIdentifier("schedule.edit.save")
                Button("Abbrechen") { withAnimation(.snappy) { editing = nil } }
                    .disabled(busy)
                Spacer()
                if let rule {
                    Button(role: .destructive) { confirmDelete = rule } label: { Label("Löschen", systemImage: "trash") }
                        .disabled(!canEdit)
                        .accessibilityIdentifier("schedule.edit.delete")
                }
            }
        }
        .font(.subheadline)
        .padding(12)
        .background(Brand.glassStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.bottom, 6)
    }

    private func numberField(_ title: LocalizedStringKey, unit: String, text: Binding<String>, id: String) -> some View {
        HStack {
            Text(title).foregroundStyle(Brand.text)
            Spacer(minLength: 8)
            TextField("0", text: text)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .font(.system(.body, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .frame(maxWidth: 110)
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(Brand.bg0.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityLabel(title)
                .accessibilityIdentifier(id)
            Text(verbatim: unit).foregroundStyle(Brand.text2)
        }
    }

    /// Bestätigen, Stand frisch lesen, genau eine Regel ändern, alle Regeln von Hand zurückschicken.
    private func saveRule(_ change: ScheduleEdit.Change, reason: String) async {
        feedback = nil
        busy = true
        let result = await controller.confirmed(reason) {
            let fresh = try await controller.request("GET", "/api/schedule")
            guard fresh.status == 200 else { return WriteFeedback(ok: false, text: String(localized: "Zeitplan nicht lesbar (HTTP \(fresh.status)).")) }
            switch ScheduleEdit.payload(schedule: fresh.body, change: change) {
            case .failure(let p): return WriteFeedback(ok: false, text: p.message)
            case .success(let body):
                let out = WriteOutcome.from(try await controller.request("POST", "/api/schedule/rules", body: body))
                return WriteFeedback(ok: out.ok, text: out.message)
            }
        }
        busy = false
        feedback = result
        if result.ok { editing = nil }
        // Auch nach einem Fehler neu laden: Der Zeitplan kann sich inzwischen geändert haben.
        await reload()
    }

    private func toggle(_ rule: ScheduleRule, _ on: Bool) async {
        guard let id = rule.ruleId else { return }
        feedback = nil
        busy = true
        let result = await controller.confirmedPost("/api/schedule/rules/toggle", body: ["ids": [.string(id)], "enabled": .bool(on)],
                                                    reason: on ? String(localized: "Regel einschalten") : String(localized: "Regel ausschalten"))
        busy = false
        feedback = result
        await reload()
    }

    // MARK: Grundwerte

    private var defaultsCard: some View {
        let cfg = schedule["config"] ?? .null
        let grid = cfg["defaultGridSetpointW"]?.number
        let charge = cfg["defaultChargeCurrentA"]?.number
        let dc = cfg["defaultFeedExcessDcPv"]?.number
        return GlassCard(tint: Brand.blue) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Eyebrow(text: "Grundwerte", icon: "slider.horizontal.3", tint: Brand.blue)
                    Spacer()
                    if controller.canControl && !editingDefaults {
                        Button("Ändern") {
                            defDirection = GridDirection.of(grid ?? 0)
                            defAmount = String(Int(abs(grid ?? 0).rounded()))
                            defCharge = charge.map { String(Int($0.rounded())) } ?? ""
                            defDcFeed = dc == 1
                            feedback = nil
                            withAnimation(.snappy) { editingDefaults = true }
                        }
                        .font(.subheadline.weight(.semibold))
                        .disabled(!canEdit)
                        .accessibilityIdentifier("schedule.defaults.edit")
                    }
                }
                FormNote(text: "Gelten immer dann, wenn keine Regel greift.")
                if editingDefaults {
                    VStack(alignment: .leading, spacing: 10) {
                        Picker("Richtung", selection: $defDirection) {
                            ForEach(GridDirection.allCases) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        numberField("Sollwert am Netzpunkt", unit: "W", text: $defAmount, id: "schedule.defaults.grid")
                        numberField("Ladestrom", unit: "A", text: $defCharge, id: "schedule.defaults.charge")
                        if dc != nil { Toggle("DC-Überschuss einspeisen", isOn: $defDcFeed) }
                        HStack(spacing: 12) {
                            Button { Task { await saveDefaults(grid: grid, charge: charge, dc: dc) } } label: { Label("Speichern", systemImage: "checkmark") }
                                .buttonStyle(.borderedProminent)
                                .disabled(!canEdit || defaultsBody(grid: grid, charge: charge, dc: dc) == nil)
                                .accessibilityIdentifier("schedule.defaults.save")
                            Button("Abbrechen") { withAnimation(.snappy) { editingDefaults = false } }.disabled(busy)
                        }
                    }
                    .font(.subheadline)
                } else {
                    RowStack {
                        if let grid { ValueRow(label: "Sollwert am Netzpunkt", value: Format.signedPower(grid), hint: String(localized: "+ Bezug, − Einspeisung")) }
                        if let charge { ValueRow(label: "Ladestrom", value: "\(Format.number(charge, digits: 0)) A") }
                        if let dc { ValueRow(label: "DC-Überschuss einspeisen", value: dc == 1 ? String(localized: "ja") : String(localized: "nein")) }
                    }
                }
            }
            .tint(Brand.cyan)
        }
    }

    /// Nur geänderte Felder; nil = nichts geändert oder Eingabe unbrauchbar.
    private func defaultsBody(grid: Double?, charge: Double?, dc: Double?) -> JSONValue? {
        var body: [String: JSONValue] = [:]
        guard let g = Double(defAmount), g >= 0, g <= ScheduleEdit.maxGridSetpointW else { return nil }
        let signed = defDirection.signed(g)
        if signed != grid { body["defaultGridSetpointW"] = .double(signed) }
        if !defCharge.isEmpty || charge != nil {
            guard let c = Double(defCharge), c >= 0, c <= ScheduleEdit.maxChargeCurrentA else { return nil }
            if c != charge { body["defaultChargeCurrentA"] = .double(c) }
        }
        if let dc, (dc == 1) != defDcFeed { body["defaultFeedExcessDcPv"] = .int(defDcFeed ? 1 : 0) }
        return body.isEmpty ? nil : .object(body)
    }

    private func saveDefaults(grid: Double?, charge: Double?, dc: Double?) async {
        guard let body = defaultsBody(grid: grid, charge: charge, dc: dc) else { return }
        feedback = nil
        busy = true
        let result = await controller.confirmedPost("/api/schedule/config", body: body, reason: String(localized: "Grundwerte ändern"))
        busy = false
        feedback = result
        if result.ok { editingDefaults = false }
        await reload()
    }

    // MARK: Börsenautomatik

    @ViewBuilder
    private var automationCard: some View {
        if let automation, let cfg = automation["config"], cfg.object != nil {
            let on = cfg["enabled"]?.bool == true
            GlassCard(tint: Brand.green) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Eyebrow(text: "Börsenautomatik", icon: "wand.and.stars", tint: Brand.green)
                        Spacer()
                        Pill(text: on ? String(localized: "an") : String(localized: "aus"), tint: on ? Brand.green : Brand.dim)
                    }
                    FormNote(text: "Sucht die teuersten Viertelstunden im Suchfenster und speist dann aus dem Akku ein – bis zur Reserve.")
                    if automation["optimizerEnabled"]?.bool == true {
                        FormNote(text: "Der Optimierer (EOS) plant bereits. Die Börsenautomatik wird dann meist nicht gebraucht.")
                    }
                    if editingAutomation {
                        VStack(alignment: .leading, spacing: 10) {
                            Toggle("Börsenautomatik aktiv", isOn: $autoOn).accessibilityIdentifier("schedule.auto.on")
                            if cfg["searchWindowStart"]?.string != nil { DatePicker("Suchfenster von", selection: $autoStart, displayedComponents: .hourAndMinute) }
                            if cfg["searchWindowEnd"]?.string != nil { DatePicker("Suchfenster bis", selection: $autoEnd, displayedComponents: .hourAndMinute) }
                            if cfg["minSocPct"]?.number != nil { PercentField(title: "Reserve im Akku", value: $autoReserve, range: 0...100) }
                            // Gibt „Meine Anlage“ die Leistung vor, plant die Automatik damit – dann gibt es hier nichts zu ändern.
                            if cfg["maxDischargeW"]?.number != nil, cfg["maxDischargeFromPlant"]?.bool != true {
                                numberField("Höchste Entladeleistung", unit: "W", text: $autoMaxW, id: "schedule.auto.maxW")
                            }
                            HStack(spacing: 12) {
                                Button { Task { await saveAutomation(cfg) } } label: { Label("Speichern", systemImage: "checkmark") }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(!canEdit || automationBody(cfg) == nil)
                                    .accessibilityIdentifier("schedule.auto.save")
                                Button("Abbrechen") { withAnimation(.snappy) { editingAutomation = false } }.disabled(busy)
                            }
                        }
                        .font(.subheadline)
                    } else {
                        RowStack {
                            if let a = cfg["searchWindowStart"]?.string, let b = cfg["searchWindowEnd"]?.string { ValueRow(label: "Suchfenster", value: "\(a)–\(b)") }
                            if let v = cfg["minSocPct"]?.number {
                                ValueRow(label: "Reserve im Akku", value: Format.percent(v),
                                         hint: automation["globalMinSocPct"]?.number.map { String(localized: "Mindest-Ladestand der Anlage \(Format.percent($0))") })
                            }
                            if let v = cfg["maxDischargeW"]?.number {
                                ValueRow(label: "Höchste Entladeleistung", value: Format.power(v),
                                         hint: cfg["maxDischargeFromPlant"]?.bool == true ? String(localized: "aus „Meine Anlage“ in DVhub") : nil)
                            }
                            if let n = schedule["smallMarketAutomation"]?["generatedRuleCount"]?.number {
                                ValueRow(label: "Regeln im Zeitplan", value: String(Int(n)))
                            }
                        }
                        if controller.canControl {
                            HStack(spacing: 12) {
                                Button("Ändern") {
                                    autoOn = on
                                    autoStart = ClockTime.date(cfg["searchWindowStart"]?.string ?? "14:00")
                                    autoEnd = ClockTime.date(cfg["searchWindowEnd"]?.string ?? "09:00")
                                    autoReserve = ((cfg["minSocPct"]?.number ?? 20) / 5).rounded() * 5
                                    autoMaxW = cfg["maxDischargeW"]?.number.map { String(Int(abs($0).rounded())) } ?? ""
                                    feedback = nil
                                    withAnimation(.snappy) { editingAutomation = true }
                                }
                                .accessibilityIdentifier("schedule.auto.edit")
                                Button { Task { await replan() } } label: { Label("Neu planen", systemImage: "arrow.triangle.2.circlepath") }
                                    .accessibilityIdentifier("schedule.auto.replan")
                            }
                            .font(.subheadline.weight(.semibold))
                            .disabled(!canEdit)
                        }
                    }
                }
                .tint(Brand.cyan)
            }
        }
    }

    private func automationBody(_ cfg: JSONValue) -> JSONValue? {
        var body: [String: JSONValue] = [:]
        if autoOn != (cfg["enabled"]?.bool == true) { body["enabled"] = .bool(autoOn) }
        if let a = cfg["searchWindowStart"]?.string, ClockTime.string(autoStart) != ScheduleEdit.normalizeTime(a) { body["searchWindowStart"] = .string(ClockTime.string(autoStart)) }
        if let b = cfg["searchWindowEnd"]?.string, ClockTime.string(autoEnd) != ScheduleEdit.normalizeTime(b) { body["searchWindowEnd"] = .string(ClockTime.string(autoEnd)) }
        if let r = cfg["minSocPct"]?.number, r != autoReserve { body["minSocPct"] = .double(autoReserve) }
        if let w = cfg["maxDischargeW"]?.number, cfg["maxDischargeFromPlant"]?.bool != true {
            guard let n = Double(autoMaxW), n >= 0, n <= ScheduleEdit.maxGridSetpointW else { return nil }
            // Das Vorzeichen der Box bleibt, geändert wird der Betrag.
            let signed = w < 0 ? -n : n
            if signed != w { body["maxDischargeW"] = .double(signed) }
        }
        return body.isEmpty ? nil : .object(body)
    }

    private func saveAutomation(_ cfg: JSONValue) async {
        guard let body = automationBody(cfg) else { return }
        feedback = nil
        busy = true
        let result = await controller.confirmedPost("/api/schedule/automation/config", body: body, reason: String(localized: "Börsenautomatik ändern"))
        busy = false
        feedback = result
        if result.ok { editingAutomation = false }
        await reload()
    }

    private func replan() async {
        feedback = nil
        busy = true
        let result = await controller.confirmed(String(localized: "Neu planen")) {
            let r = try await controller.request("POST", "/api/schedule/automation/replan", body: [:])
            let out = WriteOutcome.from(r)
            guard out.ok else { return WriteFeedback(ok: false, text: out.message) }
            let n = Int(r.body["generatedRuleCount"]?.number ?? 0)
            return WriteFeedback(ok: true, text: n == 1 ? String(localized: "Neu geplant: 1 Regel.") : String(localized: "Neu geplant: \(n) Regeln."))
        }
        busy = false
        feedback = result
        await reload()
    }
}
