package main

// Abbildung der eebus-go-Ereignisse auf DVhub-Meldungen mit kleinen Attrappen
// (keine Geräte): Freigabe der Steuerbox-Vorgaben, E-Auto-Meldungen,
// Stromgrenzen fürs Auto und Verdichterläufe (OHPCF).

import (
	"bytes"
	"errors"
	"sync"
	"testing"
	"time"

	ucapi "github.com/enbility/eebus-go/usecases/api"
	spineapi "github.com/enbility/spine-go/api"
	"github.com/enbility/spine-go/model"
	"github.com/enbility/spine-go/util"
)

var errNA = errors.New("not available")

// --- Netzseite ------------------------------------------------------------------

type fakeGrid struct {
	name     string
	limits   map[model.MsgCounterType]ucapi.LoadLimit
	configs  map[model.MsgCounterType][]ucapi.PendingDeviceConfiguration
	mu       sync.Mutex
	approved map[model.MsgCounterType]bool
	limit    ucapi.LoadLimit
	fsW      float64
	fsD      time.Duration
}

func (f *fakeGrid) Name() string { return f.name }
func (f *fakeGrid) PendingLimits() map[model.MsgCounterType]ucapi.LoadLimit {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[model.MsgCounterType]ucapi.LoadLimit{}
	for k, v := range f.limits {
		out[k] = v
	}
	return out
}
func (f *fakeGrid) ApproveLimit(msg model.MsgCounterType, approve bool, _ string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.approved[msg] = approve
	delete(f.limits, msg)
}
func (f *fakeGrid) PendingConfigs() map[model.MsgCounterType][]ucapi.PendingDeviceConfiguration {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[model.MsgCounterType][]ucapi.PendingDeviceConfiguration{}
	for k, v := range f.configs {
		out[k] = v
	}
	return out
}
func (f *fakeGrid) ApproveConfig(msg model.MsgCounterType, approve bool, _ string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.approved[msg] = approve
	delete(f.configs, msg)
}
func (f *fakeGrid) Limit() (ucapi.LoadLimit, error)                { return f.limit, nil }
func (f *fakeGrid) SetLimit(l ucapi.LoadLimit) error               { f.limit = l; return nil }
func (f *fakeGrid) FailsafeLimit() (float64, bool, error)          { return f.fsW, true, nil }
func (f *fakeGrid) SetFailsafeLimit(v float64, _ bool) error       { f.fsW = v; return nil }
func (f *fakeGrid) FailsafeDuration() (time.Duration, bool, error) { return f.fsD, true, nil }
func (f *fakeGrid) SetFailsafeDuration(d time.Duration, _ bool) error {
	f.fsD = d
	return nil
}
func (f *fakeGrid) SetNominalMax(float64) error { return nil }
func (f *fakeGrid) HeartbeatOK() bool           { return false }
func (f *fakeGrid) FailsafeKey() model.DeviceConfigurationKeyNameType {
	if f.name == "lpp" {
		return model.DeviceConfigurationKeyNameTypeFailsafeProductionActivePowerLimit
	}
	return model.DeviceConfigurationKeyNameTypeFailsafeConsumptionActivePowerLimit
}

