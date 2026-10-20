package main

// Verdichterläufe der Wärmepumpe (CEM OHPCF). eebus-go meldet jede Teiländerung
// einzeln; DVhub braucht wie bei der C-Bridge eine Ankündigung (frühester
// Start, spätestes Ende, Mindestlaufzeit), Zustandsmeldungen und das Ende eines
// Laufs. Dafür wertet ohpcfWatcher die SmartEnergyManagementPs-Daten des
// Verdichters direkt aus; eebus-go übernimmt Abo, Bindung und Schreiben.

import (
	"encoding/json"
	"time"

	eebusapi "github.com/enbility/eebus-go/api"
	"github.com/enbility/eebus-go/features/client"
	cemohpcf "github.com/enbility/eebus-go/usecases/cem/ohpcf"
	spineapi "github.com/enbility/spine-go/api"
	"github.com/enbility/spine-go/model"
)

type ohpcfAnnounce struct {
	MaxPowerW      float64
	EarliestStartS int64
	LatestEndS     int64
	MinDurationS   int64
	Stoppable      bool
	Pausable       bool
}

type ohpcfReport struct {
	Kind     string // "announce", "state", "clear" oder "" (nichts zu melden)
	Announce *ohpcfAnnounce
	State    string
	StartInS *int64
}

// relSeconds: relative Zeit direkt, absolute als Sekunden ab jetzt (nicht negativ).
func relSeconds(t *model.AbsoluteOrRelativeTimeType, now time.Time) (int64, bool) {
	if t == nil {
		return 0, false
	}
	if t.IsRelativeTime() {
		d, err := t.GetTimeDuration()
		if err != nil {
			return 0, false
		}
		return secondsOf(d), true
	}
	at, err := t.GetTime()
	if err != nil {
		return 0, false
	}
	s := secondsOf(at.Sub(now))
	if s < 0 {
		s = 0
	}
	return s, true
}

func ohpcfExtractAnnounce(seq model.SmartEnergyManagementPsPowerSequenceType, now time.Time) *ohpcfAnnounce {
	if seq.Description != nil && seq.Description.PowerUnit != nil && *seq.Description.PowerUnit != model.UnitOfMeasurementTypeW {
		return nil
	}
	var power, powerMax *float64
	if len(seq.PowerTimeSlot) > 0 && seq.PowerTimeSlot[0].ValueList != nil {
		for _, v := range seq.PowerTimeSlot[0].ValueList.Value {
			if v.ValueType == nil || v.Value == nil {
				continue
			}
			x := v.Value.GetValue()
			switch *v.ValueType {
			case model.PowerTimeSlotValueTypeTypePowerMax:
				powerMax = &x
			case model.PowerTimeSlotValueTypeTypePower:
				power = &x
			}
		}
	}
	if powerMax == nil {
		powerMax = power // ohne powerMax die geschätzte Leistung
	}
	if powerMax == nil || seq.ScheduleConstraints == nil {
		return nil
	}
	earliest, ok1 := relSeconds(seq.ScheduleConstraints.EarliestStartTime, now)
	latest, ok2 := relSeconds(seq.ScheduleConstraints.LatestEndTime, now)
	if !ok1 || !ok2 || seq.OperatingConstraintsDuration == nil || seq.OperatingConstraintsDuration.ActiveDurationMin == nil {
		return nil
	}
	minDur, err := seq.OperatingConstraintsDuration.ActiveDurationMin.GetTimeDuration()
	if err != nil {
		return nil
	}
	a := &ohpcfAnnounce{MaxPowerW: *powerMax, EarliestStartS: earliest, LatestEndS: latest, MinDurationS: secondsOf(minDur)}
	if oi := seq.OperatingConstraintsInterrupt; oi != nil {
		a.Stoppable = oi.IsStoppable != nil && *oi.IsStoppable
		a.Pausable = oi.IsPausable != nil && *oi.IsPausable
	}
	return a
}

// ohpcfAnalyze: Ankündigung (Zustand "inactive"), Zustand oder Ende (keine Alternative).
func ohpcfAnalyze(data *model.SmartEnergyManagementPsDataType, now time.Time) ohpcfReport {
	if data == nil {
		return ohpcfReport{}
	}
	if len(data.Alternatives) == 0 {
		if data.NodeScheduleInformation == nil {
			return ohpcfReport{}
		}
		return ohpcfReport{Kind: "clear"}
	}
	if n := data.NodeScheduleInformation; n != nil && n.AlternativesCount != nil && *n.AlternativesCount == 0 {
		return ohpcfReport{Kind: "clear"}
	}
	alt := data.Alternatives[0]
	if len(alt.PowerSequence) == 0 {
		return ohpcfReport{}
	}
	seq := alt.PowerSequence[0]
	if seq.State == nil || seq.State.State == nil {
		return ohpcfReport{}
	}
	st := *seq.State.State
	if st == model.PowerSequenceStateTypeInactive {
		a := ohpcfExtractAnnounce(seq, now)
		if a == nil {
			return ohpcfReport{}
		}
		return ohpcfReport{Kind: "announce", Announce: a, State: "announced"}
	}
	r := ohpcfReport{Kind: "state", State: ohpcfStateName(st)}
	if st == model.PowerSequenceStateTypeScheduled {
		if seq.Schedule == nil {
			return ohpcfReport{}
		}
		s, ok := relSeconds(seq.Schedule.StartTime, now)
		if !ok {
			return ohpcfReport{}
		}
		r.StartInS = &s
	}
	return r
}

