package main

// E-Auto an der Wallbox, DVhub als CEM (neu gegenüber der C-Bridge; openeebus
// kennt diese Anwendungsfälle nicht):
//
//	EVCC  — Auto an/ab, Fahrzeugdaten          → ev_connected, ev_disconnected, ev_data
//	EVCEM — Strom/Leistung/Energie je Phase    → ev_measurement
//	EVSOC — Ladestand, falls das Auto ihn sendet → ev_soc
//	OPEV  — Höchststrom je Phase (Überlastschutz)       → ev_limits, Befehl ev_current_limits
//	OSCEV — Strom für Eigenverbrauch (Empfehlung)       → ev_limits, Befehl ev_current_limits
//	CEVC  — Ladebedarf und Ladeplan des Autos (nur lesen) → ev_charge_plan
//
// Die entfernte Entität ist die des Autos (unter der Ladepunkt-Entität der
// Wallbox, z. B. "d:_n:Wallbox_1/1/1"). Nur gelieferte Werte erscheinen in den
// Meldungen; fehlende werden nicht geraten.

import (
	"errors"

	eebusapi "github.com/enbility/eebus-go/api"
	ucapi "github.com/enbility/eebus-go/usecases/api"
	cemcevc "github.com/enbility/eebus-go/usecases/cem/cevc"
	cemevcc "github.com/enbility/eebus-go/usecases/cem/evcc"
	cemevcem "github.com/enbility/eebus-go/usecases/cem/evcem"
	cemevsoc "github.com/enbility/eebus-go/usecases/cem/evsoc"
	cemopev "github.com/enbility/eebus-go/usecases/cem/opev"
	cemoscev "github.com/enbility/eebus-go/usecases/cem/oscev"
	spineapi "github.com/enbility/spine-go/api"
	"github.com/enbility/spine-go/model"
)

// Schmale Lese-Schnittstellen (eebus-go erfüllt sie; Tests nutzen Attrappen).
type evccReader interface {
	ChargeState(e spineapi.EntityRemoteInterface) (ucapi.EVChargeStateType, error)
	CommunicationStandard(e spineapi.EntityRemoteInterface) (model.DeviceConfigurationKeyValueStringType, error)
	AsymmetricChargingSupport(e spineapi.EntityRemoteInterface) (bool, error)
	Identifications(e spineapi.EntityRemoteInterface) ([]ucapi.IdentificationItem, error)
	ManufacturerData(e spineapi.EntityRemoteInterface) (ucapi.ManufacturerData, error)
	ChargingPowerLimits(e spineapi.EntityRemoteInterface) (float64, float64, float64, error)
	IsInSleepMode(e spineapi.EntityRemoteInterface) (bool, error)
}

type evcemReader interface {
	PhasesConnected(e spineapi.EntityRemoteInterface) (uint, error)
	CurrentPerPhase(e spineapi.EntityRemoteInterface) ([]float64, error)
	PowerPerPhase(e spineapi.EntityRemoteInterface) ([]float64, error)
	EnergyCharged(e spineapi.EntityRemoteInterface) (float64, error)
}

type evsocReader interface {
	StateOfCharge(e spineapi.EntityRemoteInterface) (float64, error)
}

type cevcReader interface {
	ChargeStrategy(e spineapi.EntityRemoteInterface) ucapi.EVChargeStrategyType
	EnergyDemand(e spineapi.EntityRemoteInterface) (ucapi.Demand, error)
	ChargePlan(e spineapi.EntityRemoteInterface) (ucapi.ChargePlan, error)
}

func evEvent(name, ski, key string) *Obj {
	return newEvent(name).Str("ski", ski).Str("entity", key)
}

func evDataEvent(ski, key string, r evccReader, e spineapi.EntityRemoteInterface) *Obj {
	ev := evEvent("ev_data", ski, key)
	if v, err := r.ChargeState(e); err == nil {
		ev.Str("charge_state", string(v))
	}
	if v, err := r.CommunicationStandard(e); err == nil {
		ev.Str("comm_standard", string(v))
	}
	if v, err := r.AsymmetricChargingSupport(e); err == nil {
		ev.Bool("asymmetric", v)
	}
	if ids, err := r.Identifications(e); err == nil && len(ids) > 0 {
		list := make([]*Obj, 0, len(ids))
		for _, id := range ids {
			list = append(list, newObj().Str("type", string(id.ValueType)).Str("value", id.Value))
		}
		ev.Any("ids", list)
	}
	if m, err := r.ManufacturerData(e); err == nil {
		o := newObj().StrIf("brand", m.BrandName).StrIf("device", m.DeviceName).StrIf("device_code", m.DeviceCode).
			StrIf("vendor", m.VendorName).StrIf("vendor_code", m.VendorCode).StrIf("serial", m.SerialNumber).
			StrIf("software", m.SoftwareRevision).StrIf("hardware", m.HardwareRevision).StrIf("label", m.ManufacturerLabel)
		if len(o.fields) > 0 {
			ev.Any("manufacturer", o)
		}
	}
	if minW, maxW, standbyW, err := r.ChargingPowerLimits(e); err == nil {
		ev.Num("power_min_w", minW).Num("power_max_w", maxW).Num("power_standby_w", standbyW)
	}
	if v, err := r.IsInSleepMode(e); err == nil {
		ev.Bool("sleep", v)
	}
	return ev
}