func (f *fakeGrid) waitApproved(t *testing.T, msg model.MsgCounterType) bool {
	t.Helper()
	for i := 0; i < 100; i++ {
		f.mu.Lock()
		v, ok := f.approved[msg]
		f.mu.Unlock()
		if ok {
			return v
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Schreibvorgang %d weder angenommen noch abgelehnt", msg)
	return false
}

func newBareBridge() (*Bridge, *syncBuffer) {
	out := &syncBuffer{}
	return NewBridge(NewOut(out, &bytes.Buffer{}), defaultOptions()), out
}

const skiBox = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestSteuerboxGrenzeWirdGeprueftGemeldetUndFreigegeben(t *testing.T) {
	b, out := newBareBridge()
	lpc := &fakeGrid{name: "lpc", approved: map[model.MsgCounterType]bool{}, limits: map[model.MsgCounterType]ucapi.LoadLimit{
		5: {Value: 4200, Duration: time.Hour, IsActive: true},
	}}
	b.handleGridEvent(lpc, skiBox, gridLimitApproval)
	if !lpc.waitApproved(t, 5) {
		t.Fatal("gültige LPC-Grenze muss angenommen werden")
	}
	ev := out.waitFor(t, time.Second, "grid_write", func(m map[string]any) bool { return m["ev"] == "grid_write" })
	want := map[string]any{"uc": "lpc", "kind": "limit", "ski": skiBox, "w": float64(4200), "duration_s": float64(3600), "active": true, "approved": true}
	for k, v := range want {
		if ev[k] != v {
			t.Fatalf("grid_write %s=%v erwartet %v (%v)", k, ev[k], v, ev)
		}
	}
	// Dieselbe Meldung nicht doppelt bearbeiten, wenn eebus-go das Ereignis wiederholt.
	b.handleGridEvent(lpc, skiBox, gridLimitApproval)
	n := 0
	for _, e := range out.events(t) {
		if e["ev"] == "grid_write" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("grid_write %d-mal", n)
	}

	// LPP: Einspeisegrenze positiv wird abgelehnt, negativ angenommen [LPP-TS-001].
	lpp := &fakeGrid{name: "lpp", approved: map[model.MsgCounterType]bool{}, limits: map[model.MsgCounterType]ucapi.LoadLimit{
		7: {Value: 5000, IsActive: true},
		8: {Value: -5000, IsActive: true},
	}}
	b.handleGridEvent(lpp, skiBox, gridLimitApproval)
	if lpp.waitApproved(t, 7) {
		t.Fatal("positive LPP-Grenze muss abgelehnt werden")
	}
	if !lpp.waitApproved(t, 8) {
		t.Fatal("negative LPP-Grenze muss angenommen werden")
	}
}

func TestSteuerboxFailsafeWerte(t *testing.T) {
	b, out := newBareBridge()
	lpc := &fakeGrid{name: "lpc", approved: map[model.MsgCounterType]bool{}, configs: map[model.MsgCounterType][]ucapi.PendingDeviceConfiguration{
		11: {{KeyName: model.DeviceConfigurationKeyNameTypeFailsafeConsumptionActivePowerLimit,
			Value: &model.DeviceConfigurationKeyValueValueType{ScaledNumber: model.NewScaledNumberType(3800)}}},
		12: {{KeyName: model.DeviceConfigurationKeyNameTypeFailsafeDurationMinimum,
			Value: &model.DeviceConfigurationKeyValueValueType{Duration: model.NewDurationType(time.Hour)}}},
	}}
	b.handleGridEvent(lpc, skiBox, gridConfigApproval)
	if !lpc.waitApproved(t, 11) {
		t.Fatal("Failsafe 3800 W gültig")
	}
	if lpc.waitApproved(t, 12) {
		t.Fatal("Failsafe-Dauer 1 h ist ungültig (2–24 h)")
	}
	fl := out.waitFor(t, time.Second, "failsafe_limit", func(m map[string]any) bool { return m["kind"] == "failsafe_limit" })
	if fl["w"] != float64(3800) || fl["approved"] != true || fl["uc"] != "lpc" || fl["ski"] != skiBox {
		t.Fatalf("failsafe_limit %v", fl)
	}
	fd := out.waitFor(t, time.Second, "failsafe_duration", func(m map[string]any) bool { return m["kind"] == "failsafe_duration" })
	if fd["duration_s"] != float64(3600) || fd["approved"] != false {
		t.Fatalf("failsafe_duration %v", fd)
	}
}

func TestSteuerboxDatenmeldungen(t *testing.T) {
	b, out := newBareBridge()
	lpp := &fakeGrid{name: "lpp", approved: map[model.MsgCounterType]bool{}, limit: ucapi.LoadLimit{Value: -4200, Duration: 15 * time.Minute, IsActive: true}, fsW: 6000, fsD: 2 * time.Hour}
	b.handleGridEvent(lpp, skiBox, gridLimitUpdate)
	b.handleGridEvent(lpp, skiBox, gridFailsafeLimitUpdate)
	b.handleGridEvent(lpp, skiBox, gridFailsafeDurationUpdate)
	for i := 0; i < 24; i++ {
		b.handleGridEvent(lpp, skiBox, gridHeartbeat)
	}
	got := map[string]map[string]any{}
	hb := 0
	for _, e := range out.events(t) {
		got[e["ev"].(string)] = e
		if e["ev"] == "grid_heartbeat" {
			hb++
		}
	}
	if l := got["grid_limit"]; l["uc"] != "lpp" || l["w"] != float64(-4200) || l["duration_s"] != float64(900) || l["active"] != true {
		t.Fatalf("grid_limit %v", l)
	}
	if l := got["grid_failsafe_limit"]; l["w"] != float64(6000) {
		t.Fatalf("grid_failsafe_limit %v", l)
	}
	if l := got["grid_failsafe_duration"]; l["duration_s"] != float64(7200) {
		t.Fatalf("grid_failsafe_duration %v", l)
	}
	if hb != 2 {
		t.Fatalf("grid_heartbeat nur jeder 12. (wie bridge.c): %d", hb)
	}
}

// --- E-Auto ---------------------------------------------------------------------

type fakeEVCC struct{}

func (fakeEVCC) ChargeState(spineapi.EntityRemoteInterface) (ucapi.EVChargeStateType, error) {
	return ucapi.EVChargeStateTypeActive, nil
}
func (fakeEVCC) CommunicationStandard(spineapi.EntityRemoteInterface) (model.DeviceConfigurationKeyValueStringType, error) {
	return model.DeviceConfigurationKeyValueStringTypeISO151182ED2, nil
}
func (fakeEVCC) AsymmetricChargingSupport(spineapi.EntityRemoteInterface) (bool, error) {
	return false, errNA
}
func (fakeEVCC) Identifications(spineapi.EntityRemoteInterface) ([]ucapi.IdentificationItem, error) {
	return []ucapi.IdentificationItem{{Value: "0a1b2c3d4e5f", ValueType: model.IdentificationTypeTypeEui48}}, nil
}
func (fakeEVCC) ManufacturerData(spineapi.EntityRemoteInterface) (ucapi.ManufacturerData, error) {
	return ucapi.ManufacturerData{BrandName: "VW", DeviceName: "ID.3"}, nil
}
func (fakeEVCC) ChargingPowerLimits(spineapi.EntityRemoteInterface) (float64, float64, float64, error) {
	return 1380, 11040, 0, nil
}
func (fakeEVCC) IsInSleepMode(spineapi.EntityRemoteInterface) (bool, error) { return false, nil }

type fakeEVCEM struct{}

func (fakeEVCEM) PhasesConnected(spineapi.EntityRemoteInterface) (uint, error) { return 3, nil }
func (fakeEVCEM) CurrentPerPhase(spineapi.EntityRemoteInterface) ([]float64, error) {
	return []float64{10, 10.5, 9.5}, nil
}
func (fakeEVCEM) PowerPerPhase(spineapi.EntityRemoteInterface) ([]float64, error) {
	return []float64{2300, 2400, 2200}, nil
}
func (fakeEVCEM) EnergyCharged(spineapi.EntityRemoteInterface) (float64, error) { return 0, errNA }

type fakeSOC struct{ v float64 }

func (f fakeSOC) StateOfCharge(spineapi.EntityRemoteInterface) (float64, error) { return f.v, nil }

type fakeLimits struct {
	mu      sync.Mutex
	written []ucapi.LoadLimitsPhase
}

func (*fakeLimits) CurrentLimits(spineapi.EntityRemoteInterface) ([]float64, []float64, []float64, error) {
	return []float64{6, 6, 6}, []float64{16, 16, 16}, []float64{0, 0, 0}, nil
}
func (*fakeLimits) LoadControlLimits(spineapi.EntityRemoteInterface) ([]ucapi.LoadLimitsPhase, error) {
	return []ucapi.LoadLimitsPhase{
		{Phase: model.ElectricalConnectionPhaseNameTypeA, IsChangeable: true, IsActive: true, Value: 10},
		{Phase: model.ElectricalConnectionPhaseNameTypeB, IsChangeable: true, IsActive: false, Value: 16},
	}, nil
}
func (f *fakeLimits) WriteLoadControlLimits(_ spineapi.EntityRemoteInterface, limits []ucapi.LoadLimitsPhase,
	cb func(result model.ResultDataType, msgCounter model.MsgCounterType)) (*model.MsgCounterType, error) {
	f.mu.Lock()
	f.written = limits
	f.mu.Unlock()
	if cb != nil {
		go cb(model.ResultDataType{ErrorNumber: util.Ptr(model.ErrorNumberTypeNoError)}, 1)
	}
	return util.Ptr(model.MsgCounterType(1)), nil
}

type fakeCEVC struct{}

func (fakeCEVC) ChargeStrategy(spineapi.EntityRemoteInterface) ucapi.EVChargeStrategyType {
	return ucapi.EVChargeStrategyTypeTimedCharging
}
func (fakeCEVC) EnergyDemand(spineapi.EntityRemoteInterface) (ucapi.Demand, error) {
	return ucapi.Demand{MinDemand: 1000, OptDemand: 20000, MaxDemand: 40000, DurationUntilStart: 0, DurationUntilEnd: 7200}, nil
}
func (fakeCEVC) ChargePlan(spineapi.EntityRemoteInterface) (ucapi.ChargePlan, error) {
	start := time.UnixMilli(1_800_000_000_000)
	return ucapi.ChargePlan{Slots: []ucapi.ChargePlanSlotValue{{Start: start, End: start.Add(time.Hour), Value: 11000, MinValue: 1380, MaxValue: 11040}}}, nil
}

const skiWB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const evKey = "d:_n:Wallbox_1/1/1"

func TestEAutoMeldungen(t *testing.T) {
	d := mustJSON(t, evDataEvent(skiWB, evKey, fakeEVCC{}, nil))
	for _, part := range []string{`"ev":"ev_data"`, `"ski":"` + skiWB + `"`, `"entity":"` + evKey + `"`, `"charge_state":"active"`,
		`"comm_standard":"iso15118-2ed2"`, `"power_min_w":1380`, `"power_max_w":11040`, `"sleep":false`,
		`"ids":[{"type":"eui48","value":"0a1b2c3d4e5f"}]`, `"manufacturer":{"brand":"VW","device":"ID.3"}`} {
		if !bytes.Contains([]byte(d), []byte(part)) {
			t.Fatalf("ev_data ohne %s: %s", part, d)
		}
	}
	if bytes.Contains([]byte(d), []byte("asymmetric")) {
		t.Fatalf("nicht gelieferte Werte fehlen statt geraten zu werden: %s", d)
	}

	m := mustJSON(t, evMeasurementEvent(skiWB, evKey, fakeEVCEM{}, nil))
	if want := `{"ev":"ev_measurement","ski":"` + skiWB + `","entity":"` + evKey + `","phases":3,"current_a":[10,10.5,9.5],"power_w":[2300,2400,2200],"power_total_w":6900}`; m != want {
		t.Fatalf("ev_measurement\n got %s\nwant %s", m, want)
	}

	s := mustJSON(t, evSocEvent(skiWB, evKey, fakeSOC{v: 63.5}, nil))
	if want := `{"ev":"ev_soc","ski":"` + skiWB + `","entity":"` + evKey + `","soc":63.5}`; s != want {
		t.Fatalf("ev_soc %s", s)
	}

	l := mustJSON(t, evLimitsEvent(skiWB, evKey, "opev", &fakeLimits{}, nil))
	if want := `{"ev":"ev_limits","ski":"` + skiWB + `","entity":"` + evKey + `","uc":"opev","min_a":[6,6,6],"max_a":[16,16,16],"default_a":[0,0,0],` +
		`"limits":[{"phase":"a","active":true,"value_a":10,"changeable":true},{"phase":"b","active":false,"value_a":16,"changeable":true}]}`; l != want {
		t.Fatalf("ev_limits\n got %s\nwant %s", l, want)
	}

	p := mustJSON(t, evPlanEvent(skiWB, evKey, fakeCEVC{}, nil))
	if want := `{"ev":"ev_charge_plan","ski":"` + skiWB + `","entity":"` + evKey + `","strategy":"timedcharging",` +
		`"demand":{"min_wh":1000,"opt_wh":20000,"max_wh":40000,"start_in_s":0,"end_in_s":7200},` +
		`"plan":[{"start_ms":1800000000000,"end_ms":1800003600000,"w":11000,"min_w":1380,"max_w":11040}]}`; p != want {
		t.Fatalf("ev_charge_plan\n got %s\nwant %s", p, want)
	}
}

func TestStromgrenzenFuersAuto(t *testing.T) {
	lim, err := buildCurrentLimits([]float64{16, 10, 6}, false, nil)
	if err != nil || len(lim) != 3 || lim[0].Phase != model.ElectricalConnectionPhaseNameTypeA || lim[1].Value != 10 || !lim[2].IsActive {
		t.Fatalf("je Phase %+v %v", lim, err)
	}
	// Ein Wert gilt für alle drei Phasen (einphasige Autos: eebus-go überspringt fehlende Phasen).
	lim, _ = buildCurrentLimits([]float64{8}, false, nil)
	if len(lim) != 3 || lim[2].Value != 8 || lim[2].Phase != model.ElectricalConnectionPhaseNameTypeC {
		t.Fatalf("ein Wert %+v", lim)
	}
	// null = aufheben: inaktiv, Wert = Höchststrom der Phase.
	lim, _ = buildCurrentLimits(nil, true, []float64{16, 16, 32})
	if len(lim) != 3 || lim[0].IsActive || lim[2].Value != 32 {
		t.Fatalf("aufheben %+v", lim)
	}
	for _, bad := range [][]float64{{}, {1, 2, 3, 4}, {-1}} {
		if _, err := buildCurrentLimits(bad, false, nil); err == nil {
			t.Fatalf("%v muss abgelehnt werden", bad)
		}
	}
}

func TestBefehlStromgrenzeAnsAuto(t *testing.T) {
	b, out := newBareBridge()
	w := &fakeLimits{}
	b.evWriters = map[string]evLimitsRW{"opev": w}
	b.rememberEV("opev", skiWB, evKey, nil)
	c, _ := parseCommand([]byte(`{"cmd":"ev_current_limits","id":3,"ski":"` + skiWB + `","amps":[10,10,10]}`))
	b.HandleCommand(c)
	r := out.waitFor(t, time.Second, "reply", func(m map[string]any) bool { return m["ev"] == "reply" })
	if r["ok"] != true || r["id"] != float64(3) || r["cmd"] != "ev_current_limits" {
		t.Fatalf("reply %v", r)
	}
	wr := out.waitFor(t, time.Second, "write_result", func(m map[string]any) bool { return m["ev"] == "write_result" })
	if wr["id"] != float64(3) || wr["ok"] != true {
		t.Fatalf("write_result %v", wr)
	}
	w.mu.Lock()
	got := w.written
	w.mu.Unlock()
	if len(got) != 3 || got[0].Value != 10 || !got[0].IsActive {
		t.Fatalf("geschrieben %+v", got)
	}
	// Aufheben über entity statt ski, Höchstwerte aus CurrentLimits.
	c, _ = parseCommand([]byte(`{"cmd":"ev_current_limits","id":4,"uc":"opev","entity":"` + evKey + `","amps":null}`))
	b.HandleCommand(c)
	w.mu.Lock()
	got = w.written
	w.mu.Unlock()
	if len(got) != 3 || got[1].IsActive || got[1].Value != 16 {
		t.Fatalf("aufheben %+v", got)
	}
	c, _ = parseCommand([]byte(`{"cmd":"ev_current_limits","id":5,"ski":"` + skiWB + `"}`))
	b.HandleCommand(c)
	r = out.waitFor(t, time.Second, "reply 5", func(m map[string]any) bool { return m["ev"] == "reply" && m["id"] == float64(5) })
	if r["ok"] != false || r["error"] != "amps missing" {
		t.Fatalf("ohne amps %v", r)
	}
}

// --- Verdichter (OHPCF) ------------------------------------------------------------

func ohpcfData(state model.PowerSequenceStateType, alternatives uint) *model.SmartEnergyManagementPsDataType {
	node := &model.PowerSequenceNodeScheduleInformationDataType{
		NodeRemoteControllable: util.Ptr(true), SupportsSingleSlotSchedulingOnly: util.Ptr(true),
		AlternativesCount: util.Ptr(alternatives), TotalSequencesCountMax: util.Ptr(uint(1)), SupportsReselection: util.Ptr(false),
	}
	if alternatives == 0 {
		return &model.SmartEnergyManagementPsDataType{NodeScheduleInformation: node}
	}
	seq := model.SmartEnergyManagementPsPowerSequenceType{
		Description: &model.PowerSequenceDescriptionDataType{SequenceId: util.Ptr(model.PowerSequenceIdType(1)), PowerUnit: util.Ptr(model.UnitOfMeasurementTypeW)},
		State:       &model.PowerSequenceStateDataType{State: util.Ptr(state)},
		ScheduleConstraints: &model.PowerSequenceScheduleConstraintsDataType{
			EarliestStartTime: model.NewAbsoluteOrRelativeTimeTypeFromDuration(5 * time.Minute),
			LatestEndTime:     model.NewAbsoluteOrRelativeTimeTypeFromDuration(6 * time.Hour),
		},
		OperatingConstraintsInterrupt: &model.OperatingConstraintsInterruptDataType{IsStoppable: util.Ptr(true), IsPausable: util.Ptr(false)},
		OperatingConstraintsDuration:  &model.OperatingConstraintsDurationDataType{ActiveDurationMin: model.NewDurationType(30 * time.Minute)},
		PowerTimeSlot: []model.SmartEnergyManagementPsPowerTimeSlotType{{
			ValueList: &model.SmartEnergyManagementPsPowerTimeSlotValueListType{Value: []model.PowerTimeSlotValueDataType{
				{ValueType: util.Ptr(model.PowerTimeSlotValueTypeTypePower), Value: model.NewScaledNumberType(1500)},
				{ValueType: util.Ptr(model.PowerTimeSlotValueTypeTypePowerMax), Value: model.NewScaledNumberType(2000)},
			}},
		}},
	}
	if state == model.PowerSequenceStateTypeScheduled {
		seq.Schedule = &model.PowerSequenceScheduleDataType{StartTime: model.NewAbsoluteOrRelativeTimeTypeFromDuration(time.Hour)}
	}
	return &model.SmartEnergyManagementPsDataType{
		NodeScheduleInformation: node,
		Alternatives:            []model.SmartEnergyManagementPsAlternativesType{{PowerSequence: []model.SmartEnergyManagementPsPowerSequenceType{seq}}},
	}
}

func TestVerdichterAnkuendigungZustandAbbruch(t *testing.T) {
	now := time.Now()
	r := ohpcfAnalyze(ohpcfData(model.PowerSequenceStateTypeInactive, 1), now)
	if r.Kind != "announce" || r.Announce == nil {
		t.Fatalf("Ankündigung erwartet: %+v", r)
	}
	a := r.Announce
	if a.MaxPowerW != 2000 || a.EarliestStartS != 300 || a.LatestEndS != 21600 || a.MinDurationS != 1800 || !a.Stoppable || a.Pausable {
		t.Fatalf("announce %+v", a)
	}
	ev := mustJSON(t, ohpcfAnnounceEvent(skiWB, "d:_n:HP/1/1", a))
	if want := `{"ev":"ohpcf_announce","uc":"ohpcf","entity":"d:_n:HP/1/1","ski":"` + skiWB + `","max_power_w":2000,"earliest_start_s":300,"latest_end_s":21600,"min_duration_s":1800,"stoppable":true,"pausable":false}`; ev != want {
		t.Fatalf("ohpcf_announce\n got %s\nwant %s", ev, want)
	}

	r = ohpcfAnalyze(ohpcfData(model.PowerSequenceStateTypeScheduled, 1), now)
	if r.Kind != "state" || r.State != "scheduled" || r.StartInS == nil || *r.StartInS != 3600 {
		t.Fatalf("scheduled %+v", r)
	}
	r = ohpcfAnalyze(ohpcfData(model.PowerSequenceStateTypeRunning, 1), now)
	if r.Kind != "state" || r.State != "running" || r.StartInS != nil {
		t.Fatalf("running %+v", r)
	}
	r = ohpcfAnalyze(ohpcfData(model.PowerSequenceStateTypeInactive, 0), now)
	if r.Kind != "clear" {
		t.Fatalf("clear %+v", r)
	}
	if r = ohpcfAnalyze(nil, now); r.Kind != "" {
		t.Fatalf("ohne Daten nichts: %+v", r)
	}
}
