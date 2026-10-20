package main

// Netzseite: DVhub als Controllable System gegenüber der §14a-Steuerbox
// (CS LPC = Bezugsgrenze, CS LPP = Einspeisegrenze).
//
// Schreibvorgänge der Steuerbox gibt die Bridge sofort selbst frei oder lehnt
// sie ab (bridge.c Approver…) und meldet sie als grid_write; DVhub entscheidet,
// was es mit der Grenze macht. Nur gekoppelte Gegenstellen erreichen diesen Punkt.

import (
	"sort"
	"strconv"
	"time"

	eebusapi "github.com/enbility/eebus-go/api"
	ucapi "github.com/enbility/eebus-go/usecases/api"
	cslpc "github.com/enbility/eebus-go/usecases/cs/lpc"
	cslpp "github.com/enbility/eebus-go/usecases/cs/lpp"
	spineapi "github.com/enbility/spine-go/api"
	"github.com/enbility/spine-go/model"
)

// gridSide fasst CS LPC und CS LPP zusammen (eebus-go hat je eigene Namen).
type gridSide interface {
	Name() string
	PendingLimits() map[model.MsgCounterType]ucapi.LoadLimit
	ApproveLimit(msg model.MsgCounterType, approve bool, reason string)
	PendingConfigs() map[model.MsgCounterType][]ucapi.PendingDeviceConfiguration
	ApproveConfig(msg model.MsgCounterType, approve bool, reason string)
	Limit() (ucapi.LoadLimit, error)
	SetLimit(l ucapi.LoadLimit) error
	FailsafeLimit() (float64, bool, error)
	SetFailsafeLimit(v float64, changeable bool) error
	FailsafeDuration() (time.Duration, bool, error)
	SetFailsafeDuration(d time.Duration, changeable bool) error
	SetNominalMax(v float64) error
	HeartbeatOK() bool
	FailsafeKey() model.DeviceConfigurationKeyNameType
}

type lpcSide struct{ uc ucapi.CsLPCInterface }

func (s lpcSide) Name() string { return "lpc" }
func (s lpcSide) PendingLimits() map[model.MsgCounterType]ucapi.LoadLimit {
	return s.uc.PendingConsumptionLimits()
}
func (s lpcSide) ApproveLimit(m model.MsgCounterType, a bool, r string) {
	s.uc.ApproveOrDenyConsumptionLimit(m, a, r)
}
func (s lpcSide) PendingConfigs() map[model.MsgCounterType][]ucapi.PendingDeviceConfiguration {
	return s.uc.PendingDeviceConfigurations()
}
func (s lpcSide) ApproveConfig(m model.MsgCounterType, a bool, r string) {
	s.uc.ApproveOrDenyDeviceConfiguration(m, a, r)
}
func (s lpcSide) Limit() (ucapi.LoadLimit, error)  { return s.uc.ConsumptionLimit() }
func (s lpcSide) SetLimit(l ucapi.LoadLimit) error { return s.uc.SetConsumptionLimit(l) }
func (s lpcSide) FailsafeLimit() (float64, bool, error) {
	return s.uc.FailsafeConsumptionActivePowerLimit()
}
func (s lpcSide) SetFailsafeLimit(v float64, c bool) error {
	return s.uc.SetFailsafeConsumptionActivePowerLimit(v, c)
}
func (s lpcSide) FailsafeDuration() (time.Duration, bool, error) {
	return s.uc.FailsafeDurationMinimum()
}
func (s lpcSide) SetFailsafeDuration(d time.Duration, c bool) error {
	return s.uc.SetFailsafeDurationMinimum(d, c)
}
func (s lpcSide) SetNominalMax(v float64) error { return s.uc.SetConsumptionNominalMax(v) }
func (s lpcSide) HeartbeatOK() bool             { return s.uc.IsHeartbeatWithinDuration() }
func (s lpcSide) FailsafeKey() model.DeviceConfigurationKeyNameType {
	return model.DeviceConfigurationKeyNameTypeFailsafeConsumptionActivePowerLimit
}

type lppSide struct{ uc ucapi.CsLPPInterface }

