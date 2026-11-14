// LiveActivityManager.swift — Live-Aktivität „Not-Halt aktiv“ starten,
// nachführen, beenden.
//
// Was das System zulässt (ActivityKit, ohne eigenen Push-Server):
//   • Starten geht nur, solange die App im Vordergrund ist, oder aus einem
//     App Intent, der `LiveActivityIntent` erfüllt (Kurzbefehl „Not-Halt
//     auslösen“). Erkennt erst der Hintergrundabruf den Not-Halt, kann er
//     keine Aktivität starten — sie erscheint beim nächsten Öffnen der App.
//   • Aktualisieren und Beenden gehen auch im Hintergrund, aber nur, wenn die
//     App gerade läuft: bei jedem Hintergrundabruf (BGAppRefreshTask). Wie oft
//     der kommt, entscheidet das System.
//   • Eine Aktivität lebt höchstens acht Stunden, danach beendet sie das System
//     und zeigt sie noch bis zu vier Stunden auf dem Sperrbildschirm.
// Deshalb zählt die Ansicht die Dauer selbst weiter und sagt nach `staleDate`,
// von wann die Werte sind.

import ActivityKit
import Foundation

@MainActor
enum LiveActivityManager {
    static let enabledKey = "liveActivityEmergencyStop"
    /// Nach dieser Zeit ohne Aktualisierung gelten die Werte als alt.
    static let staleAfter: TimeInterval = 20 * 60

    /// In „Mehr → Darstellung“ abschaltbar; ab Werk an.
    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: enabledKey)
            if !newValue { Task { await endAll() } }
        }
    }

    /// Erlaubt das System Live-Aktivitäten für diese App (Einstellungen → DVhub)?
    static var allowedBySystem: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    /// Nur laufende Aktivitäten: Eine vom System beendete (nach acht Stunden) steht
    /// noch bis zu vier Stunden auf dem Sperrbildschirm und ließe sich nicht mehr
    /// aktualisieren — dann beginnt eine neue.
    private static var current: [Activity<EmergencyStopAttributes>] {
        Activity<EmergencyStopAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
    }

    /// Aktivität an den Stand angleichen: Not-Halt aktiv → zeigen bzw.
    /// aktualisieren; aufgehoben → beenden; unbekannt → nichts ändern.
    static func sync(_ snapshot: WidgetSnapshot) async {
        guard let boxId = snapshot.boxId else { return }
        // Aktivitäten anderer Anlagen gehören nicht mehr hierher.
        for a in current where a.attributes.boxId != boxId { await a.end(nil, dismissalPolicy: .immediate) }
        let mine = current.filter { $0.attributes.boxId == boxId }
        switch snapshot.emergencyStop {
        case true?:
            guard enabled else { return }
            let since = mine.first?.content.state.since ?? snapshot.at
            let content = ActivityContent(state: EmergencyStopAttributes.ContentState(snapshot, since: since),
                                          staleDate: snapshot.at.addingTimeInterval(staleAfter), relevanceScore: 100)
            if let a = mine.first {
                // Ein älterer Stand überschreibt keinen neueren.
                guard snapshot.at >= a.content.state.updatedAt else { return }
                await a.update(content)
            } else if allowedBySystem {
                // Scheitert im Hintergrund außerhalb eines LiveActivityIntent — dann beim nächsten Öffnen.
                _ = try? Activity.request(attributes: EmergencyStopAttributes(boxName: snapshot.boxName, boxId: boxId),
                                          content: content, pushType: nil)
            }
        case false?:
            for a in mine { await a.end(nil, dismissalPolicy: .immediate) }
        case nil:
            break
        }
    }

    static func endAll() async {
        for a in current { await a.end(nil, dismissalPolicy: .immediate) }
    }
}
