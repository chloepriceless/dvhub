package main

// Geräteseite: DVhub als Energy Guard (EG LPC/LPP) und Monitoring Appliance
// (MA MPC) gegenüber Wärmepumpen, Wallboxen und Wechselrichtern; dazu der
// eigene Netzanschlusspunkt (GCP MGCP).

import (
	"time"

	eebusapi "github.com/enbility/eebus-go/api"
	"github.com/enbility/eebus-go/features/client"
	ucapi "github.com/enbility/eebus-go/usecases/api"
	eglpc "github.com/enbility/eebus-go/usecases/eg/lpc"
	eglpp "github.com/enbility/eebus-go/usecases/eg/lpp"
	mampc "github.com/enbility/eebus-go/usecases/ma/mpc"
	spineapi "github.com/enbility/spine-go/api"
	"github.com/enbility/spine-go/model"
)

func (b *Bridge) onEgLPC(ski string, _ spineapi.DeviceRemoteInterface, e spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	key, ski := keyOfEntity(e), normSki(ski)
	switch ev {
	case eglpc.UseCaseSupportUpdate:
		b.syncRemotes(tagEgLPC, b.egLPC)
	case eglpc.DataUpdateLimit:
		if l, err := b.egLPC.ConsumptionLimit(e); err == nil {
			b.out.Emit(entityEvent("device_limit", "lpc", key, ski).Num("w", l.Value).
				Int("duration_s", secondsOf(l.Duration)).Bool("active", l.IsActive))
		}
	case eglpc.DataUpdateFailsafeConsumptionActivePowerLimit:
		if v, err := b.egLPC.FailsafeConsumptionActivePowerLimit(e); err == nil {
			b.out.Emit(entityEvent("device_failsafe_limit", "lpc", key, ski).Num("w", v))
		}
	case eglpc.DataUpdateFailsafeDurationMinimum:
		if d, err := b.egLPC.FailsafeDurationMinimum(e); err == nil {
			b.out.Emit(entityEvent("device_failsafe_duration", "lpc", key, ski).Int("duration_s", secondsOf(d)))
		}
	case eglpc.DataUpdatePowerConsumptionNominalMax:
		if v, err := b.egLPC.ConsumptionNominalMax(e); err == nil {
			b.out.Emit(entityEvent("device_nominal_max", "lpc", key, ski).Num("w", v))
		}
	}
}

func (b *Bridge) onEgLPP(ski string, _ spineapi.DeviceRemoteInterface, e spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	key, ski := keyOfEntity(e), normSki(ski)
	switch ev {
	case eglpp.UseCaseSupportUpdate:
		b.syncRemotes(tagEgLPP, b.egLPP)
	case eglpp.DataUpdateLimit:
		if l, err := b.egLPP.ProductionLimit(e); err == nil {
			b.out.Emit(entityEvent("device_limit", "lpp", key, ski).Num("w", l.Value).
				Int("duration_s", secondsOf(l.Duration)).Bool("active", l.IsActive))
		}
	case eglpp.DataUpdateFailsafeProductionActivePowerLimit:
		if v, err := b.egLPP.FailsafeProductionActivePowerLimit(e); err == nil {
			b.out.Emit(entityEvent("device_failsafe_limit", "lpp", key, ski).Num("w", v))
		}
	case eglpp.DataUpdateFailsafeDurationMinimum:
		if d, err := b.egLPP.FailsafeDurationMinimum(e); err == nil {
			b.out.Emit(entityEvent("device_failsafe_duration", "lpp", key, ski).Int("duration_s", secondsOf(d)))
		}
	case eglpp.DataUpdatePowerProductionNominalMax:
		if v, err := b.egLPP.ProductionNominalMax(e); err == nil {
			b.out.Emit(entityEvent("device_nominal_max", "lpp", key, ski).Num("w", v))
		}
	}
}

func (b *Bridge) emitMeasurement(key, ski, name string, v float64) {
	b.out.Emit(entityEvent("device_measurement", "mpc", key, ski).Str("name", name).Num("value", v))
}

func (b *Bridge) emitPhases(key, ski, kind string, vals []float64) {
	for i, v := range vals {
		if i >= 3 {
			break
		}
		b.emitMeasurement(key, ski, mpcName(kind, i+1), v)
	}
}

func (b *Bridge) onMPC(ski string, _ spineapi.DeviceRemoteInterface, e spineapi.EntityRemoteInterface, ev eebusapi.EventType) {
	key, ski := keyOfEntity(e), normSki(ski)
	m := b.maMPC
	switch ev {
	case mampc.UseCaseSupportUpdate:
		b.syncRemotes(tagMPC, m)
	case mampc.DataUpdatePower:
		if v, err := m.Power(e); err == nil {
			b.emitMeasurement(key, ski, mpcName("power", 0), v)
		}
	case mampc.DataUpdatePowerPerPhase:
		if v, err := m.PowerPerPhase(e); err == nil {
			b.emitPhases(key, ski, "power", v)
		}
	case mampc.DataUpdateEnergyConsumed:
		if v, err := m.EnergyConsumed(e); err == nil {
			b.emitMeasurement(key, ski, mpcName("energy_consumed", 0), v)
		}
	case mampc.DataUpdateEnergyProduced:
		if v, err := m.EnergyProduced(e); err == nil {
			b.emitMeasurement(key, ski, mpcName("energy_produced", 0), v)
		}
	case mampc.DataUpdateCurrentsPerPhase:
		if v, err := m.CurrentPerPhase(e); err == nil {
			b.emitPhases(key, ski, "current", v)
		}
	case mampc.DataUpdateVoltagePerPhase:
		if v, err := m.VoltagePerPhase(e); err == nil {
			b.emitPhases(key, ski, "voltage", v)
		}
	case mampc.DataUpdateFrequency:
		if v, err := m.Frequency(e); err == nil {
			b.emitMeasurement(key, ski, mpcName("frequency", 0), v)
		}
	}
}

