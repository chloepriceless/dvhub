// WriteSupport.swift — gemeinsame Teile der Bedien-Seiten (E-Auto, Zeitplan):
// Schreibanfrage mit Bestätigung am Gerät, Rückmeldung, Uhrzeit-Felder.
//
// Jede Änderung an der Anlage bestätigt man wie den Not-Halt mit Touch ID
// (iPhone Duo), Face ID oder dem Gerätecode. Die Box prüft das Recht „Steuern“
// selbst und trägt die Änderung mit der Kennung des Handys ins Protokoll ein.

import SwiftUI
import DVhubLink

/// Rückmeldung nach einer Schreibanfrage.
struct WriteFeedback: Equatable {
    let ok: Bool
    let text: String
}

extension SystemController {
    /// Erst am Gerät bestätigen, dann `work` ausführen (eine oder mehrere Anfragen).
    func confirmed(_ reason: String, _ work: () async throws -> WriteFeedback) async -> WriteFeedback {
        guard canControl else { return WriteFeedback(ok: false, text: WriteOutcome.notAllowed.message) }
        guard isOnline else { return WriteFeedback(ok: false, text: String(localized: "Ändern geht nur, wenn die Anlage verbunden ist.")) }
        if case .failure(let e) = await DeviceAuth.confirm(String(localized: "\(reason) an \(credentials.boxName)", comment: "Grund für Touch ID: z. B. Zeitplan ändern an Meine Anlage")) {
            return WriteFeedback(ok: false, text: String(localized: "Nicht bestätigt: \(e.localizedDescription)"))
        }
        do {
            return try await work()
        } catch {
            return WriteFeedback(ok: false, text: userMessage(for: error))
        }
    }

    /// Eine Schreibanfrage, bestätigt am Gerät.
    func confirmedPost(_ path: String, body: JSONValue, reason: String) async -> WriteFeedback {
        await confirmed(reason) {
            let out = WriteOutcome.from(try await request("POST", path, body: body))
            return WriteFeedback(ok: out.ok, text: out.message)
        }
    }
}

/// Zeile unter einem Formular: läuft gerade, gespeichert oder Fehler — mit Haptik.
struct WriteStatus: View {
    let busy: Bool
    let feedback: WriteFeedback?
    var id: String = "writeStatus"

    var body: some View {
        Group {
            if busy {
                HStack(spacing: 8) { ProgressView(); Text("Wird gespeichert …").font(.footnote).foregroundStyle(Brand.text2) }
            } else if let feedback {
                Label(feedback.text, systemImage: feedback.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(feedback.ok ? Brand.green : Brand.orange)
                    .accessibilityIdentifier(id)
            }
        }
        .sensoryFeedback(trigger: feedback) { _, new in
            guard let new else { return nil }
            return new.ok ? .success : .error
        }
    }
}

/// Warum hier gerade nichts zu ändern ist.
struct ControlHint: View {
    let controller: SystemController

    var body: some View {
        if !controller.canControl {
            NoticeBanner(text: "Dieses Gerät darf nur anzeigen. Zum Ändern in DVhub unter „Handy-App“ die Freigabe „Anzeigen und steuern“ vergeben.", icon: "lock", tint: Brand.cyan)
        } else if !controller.isOnline {
            NoticeBanner(text: "Ändern geht nur, wenn die Anlage verbunden ist.")
        }
    }
}

/// Uhrzeiten „HH:MM“ der Box. Sie tragen keine Zeitzone — die Box wendet sie in
/// ihrer eigenen an. Die Auswahl rechnet deshalb nur mit Stunde und Minute.
enum ClockTime {
    private static var calendar: Calendar { Calendar(identifier: .gregorian) }

    static func date(_ hhmm: String) -> Date {
        let parts = (ScheduleEdit.normalizeTime(hhmm) ?? "00:00").split(separator: ":").compactMap { Int($0) }
        return Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date()) ?? Date()
    }

    static func string(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// Wochentag aus 1 = Montag … 7 = Sonntag.
    static func weekday(_ day: Int, short: Bool = false) -> String {
        var cal = calendar
        cal.locale = Format.locale
        let names = short ? cal.shortStandaloneWeekdaySymbols : cal.standaloneWeekdaySymbols
        return names[((day % 7) + 7) % 7]
    }
}

/// Prozentwert mit Schieber in 5er-Schritten.
struct PercentField: View {
    let title: LocalizedStringKey
    @Binding var value: Double
    var range: ClosedRange<Double> = 10...100
    var id: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.subheadline).foregroundStyle(Brand.text)
                Spacer(minLength: 8)
                Text(Format.percent(value)).font(.system(.body, design: .rounded).weight(.semibold)).monospacedDigit().foregroundStyle(Brand.text)
            }
            Slider(value: $value, in: range, step: 5)
                .accessibilityLabel(title)
                .accessibilityValue(Format.percent(value))
                .accessibilityIdentifier(id ?? "")
        }
    }
}

/// Überschrift einer Formular-Karte mit optionalem Hinweis darunter.
struct FormNote: View {
    let text: LocalizedStringKey
    var body: some View {
        Text(text).font(.caption).foregroundStyle(Brand.text2).fixedSize(horizontal: false, vertical: true)
    }
}