func (s lppSide) Name() string { return "lpp" }
func (s lppSide) PendingLimits() map[model.MsgCounterType]ucapi.LoadLimit {
	return s.uc.PendingProductionLimits()
}
func (s lppSide) ApproveLimit(m model.MsgCounterType, a bool, r string) {
	s.uc.ApproveOrDenyProductionLimit(m, a, r)
}
func (s lppSide) PendingConfigs() map[model.MsgCounterType][]ucapi.PendingDeviceConfiguration {
	return s.uc.PendingDeviceConfigurations()
}
func (s lppSide) ApproveConfig(m model.MsgCounterType, a bool, r string) {
	s.uc.ApproveOrDenyDeviceConfiguration(m, a, r)
}
func (s lppSide) Limit() (ucapi.LoadLimit, error)  { return s.uc.ProductionLimit() }
func (s lppSide) SetLimit(l ucapi.LoadLimit) error { return s.uc.SetProductionLimit(l) }
func (s lppSide) FailsafeLimit() (float64, bool, error) {
	return s.uc.FailsafeProductionActivePowerLimit()
}
func (s lppSide) SetFailsafeLimit(v float64, c bool) error {
	return s.uc.SetFailsafeProductionActivePowerLimit(v, c)
}
func (s lppSide) FailsafeDuration() (time.Duration, bool, error) {
	return s.uc.FailsafeDurationMinimum()
}
func (s lppSide) SetFailsafeDuration(d time.Duration, c bool) error {
	return s.uc.SetFailsafeDurationMinimum(d, c)
}
func (s lppSide) SetNominalMax(v float64) error { return s.uc.SetProductionNominalMax(v) }
func (s lppSide) HeartbeatOK() bool             { return s.uc.IsHeartbeatWithinDuration() }
func (s lppSide) FailsafeKey() model.DeviceConfigurationKeyNameType {
	return model.DeviceConfigurationKeyNameTypeFailsafeProductionActivePowerLimit
}

type gridEventKind int

const (
	gridLimitApproval gridEventKind = iota
	gridConfigApproval
	gridLimitUpdate
	gridFailsafeLimitUpdate
	gridFailsafeDurationUpdate
	gridHeartbeat
	gridUseCaseUpdate
)

func (b *Bridge) side(uc string) gridSide {
	if uc == "lpc" {
		if b.csLPC == nil {
			return nil
		}
		return lpcSide{b.csLPC}
	}
	if b.csLPP == nil {
		return nil
	}
	return lppSide{b.csLPP}
}

func (b *Bridge) onCsLPC(ski string, _ spineapi.DeviceRemoteInterface, _ spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	kinds := map[eebusapi.EventType]gridEventKind{
		cslpc.LimitWriteApprovalRequired:                    gridLimitApproval,
		cslpc.ConfigurationWriteApprovalRequired:            gridConfigApproval,
		cslpc.DataUpdateLimit:                               gridLimitUpdate,
		cslpc.DataUpdateFailsafeConsumptionActivePowerLimit: gridFailsafeLimitUpdate,
		cslpc.DataUpdateFailsafeDurationMinimum:             gridFailsafeDurationUpdate,
		cslpc.DataUpdateHeartbeat:                           gridHeartbeat,
		cslpc.UseCaseSupportUpdate:                          gridUseCaseUpdate,
	}
	if k, ok := kinds[ev]; ok {
		if k == gridUseCaseUpdate {
			b.syncRemotes(tagCsLPC, b.csLPC)
			return
		}
		b.handleGridEvent(lpcSide{b.csLPC}, normSki(ski), k)
	}
}