func deviceTag(c *Command) (string, remoteTag) {
	if uc, _ := c.Str("uc"); uc == "lpp" {
		return "lpp", tagEgLPP
	}
	return "lpc", tagEgLPC
}

// device_limit: Grenze an ein Gerät schreiben (bridge.c CmdDeviceLimit).
func (b *Bridge) cmdDeviceLimit(c *Command) {
	uc, tag := deviceTag(c)
	key, _ := c.Str("entity")
	entry, _, ok := b.lookup(tag, key, "")
	if !ok || key == "" {
		b.reply(c, false, "unknown device entity")
		return
	}
	w, hasW := c.Num("w")
	dur, _ := c.Num("duration_s")
	if dur < 0 {
		dur = 0
	}
	limit := ucapi.LoadLimit{
		Value:          0,
		IsActive:       c.Bool("active", hasW),
		Duration:       time.Duration(int64(dur)) * time.Second,
		DeleteDuration: dur <= 0,
	}
	if hasW {
		limit.Value = w
	}
	var err error
	if uc == "lpp" {
		_, err = b.egLPP.WriteProductionLimit(entry.entity, limit, b.writeResultCB(c))
	} else {
		_, err = b.egLPC.WriteConsumptionLimit(entry.entity, limit, b.writeResultCB(c))
	}
	if err != nil {
		b.out.Logf("device_limit %s %s: %v", uc, key, err)
		b.reply(c, false, "write failed")
		return
	}
	b.startDeviceHeartbeat()
	b.reply(c, true, "")
}

// attachResult meldet das Ergebnis eines Schreibvorgangs ohne eigenen Rückruf in
// eebus-go (Failsafe-Werte) über die Antwort auf den Nachrichtenzähler.
func (b *Bridge) attachResult(c *Command, remote spineapi.EntityRemoteInterface, mc *model.MsgCounterType) {
	if mc == nil || b.devEntity == nil || remote == nil {
		return
	}
	dc, err := client.NewDeviceConfiguration(b.devEntity, remote)
	if err != nil {
		return
	}
	cb := b.writeResultCB(c)
	_ = dc.AddResponseCallback(*mc, func(msg spineapi.ResponseMessage) {
		if r, ok := msg.Data.(*model.ResultDataType); ok && r != nil {
			cb(*r, msg.MsgCounterReference)
		}
	})
}

// device_failsafe: Failsafe-Grenze und -Dauer eines Geräts (bridge.c CmdDeviceFailsafe).
func (b *Bridge) cmdDeviceFailsafe(c *Command) {
	uc, tag := deviceTag(c)
	key, _ := c.Str("entity")
	entry, _, ok := b.lookup(tag, key, "")
	if !ok || key == "" {
		b.reply(c, false, "unknown device entity")
		return
	}
	var err error
	var mc *model.MsgCounterType
	if v, has := c.Num("w"); has {
		if uc == "lpp" {
			mc, err = b.egLPP.WriteFailsafeProductionActivePowerLimit(entry.entity, v)
		} else {
			mc, err = b.egLPC.WriteFailsafeConsumptionActivePowerLimit(entry.entity, v)
		}
		if err == nil {
			b.attachResult(c, entry.entity, mc)
		}
	}
	if v, has := c.Num("duration_s"); err == nil && has {
		d := time.Duration(int64(v)) * time.Second
		if uc == "lpp" {
			mc, err = b.egLPP.WriteFailsafeDurationMinimum(entry.entity, d)
		} else {
			mc, err = b.egLPC.WriteFailsafeDurationMinimum(entry.entity, d)
		}
		if err == nil {
			b.attachResult(c, entry.entity, mc)
		}
	}
	if err != nil {
		b.out.Logf("device_failsafe %s %s: %v", uc, key, err)
		b.reply(c, false, "write failed")
		return
	}
	b.reply(c, true, "")
}

// gcp: Leistung und Zählerstände am Netzanschlusspunkt (bridge.c CmdGcp).
// Antwort nur, wenn der Befehl eine id trägt — DVhub schreibt den 5-s-Takt ohne.
func (b *Bridge) cmdGcp(c *Command) {
	m := b.mgcp
	var updates []ucapi.UpdateData
	if v, ok := c.Num("power_w"); ok {
		updates = append(updates, m.UpdateDataPowerTotal(v, nil, nil))
	}
	if v, ok := c.Num("energy_feed_in_wh"); ok {
		updates = append(updates, m.UpdateDataEnergyFeedIn(v, nil, nil, nil, nil))
	}
	if v, ok := c.Num("energy_consumed_wh"); ok {
		updates = append(updates, m.UpdateDataEnergyConsumed(v, nil, nil, nil, nil))
	}
	var err error
	if len(updates) > 0 {
		err = m.Update(updates...)
	}
	if c.Has("id") {
		if err != nil {
			b.reply(c, false, "gcp update failed")
		} else {
			b.reply(c, true, "")
		}
	}
}