func ohpcfAnnounceEvent(ski, key string, a *ohpcfAnnounce) *Obj {
	return entityEvent("ohpcf_announce", "ohpcf", key, ski).Num("max_power_w", a.MaxPowerW).
		Int("earliest_start_s", a.EarliestStartS).Int("latest_end_s", a.LatestEndS).
		Int("min_duration_s", a.MinDurationS).Bool("stoppable", a.Stoppable).Bool("pausable", a.Pausable)
}

func ohpcfStateEvent(ski, key, state string, startIn *int64) *Obj {
	ev := entityEvent("ohpcf_state", "ohpcf", key, ski).Str("state", state)
	if startIn != nil {
		ev.Int("start_in_s", *startIn)
	}
	return ev
}

func (b *Bridge) onOHPCF(ski string, _ spineapi.DeviceRemoteInterface, _ spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	if ev == cemohpcf.UseCaseSupportUpdate {
		b.syncRemotes(tagOHPCF, b.ohpcf)
	}
}

// ohpcfWatcher wertet Datenänderungen am SmartEnergyManagementPs des Verdichters aus.
type ohpcfWatcher struct{ b *Bridge }

func (w *ohpcfWatcher) HandleEvent(p spineapi.EventPayload) {
	b := w.b
	if p.EventType != spineapi.EventTypeDataChange || p.Entity == nil || b.ohpcf == nil || b.devEntity == nil {
		return
	}
	if _, ok := p.Data.(*model.SmartEnergyManagementPsDataType); !ok {
		return
	}
	if !b.ohpcf.IsCompatibleEntityType(p.Entity) {
		return
	}
	sem, err := client.NewSmartEnergyManagementPs(b.devEntity, p.Entity)
	if err != nil {
		return
	}
	data, err := sem.GetData()
	if err != nil {
		return
	}
	b.reportOhpcf(skiOfEntity(p.Entity), keyOfEntity(p.Entity), ohpcfAnalyze(data, time.Now()))
}

// reportOhpcf meldet nur Änderungen (eebus-go kann dieselben Daten mehrfach melden).
func (b *Bridge) reportOhpcf(ski, key string, r ohpcfReport) {
	if r.Kind == "" {
		return
	}
	sig, _ := json.Marshal(r)
	b.mu.Lock()
	same := b.lastOhpcf[ski+"|"+key] == string(sig)
	b.lastOhpcf[ski+"|"+key] = string(sig)
	b.mu.Unlock()
	if same {
		return
	}
	switch r.Kind {
	case "clear":
		b.out.Emit(entityEvent("ohpcf_clear", "ohpcf", key, ski))
	case "announce":
		b.out.Emit(ohpcfAnnounceEvent(ski, key, r.Announce))
		b.out.Emit(ohpcfStateEvent(ski, key, "announced", nil))
	case "state":
		b.out.Emit(ohpcfStateEvent(ski, key, r.State, r.StartInS))
	}
}

// ohpcf: Lauf einplanen, beenden, anhalten, fortsetzen (bridge.c CmdOhpcf).
func (b *Bridge) cmdOhpcf(c *Command) {
	key, _ := c.Str("entity")
	entry, _, ok := b.lookup(tagOHPCF, key, "")
	if !ok || key == "" {
		b.reply(c, false, "unknown compressor entity")
		return
	}
	action, _ := c.Str("action")
	cb := b.writeResultCB(c)
	var err error = errUsage
	switch action {
	case "schedule":
		s, _ := c.Num("start_in_s")
		if s < 0 {
			s = 0
		}
		_, err = b.ohpcf.SchedulePowerConsumptionProcess(entry.entity, time.Duration(int64(s))*time.Second, cb)
	case "stop":
		_, err = b.ohpcf.AbortPowerConsumptionProcess(entry.entity, cb)
	case "pause":
		_, err = b.ohpcf.PausePowerConsumptionProcess(entry.entity, cb)
	case "resume":
		_, err = b.ohpcf.ResumePowerConsumptionProcess(entry.entity, cb)
	}
	if err != nil {
		b.out.Logf("ohpcf %s %s: %v", action, key, err)
		b.reply(c, false, "ohpcf command failed")
		return
	}
	b.reply(c, true, "")
}