func evMeasurementEvent(ski, key string, r evcemReader, e spineapi.EntityRemoteInterface) *Obj {
	ev := evEvent("ev_measurement", ski, key)
	if n, err := r.PhasesConnected(e); err == nil {
		ev.Int("phases", int64(n))
	}
	if v, err := r.CurrentPerPhase(e); err == nil && len(v) > 0 {
		ev.Any("current_a", v)
	}
	if v, err := r.PowerPerPhase(e); err == nil && len(v) > 0 {
		sum := 0.0
		for _, p := range v {
			sum += p
		}
		ev.Any("power_w", v).Num("power_total_w", sum)
	}
	if v, err := r.EnergyCharged(e); err == nil {
		ev.Num("energy_wh", v)
	}
	return ev
}

func evSocEvent(ski, key string, r evsocReader, e spineapi.EntityRemoteInterface) *Obj {
	v, err := r.StateOfCharge(e)
	if err != nil {
		return nil
	}
	return evEvent("ev_soc", ski, key).Num("soc", v)
}

func evLimitsEvent(ski, key, uc string, r evLimitsRW, e spineapi.EntityRemoteInterface) *Obj {
	ev := evEvent("ev_limits", ski, key).Str("uc", uc)
	if minA, maxA, defA, err := r.CurrentLimits(e); err == nil {
		ev.Any("min_a", minA).Any("max_a", maxA).Any("default_a", defA)
	}
	if limits, err := r.LoadControlLimits(e); err == nil {
		list := make([]*Obj, 0, len(limits))
		for _, l := range limits {
			list = append(list, newObj().Str("phase", string(l.Phase)).Bool("active", l.IsActive).
				Num("value_a", l.Value).Bool("changeable", l.IsChangeable))
		}
		ev.Any("limits", list)
	}
	return ev
}

func evPlanEvent(ski, key string, r cevcReader, e spineapi.EntityRemoteInterface) *Obj {
	ev := evEvent("ev_charge_plan", ski, key).Str("strategy", string(r.ChargeStrategy(e)))
	if d, err := r.EnergyDemand(e); err == nil {
		ev.Any("demand", newObj().Num("min_wh", d.MinDemand).Num("opt_wh", d.OptDemand).Num("max_wh", d.MaxDemand).
			Num("start_in_s", d.DurationUntilStart).Num("end_in_s", d.DurationUntilEnd))
	}
	if p, err := r.ChargePlan(e); err == nil {
		list := make([]*Obj, 0, len(p.Slots))
		for _, s := range p.Slots {
			list = append(list, newObj().Int("start_ms", s.Start.UnixMilli()).Int("end_ms", s.End.UnixMilli()).
				Num("w", s.Value).Num("min_w", s.MinValue).Num("max_w", s.MaxValue))
		}
		ev.Any("plan", list)
	}
	return ev
}

var evPhases = []model.ElectricalConnectionPhaseNameType{
	model.ElectricalConnectionPhaseNameTypeA,
	model.ElectricalConnectionPhaseNameTypeB,
	model.ElectricalConnectionPhaseNameTypeC,
}

// buildCurrentLimits: Strom je Phase in A (ein Wert gilt für alle drei Phasen;
// eebus-go überspringt Phasen, die das Auto nicht hat). release = Grenze
// aufheben: inaktiv mit dem Höchststrom der Phase.
func buildCurrentLimits(amps []float64, release bool, maxA []float64) ([]ucapi.LoadLimitsPhase, error) {
	if release {
		out := make([]ucapi.LoadLimitsPhase, 0, 3)
		for i, ph := range evPhases {
			v := 0.0
			if i < len(maxA) {
				v = maxA[i]
			}
			out = append(out, ucapi.LoadLimitsPhase{Phase: ph, IsActive: false, Value: v})
		}
		return out, nil
	}
	if len(amps) == 0 || len(amps) > 3 {
		return nil, errors.New("amps needs 1 to 3 values")
	}
	if len(amps) == 1 {
		amps = []float64{amps[0], amps[0], amps[0]}
	}
	out := make([]ucapi.LoadLimitsPhase, 0, len(amps))
	for i, a := range amps {
		if a < 0 {
			return nil, errors.New("amps must not be negative")
		}
		out = append(out, ucapi.LoadLimitsPhase{Phase: evPhases[i], IsActive: true, Value: a})
	}
	return out, nil
}

