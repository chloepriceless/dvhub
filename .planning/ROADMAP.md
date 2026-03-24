# DVhub Roadmap

## Milestone 1: v0.5.0

<!-- phases -->

<!-- /phases -->

### Phase 1: Historie: DV-Mehrerloes vs Einspeiseverguetung berechnen

**Goal:** Berechne den finanziellen Vorteil der Direktvermarktung gegenueber der EEG-Einspeiseverguetung und zeige in der Historie (Monat/Jahr) einen Vergleich mit 5 neuen Zeilen in der Gesamtbilanz-Karte: hypothetische Einspeiseverguetung (Volleinspeisung + Ueberschuss), DV-Mehrerlos, DV-Kosten, Netto DV-Vorteil.
**Requirements:** [EEG-RULES, DV-CALC, DV-CONFIG, DV-UI]
**Depends on:** Phase 0
**Plans:** 3 plans

Plans:
- [x] 01-01-PLAN.md — EEG rules lookup table (eeg-rules.js) with TDD
- [x] 01-02-PLAN.md — Backend DV comparison KPI calculation + config extension
- [ ] 01-03-PLAN.md — Frontend: 5 new rows in Gesamtbilanz card