func (b *Bridge) onCsLPP(ski string, _ spineapi.DeviceRemoteInterface, _ spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	kinds := map[eebusapi.EventType]gridEventKind{
		cslpp.LimitWriteApprovalRequired:                   gridLimitApproval,
		cslpp.ConfigurationWriteApprovalRequired:           gridConfigApproval,
		cslpp.DataUpdateLimit:                              gridLimitUpdate,
		cslpp.DataUpdateFailsafeProductionActivePowerLimit: gridFailsafeLimitUpdate,
		cslpp.DataUpdateFailsafeDurationMinimum:            gridFailsafeDurationUpdate,
		cslpp.DataUpdateHeartbeat:                          gridHeartbeat,
		cslpp.UseCaseSupportUpdate:                         gridUseCaseUpdate,
	}
	if k, ok := kinds[ev]; ok {
		if k == gridUseCaseUpdate {
			b.syncRemotes(tagCsLPP, b.csLPP)
			return
		}
		b.handleGridEvent(lppSide{b.csLPP}, normSki(ski), k)
	}
}

func (b *Bridge) handleGridEvent(s gridSide, ski string, kind gridEventKind) {
	uc := s.Name()
	switch kind {
	case gridLimitApproval:
		b.approveLimits(s, ski)
	case gridConfigApproval:
		b.approveConfigs(s, ski)
	case gridLimitUpdate:
		if l, err := s.Limit(); err == nil {
			b.out.Emit(newEvent("grid_limit").Str("uc", uc).Num("w", l.Value).
				Int("duration_s", secondsOf(l.Duration)).Bool("active", l.IsActive))
		}
	case gridFailsafeLimitUpdate:
		if v, _, err := s.FailsafeLimit(); err == nil {
			b.out.Emit(newEvent("grid_failsafe_limit").Str("uc", uc).Num("w", v))
		}
	case gridFailsafeDurationUpdate:
		if d, _, err := s.FailsafeDuration(); err == nil {
			b.out.Emit(newEvent("grid_failsafe_duration").Str("uc", uc).Int("duration_s", secondsOf(d)))
		}
	case gridHeartbeat:
		// Herzschläge kommen alle paar Sekunden; DVhub braucht nur den Zustand
		// (Tick) und ab und zu ein Lebenszeichen. eebus-go reicht den Zähler der
		// Steuerbox nicht durch — gezählt werden die empfangenen Herzschläge.
		b.mu.Lock()
		b.hbCount[uc]++
		n := b.hbCount[uc]
		b.mu.Unlock()
		if n%12 == 0 {
			b.out.Emit(newEvent("grid_heartbeat").Str("uc", uc).Int("counter", int64(n)))
		}
	}
}

