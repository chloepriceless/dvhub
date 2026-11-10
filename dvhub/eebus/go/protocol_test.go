package main

// Tests für das JSON-Zeilen-Protokoll ohne Netz und ohne Geräte: Aufbau der
// Meldungen, Auslesen der Befehle, Antworten, Aufrufargumente und die
// Prüfregeln, die die C-Bridge (bridge.c) genauso anwendet.

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/enbility/spine-go/model"
	"github.com/enbility/spine-go/util"
)

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestEventFeldfolgeUndZahlen(t *testing.T) {
	ev := newEvent("grid_limit").Str("uc", "lpc").Num("w", 4200).Num("duration_s", 0).Bool("active", true)
	if got, want := mustJSON(t, ev), `{"ev":"grid_limit","uc":"lpc","w":4200,"duration_s":0,"active":true}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	// Bruchzahlen bleiben, nicht endliche Werte werden 0 (cJSON schreibt dafür null — DVhub rechnet mit Number()).
	ev = newEvent("device_measurement").Num("value", 0.5).Num("nan", math.NaN())
	if got, want := mustJSON(t, ev), `{"ev":"device_measurement","value":0.5,"nan":0}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	// Ein späterer Wert für denselben Schlüssel ersetzt den früheren (kein doppelter Schlüssel).
	ev = newEvent("x").Str("a", "1").Str("a", "2")
	if got, want := mustJSON(t, ev), `{"ev":"x","a":"2"}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	// Verschachtelt (status → lpc) und Listen.
	ev = newEvent("status").Any("lpc", newObj().Num("w", 1).Bool("active", false)).Any("l", []float64{1, 2})
	if got, want := mustJSON(t, ev), `{"ev":"status","lpc":{"w":1,"active":false},"l":[1,2]}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestOutSchreibtEineZeileJeMeldung(t *testing.T) {
	var stdout, stderr bytes.Buffer
	o := NewOut(&stdout, &stderr)
	o.Emit(newEvent("connected").Str("ski", "ab"))
	o.Emit(newEvent("disconnected").Str("ski", "ab"))
	o.Logf("stopped %d", 1)
	if got, want := stdout.String(), "{\"ev\":\"connected\",\"ski\":\"ab\"}\n{\"ev\":\"disconnected\",\"ski\":\"ab\"}\n"; got != want {
		t.Fatalf("stdout %q", got)
	}
	if got := stderr.String(); got != "dvhub-eebus: stopped 1\n" {
		t.Fatalf("stderr %q", got)
	}
}

func TestBefehleLesen(t *testing.T) {
	if _, err := parseCommand([]byte(`{"cmd":`)); err == nil {
		t.Fatal("kaputtes JSON muss abgelehnt werden")
	}
	if _, err := parseCommand([]byte(`[1,2]`)); err == nil {
		t.Fatal("nur Objekte sind Befehle")
	}
	c, err := parseCommand([]byte(`{"cmd":"grid_config","id":7,"uc":"lpc","nominal_max_w":43470,"s":"5","on":true,"amps":[16,10.5,0],"none":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := c.Str("cmd"); !ok || v != "grid_config" {
		t.Fatalf("cmd %q %v", v, ok)
	}
	if v, ok := c.Num("nominal_max_w"); !ok || v != 43470 {
		t.Fatalf("num %v %v", v, ok)
	}
	if _, ok := c.Num("s"); ok {
		t.Fatal("eine Zeichenkette ist keine Zahl (cJSON_IsNumber)")
	}
	if _, ok := c.Str("id"); ok {
		t.Fatal("eine Zahl ist keine Zeichenkette")
	}
	if !c.Bool("on", false) || c.Bool("missing", false) || !c.Bool("missing", true) || c.Bool("s", false) {
		t.Fatal("Bool mit Rückfallwert wie bridge.c")
	}
	if c.CtxID() != 7 {
		t.Fatalf("ctx id %d", c.CtxID())
	}
	if vals, null, ok := c.NumList("amps"); !ok || null || len(vals) != 3 || vals[1] != 10.5 {
		t.Fatalf("amps %v %v %v", vals, null, ok)
	}
	if _, null, ok := c.NumList("none"); !ok || !null {
		t.Fatal("null ausdrücklich erkennbar")
	}
	if _, _, ok := c.NumList("missing"); ok {
		t.Fatal("fehlend ist nicht null")
	}
	if !c.Has("none") || c.Has("missing") {
		t.Fatal("Has")
	}
}

func TestAntwortFormat(t *testing.T) {
	c, _ := parseCommand([]byte(`{"cmd":"trust","id":7,"ski":"abc"}`))
	if got, want := mustJSON(t, replyEvent(c, false, "ski must be 40 hex characters")),
		`{"ev":"reply","id":7,"cmd":"trust","ok":false,"error":"ski must be 40 hex characters"}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	c, _ = parseCommand([]byte(`{"cmd":"pairing","id":"a-1","on":true}`))
	if got, want := mustJSON(t, replyEvent(c, true, "")), `{"ev":"reply","id":"a-1","cmd":"pairing","ok":true}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	// Ohne id (Vertrauensliste aus --trust) und ohne cmd.
	c, _ = parseCommand([]byte(`{"x":1}`))
	if got, want := mustJSON(t, replyEvent(c, false, "no command")), `{"ev":"reply","ok":false,"error":"no command"}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	// id als Objekt wird nicht zurückgegeben (bridge.c: nur Zahl oder Zeichenkette).
	c, _ = parseCommand([]byte(`{"cmd":"status","id":{"a":1}}`))
	if strings.Contains(mustJSON(t, replyEvent(c, true, "")), `"id"`) {
		t.Fatal("id-Objekt darf nicht zurückkommen")
	}
	if c.CtxID() != 0 {
		t.Fatal("write_result-id ohne Zahl ist 0")
	}
}

func TestAufrufargumente(t *testing.T) {
	o, gen, err := parseArgs([]string{"--port", "4799", "--cert", "c.pem", "--key", "k.pem", "--serial", "X1", "--trust", strings.Repeat("a", 40), "--trust", strings.Repeat("b", 40)})
	if err != nil || gen != nil {
		t.Fatalf("err %v gen %v", err, gen)
	}
	if o.Port != 4799 || o.CertPath != "c.pem" || o.KeyPath != "k.pem" || o.Serial != "X1" {
		t.Fatalf("opts %+v", o)
	}
	if o.Vendor != "DVhub" || o.Brand != "DVhub" || o.Model != "DVhub" || o.Role != "auto" {
		t.Fatalf("Vorgaben wie main.c: %+v", o)
	}
	if len(o.Trust) != 2 {
		t.Fatalf("trust %v", o.Trust)
	}
	o, _, err = parseArgs([]string{"--cert", "c", "--key", "k"})
	if err != nil || o.Port != 4712 || o.Serial != "0" {
		t.Fatalf("Standardport 4712, Seriennummer 0: %+v %v", o, err)
	}
	for _, bad := range [][]string{
		{"--cert", "c"},                                  // Schlüssel fehlt
		{"--cert", "c", "--key", "k", "--port"},          // Wert fehlt
		{"--cert", "c", "--key", "k", "--bogus", "1"},    // unbekannt
		{"--cert", "c", "--key", "k", "--port", "0"},     // Port ungültig
		{"--cert", "c", "--key", "k", "--port", "70000"}, // Port ungültig
		{"--gen-cert", "a", "b"},                         // zu wenige
	} {
		if _, _, err := parseArgs(bad); err == nil {
			t.Fatalf("%v muss Nutzungsfehler sein", bad)
		}
	}
	_, gen, err = parseArgs([]string{"--gen-cert", "c.pem", "k.pem", "DVhub-X"})
	if err != nil || gen == nil || gen.Cert != "c.pem" || gen.Key != "k.pem" || gen.CN != "DVhub-X" {
		t.Fatalf("gen-cert %+v %v", gen, err)
	}
	// Mehr als 32 --trust: bridge main.c übernimmt nur 32.
	args := []string{"--cert", "c", "--key", "k"}
	for i := 0; i < 40; i++ {
		args = append(args, "--trust", strings.Repeat("c", 40))
	}
	if o, _, _ = parseArgs(args); len(o.Trust) != 32 {
		t.Fatalf("trust begrenzt auf 32: %d", len(o.Trust))
	}
}

func TestPruefregelnWieBridgeC(t *testing.T) {
	// LPC: Grenze >= 0, Dauer >= 0 (openeebus CsLpIsLimitValid)
	if !limitValid("lpc", 4200, 0) || limitValid("lpc", -1, 0) || limitValid("lpc", 4200, -1) {
		t.Fatal("lpc")
	}
	// LPP: Grenze <= 0 [LPP-TS-001], Dauer >= 0
	if !limitValid("lpp", -4200, 3600) || !limitValid("lpp", 0, 0) || limitValid("lpp", 4200, 0) || limitValid("lpp", -1, -5) {
		t.Fatal("lpp")
	}
	if !failsafeValueValid(0) || !failsafeValueValid(3800) || failsafeValueValid(-1) {
		t.Fatal("failsafe value")
	}
	if !failsafeDurationValid(7200) || !failsafeDurationValid(86400) || failsafeDurationValid(7199) || failsafeDurationValid(86401) {
		t.Fatal("failsafe duration 2–24 h")
	}
	if secondsOf(90*time.Minute) != 5400 || secondsOf(1500*time.Millisecond) != 2 {
		t.Fatal("secondsOf rundet auf ganze Sekunden")
	}
}

func TestEntitaetsSchluessel(t *testing.T) {
	addr := &model.EntityAddressType{
		Device: util.Ptr(model.AddressDeviceType("d:_n:NIBE_123")),
		Entity: []model.AddressEntityType{1, 1},
	}
	if got := entityKey(addr); got != "d:_n:NIBE_123/1/1" {
		t.Fatalf("got %q", got)
	}
	if got := entityKey(nil); got != "" {
		t.Fatalf("nil → leer, got %q", got)
	}
}

func TestMessgroessenNamenWieBridgeC(t *testing.T) {
	want := map[string]string{
		"power": "power_w", "power_l1": "power_l1_w", "power_l2": "power_l2_w", "power_l3": "power_l3_w",
		"energy_consumed": "energy_consumed_wh", "energy_produced": "energy_produced_wh",
		"current_l1": "current_l1_a", "voltage_l3": "voltage_l3_v", "frequency": "frequency_hz",
	}
	got := map[string]string{
		"power": mpcName("power", 0), "power_l1": mpcName("power", 1), "power_l2": mpcName("power", 2), "power_l3": mpcName("power", 3),
		"energy_consumed": mpcName("energy_consumed", 0), "energy_produced": mpcName("energy_produced", 0),
		"current_l1": mpcName("current", 1), "voltage_l3": mpcName("voltage", 3), "frequency": mpcName("frequency", 0),
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s: got %q want %q", k, got[k], v)
		}
	}
}

func TestOhpcfZustandsnamen(t *testing.T) {
	cases := map[model.PowerSequenceStateType]string{
		model.PowerSequenceStateTypeScheduled: "scheduled",
		model.PowerSequenceStateTypeRunning:   "running",
		model.PowerSequenceStateTypePaused:    "paused",
		model.PowerSequenceStateTypeCompleted: "completed",
		model.PowerSequenceStateTypeInvalid:   "stopped",
		model.PowerSequenceStateTypeInactive:  "announced",
		model.PowerSequenceStateTypePending:   "undefined",
	}
	for in, want := range cases {
		if got := ohpcfStateName(in); got != want {
			t.Fatalf("%s: got %q want %q", in, got, want)
		}
	}
}