// ev_current_limits: Strom je Phase ans Auto (OPEV Höchstwert, OSCEV Empfehlung).
//
//	{"cmd":"ev_current_limits","id":1,"ski":"…"|"entity":"…","uc":"opev"|"oscev","amps":[16,16,16]|null}
func (b *Bridge) cmdEvCurrentLimits(c *Command) {
	uc := "opev"
	if s, has := c.Str("uc"); has {
		uc = s
	}
	if uc != "opev" && uc != "oscev" {
		b.reply(c, false, "uc must be opev or oscev")
		return
	}
	if !c.Has("amps") {
		b.reply(c, false, "amps missing")
		return
	}
	amps, release, ok := c.NumList("amps")
	if !ok {
		b.reply(c, false, "amps must be a list of numbers or null")
		return
	}
	key, _ := c.Str("entity")
	ski, _ := c.Str("ski")
	entry, key, found := b.lookup(remoteTag(uc), key, ski)
	rw := b.evWriters[uc]
	if !found || rw == nil {
		b.reply(c, false, "unknown ev entity")
		return
	}
	var maxA []float64
	if release {
		_, maxA, _, _ = rw.CurrentLimits(entry.entity)
	}
	limits, err := buildCurrentLimits(amps, release, maxA)
	if err != nil {
		b.reply(c, false, err.Error())
		return
	}
	if _, err := rw.WriteLoadControlLimits(entry.entity, limits, b.writeResultCB(c)); err != nil {
		b.out.Logf("ev_current_limits %s %s: %v", uc, key, err)
		b.reply(c, false, "write failed")
		return
	}
	b.startDeviceHeartbeat()
	b.reply(c, true, "")
}

func evArgs(ski string, e spineapi.EntityRemoteInterface) (string, string) {
	return normSki(ski), keyOfEntity(e)
}

func (b *Bridge) onEVCC(ski string, _ spineapi.DeviceRemoteInterface, e spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	if e == nil {
		return
	}
	ski, key := evArgs(ski, e)
	switch ev {
	case cemevcc.UseCaseSupportUpdate:
		return
	case cemevcc.EvConnected:
		b.rememberEV(tagEV, ski, key, e)
		b.out.Emit(evEvent("ev_connected", ski, key))
	case cemevcc.EvDisconnected:
		if b.forget(tagEV, key) {
			b.out.Emit(evEvent("ev_disconnected", ski, key))
		}
		return
	}
	b.out.Emit(evDataEvent(ski, key, b.evcc, e))
}

func (b *Bridge) onEVCEM(ski string, _ spineapi.DeviceRemoteInterface, e spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	if e == nil {
		return
	}
	ski, key := evArgs(ski, e)
	if ev == cemevcem.UseCaseSupportUpdate {
		b.syncRemotes(tagEVCEM, b.evcem)
		return
	}
	b.out.Emit(evMeasurementEvent(ski, key, b.evcem, e))
}

func (b *Bridge) onEVSOC(ski string, _ spineapi.DeviceRemoteInterface, e spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	if e == nil {
		return
	}
	ski, key := evArgs(ski, e)
	if ev == cemevsoc.UseCaseSupportUpdate {
		b.syncRemotes(tagEVSOC, b.evsoc)
		return
	}
	b.out.Emit(evSocEvent(ski, key, b.evsoc, e))
}

func (b *Bridge) onOPEV(ski string, _ spineapi.DeviceRemoteInterface, e spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	if e == nil {
		return
	}
	ski, key := evArgs(ski, e)
	if ev == cemopev.UseCaseSupportUpdate {
		b.syncRemotes(tagOPEV, b.opev)
		return
	}
	b.out.Emit(evLimitsEvent(ski, key, "opev", b.opev, e))
}

func (b *Bridge) onOSCEV(ski string, _ spineapi.DeviceRemoteInterface, e spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	if e == nil {
		return
	}
	ski, key := evArgs(ski, e)
	if ev == cemoscev.UseCaseSupportUpdate {
		b.syncRemotes(tagOSCEV, b.oscev)
		return
	}
	b.out.Emit(evLimitsEvent(ski, key, "oscev", b.oscev, e))
}

func (b *Bridge) onCEVC(ski string, _ spineapi.DeviceRemoteInterface, e spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	if e == nil {
		return
	}
	ski, key := evArgs(ski, e)
	switch ev {
	case cemcevc.UseCaseSupportUpdate:
		b.syncRemotes(tagCEVC, b.cevc)
		return
	case cemcevc.DataUpdateEnergyDemand, cemcevc.DataUpdateChargePlan, cemcevc.DataUpdateChargePlanConstraints,
		cemcevc.DataUpdateTimeSlotConstraints:
		b.out.Emit(evPlanEvent(ski, key, b.cevc, e))
	}
}