func sortedMsgs[T any](m map[model.MsgCounterType]T) []model.MsgCounterType {
	keys := make([]model.MsgCounterType, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	return keys
}

// claim markiert einen Schreibvorgang als in Bearbeitung (eebus-go meldet
// mehrere offene auf einmal, ein Ereignis kann mehrfach kommen).
func (b *Bridge) claim(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.handled[key] {
		return false
	}
	b.handled[key] = true
	return true
}

func (b *Bridge) release(key string) {
	b.mu.Lock()
	delete(b.handled, key)
	b.mu.Unlock()
}

func (b *Bridge) approveLimits(s gridSide, ski string) {
	uc := s.Name()
	pending := s.PendingLimits()
	for _, msg := range sortedMsgs(pending) {
		key := uc + "/limit/" + strconv.FormatUint(uint64(msg), 10)
		if !b.claim(key) {
			continue
		}
		l := pending[msg]
		dur := secondsOf(l.Duration)
		valid := limitValid(uc, l.Value, dur)
		b.out.Emit(newEvent("grid_write").Str("uc", uc).Str("kind", "limit").Str("ski", ski).
			Num("w", l.Value).Int("duration_s", dur).Bool("active", l.IsActive).Bool("approved", valid))
		reason := ""
		if !valid {
			reason = "invalid limit or duration"
		}
		// Freigabe außerhalb des Rückrufs: eebus-go hält dabei eigene Sperren.
		go func(msg model.MsgCounterType) {
			s.ApproveLimit(msg, valid, reason)
			b.release(key)
		}(msg)
	}
}

func (b *Bridge) approveConfigs(s gridSide, ski string) {
	uc := s.Name()
	pending := s.PendingConfigs()
	for _, msg := range sortedMsgs(pending) {
		key := uc + "/config/" + strconv.FormatUint(uint64(msg), 10)
		if !b.claim(key) {
			continue
		}
		items := pending[msg]
		valid := true
		reason := ""
		var parts []*Obj
		for _, item := range items {
			switch item.KeyName {
			case s.FailsafeKey():
				w, ok := 0.0, item.Value != nil && item.Value.ScaledNumber != nil
				if ok {
					w = item.Value.ScaledNumber.GetValue()
				}
				if !ok || !failsafeValueValid(w) {
					valid, reason = false, "invalid failsafe value"
				}
				parts = append(parts, newEvent("grid_write").Str("uc", uc).Str("kind", "failsafe_limit").Str("ski", ski).Num("w", w))
			case model.DeviceConfigurationKeyNameTypeFailsafeDurationMinimum:
				var secs int64
				ok := item.Value != nil && item.Value.Duration != nil
				if ok {
					d, err := item.Value.Duration.GetTimeDuration()
					ok = err == nil
					secs = secondsOf(d)
				}
				if !ok || !failsafeDurationValid(secs) {
					valid, reason = false, "invalid failsafe duration"
				}
				parts = append(parts, newEvent("grid_write").Str("uc", uc).Str("kind", "failsafe_duration").Str("ski", ski).Int("duration_s", secs))
			}
		}
		// Ein Schreibvorgang wird als Ganzes angenommen oder abgelehnt.
		for _, p := range parts {
			b.out.Emit(p.Bool("approved", valid))
		}
		go func(msg model.MsgCounterType) {
			s.ApproveConfig(msg, valid, reason)
			b.release(key)
		}(msg)
	}
}

// grid_config: Nennleistung und Failsafe-Vorgaben der Netzseite (bridge.c CmdGridConfig).
func (b *Bridge) cmdGridConfig(c *Command) {
	uc, _ := c.Str("uc")
	if uc != "lpc" && uc != "lpp" {
		b.reply(c, false, "uc must be lpc or lpp")
		return
	}
	s := b.side(uc)
	var err error
	if v, ok := c.Num("nominal_max_w"); ok {
		err = s.SetNominalMax(v)
	}
	if v, ok := c.Num("failsafe_w"); err == nil && ok {
		err = s.SetFailsafeLimit(v, true)
	}
	if v, ok := c.Num("failsafe_duration_s"); err == nil && ok {
		err = s.SetFailsafeDuration(time.Duration(int64(v))*time.Second, true)
	}
	if err != nil {
		b.out.Logf("grid_config %s: %v", uc, err)
		b.reply(c, false, "setting grid values failed")
		return
	}
	b.reply(c, true, "")
}

// grid_limit_state: DVhub meldet die Grenze, die es tatsächlich anwendet
// (z. B. nach Ablauf) — LPC Szenario 1 "Grenze lesen" bleibt stimmig.
func (b *Bridge) cmdGridLimitState(c *Command) {
	uc, has := c.Str("uc")
	if !has {
		b.reply(c, false, "uc missing")
		return
	}
	if uc != "lpc" {
		uc = "lpp" // wie bridge.c: alles außer "lpc" ist LPP
	}
	w, ok := c.Num("w")
	if !ok {
		b.reply(c, false, "w missing")
		return
	}
	err := b.side(uc).SetLimit(ucapi.LoadLimit{Value: w, IsActive: c.Bool("active", false), IsChangeable: true})
	if err != nil {
		b.reply(c, false, "setting limit state failed")
		return
	}
	b.reply(c, true, "")
}

func (b *Bridge) cmdStatus(c *Command) {
	ev := newEvent("status").StrIf("ski", b.localSKI())
	for _, uc := range []string{"lpc", "lpp"} {
		s := b.side(uc)
		if s == nil {
			continue
		}
		if l, err := s.Limit(); err == nil {
			ev.Any(uc, newObj().Num("w", l.Value).Bool("active", l.IsActive).Bool("heartbeat_ok", s.HeartbeatOK()))
		}
	}
	if v, ok := c.Num("id"); ok {
		ev.Num("id", v)
	}
	b.out.Emit(ev)
}
