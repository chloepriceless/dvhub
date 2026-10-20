package main

// Prüfregeln und Namen, die die C-Bridge genauso verwendet.

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/enbility/spine-go/model"
)

// limitValid: Freigabe einer Grenze der Steuerbox.
//
// Vorzeichen nach EEBus LPP TestSpec V1.0.0: die Einspeisegrenze (APPL) ist
// immer <= 0 [LPP-TS-001] — eine positive wird abgelehnt. LPC: >= 0 (openeebus
// CsLpIsLimitValid). DVhub rechnet bei LPP mit dem Betrag (services/eebus/index.js).
func limitValid(uc string, w float64, durationS int64) bool {
	if uc == "lpp" {
		return w <= 0 && durationS >= 0
	}
	return w >= 0 && durationS >= 0
}

// failsafeValueValid: Failsafe-Grenze >= 0 [LPP-TS-038], openeebus CsLpIsFailsafeValueValid.
func failsafeValueValid(w float64) bool { return w >= 0 }

// failsafeDurationValid: 2 h bis 24 h (openeebus CsLpIsFailsafeDurationValid).
func failsafeDurationValid(s int64) bool { return s >= 2*3600 && s <= 24*3600 }

// secondsOf rundet eine Dauer auf ganze Sekunden.
func secondsOf(d time.Duration) int64 { return int64(math.Round(d.Seconds())) }

// entityKey: "d:_n:NIBE_123/1/1" — Schlüssel, mit dem DVhub eine entfernte Entität anspricht.
func entityKey(addr *model.EntityAddressType) string {
	if addr == nil {
		return ""
	}
	var b strings.Builder
	if addr.Device != nil {
		b.WriteString(string(*addr.Device))
	}
	for _, id := range addr.Entity {
		b.WriteByte('/')
		b.WriteString(strconv.FormatUint(uint64(id), 10))
	}
	return b.String()
}

// mpcName: Namen der Messgrößen wie bridge.c MeasurementName (phase 0 = gesamt, 1–3 = L1–L3).
func mpcName(kind string, phase int) string {
	l := ""
	if phase > 0 {
		l = "_l" + strconv.Itoa(phase)
	}
	switch kind {
	case "power":
		return "power" + l + "_w"
	case "energy_consumed":
		return "energy_consumed_wh"
	case "energy_produced":
		return "energy_produced_wh"
	case "current":
		return "current" + l + "_a"
	case "voltage":
		return "voltage" + l + "_v"
	case "frequency":
		return "frequency_hz"
	}
	return ""
}

// ohpcfStateName: Zustand des Verdichterlaufs wie bridge.c OhpcfStateName.
// "inactive" ist der angekündigte, noch nicht eingeplante Lauf; "invalid" ein
// abgebrochener (openeebus meldete dafür "undefined", eebus-go "stopped").
func ohpcfStateName(s model.PowerSequenceStateType) string {
	switch s {
	case model.PowerSequenceStateTypeInactive:
		return "announced"
	case model.PowerSequenceStateTypeScheduled:
		return "scheduled"
	case model.PowerSequenceStateTypeRunning:
		return "running"
	case model.PowerSequenceStateTypePaused, model.PowerSequenceStateTypeScheduledPaused:
		return "paused"
	case model.PowerSequenceStateTypeCompleted:
		return "completed"
	case model.PowerSequenceStateTypeInvalid:
		return "stopped"
	}
	return "undefined"
}
