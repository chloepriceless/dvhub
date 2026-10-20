package main

// Befehle → Antworten an einer echt aufgebauten Bridge (eebus-go-Dienst,
// alle Anwendungsfälle), aber ohne Start: kein Netz, kein mDNS, keine Geräte.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer sammelt die Ausgabe der Bridge (stdout), auch aus anderen Goroutinen.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

// events liefert alle bisher ausgegebenen Meldungen.
func (s *syncBuffer) events(t *testing.T) []map[string]any {
	t.Helper()
	s.mu.Lock()
	data := s.buf.String()
	s.mu.Unlock()
	var out []map[string]any
	sc := bufio.NewScanner(strings.NewReader(data))
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("keine JSON-Zeile: %q", sc.Text())
		}
		out = append(out, m)
	}
	return out
}

// waitFor wartet, bis eine Meldung match erfüllt, und gibt sie zurück.
func (s *syncBuffer) waitFor(t *testing.T, timeout time.Duration, what string, match func(map[string]any) bool) map[string]any {
	t.Helper()
	return s.waitForSince(t, 0, timeout, what, match)
}

// waitForSince wie waitFor, betrachtet aber erst Meldungen ab Index since.
func (s *syncBuffer) waitForSince(t *testing.T, since int, timeout time.Duration, what string, match func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		evs := s.events(t)
		if since > len(evs) {
			since = len(evs)
		}
		for _, ev := range evs[since:] {
			if match(ev) {
				return ev
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("Meldung %s nicht erhalten; bisher:\n%s", what, s.dump())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *syncBuffer) dump() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type testBridge struct {
	b   *Bridge
	out *syncBuffer
}

func newTestBridge(t *testing.T, serial string) *testBridge {
	t.Helper()
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := generateCert(certPath, keyPath, "DVhub-"+serial); err != nil {
		t.Fatal(err)
	}
	out := &syncBuffer{}
	opts := defaultOptions()
	opts.Port = freePort(t)
	opts.CertPath, opts.KeyPath, opts.Serial = certPath, keyPath, serial
	opts.Mdns = "zeroconf"
	b := NewBridge(NewOut(out, &bytes.Buffer{}), opts)
	if err := b.setup(); err != nil {
		t.Fatalf("setup: %v", err)
	}
	return &testBridge{b: b, out: out}
}

// cmd schickt eine Befehlszeile und gibt die Antwort mit derselben id zurück (oder nil).
func (tb *testBridge) cmd(t *testing.T, line string) map[string]any {
	t.Helper()
	c, err := parseCommand([]byte(line))
	if err != nil {
		t.Fatal(err)
	}
	before := len(tb.out.events(t))
	tb.b.HandleCommand(c)
	evs := tb.out.events(t)[before:]
	for _, ev := range evs {
		if ev["ev"] == "reply" || ev["ev"] == "status" {
			return ev
		}
	}
	return nil
}

func expectReply(t *testing.T, got map[string]any, ok bool, errMsg string) {
	t.Helper()
	if got == nil {
		t.Fatal("keine Antwort")
	}
	if got["ok"] != ok {
		t.Fatalf("ok=%v erwartet %v: %v", got["ok"], ok, got)
	}
	if errMsg == "" {
		if _, has := got["error"]; has {
			t.Fatalf("unerwarteter Fehler: %v", got)
		}
	} else if got["error"] != errMsg {
		t.Fatalf("error=%v erwartet %q", got["error"], errMsg)
	}
}

func TestReadyMeldung(t *testing.T) {
	tb := newTestBridge(t, "SER1")
	ev := mustJSON(t, tb.b.readyEvent())
	var m map[string]any
	_ = json.Unmarshal([]byte(ev), &m)
	if ski, _ := m["ski"].(string); len(ski) != 40 || strings.ToLower(ski) != ski {
		t.Fatalf("ski %v", m["ski"])
	}
	if m["ship_id"] != "DVhub-DVhub-SER1" {
		t.Fatalf("ship_id wie bridge.c (brand-model-serial): %v", m["ship_id"])
	}
	if int(m["port"].(float64)) != tb.b.opts.Port {
		t.Fatalf("port %v", m["port"])
	}
	if qr, _ := m["qr"].(string); !strings.HasPrefix(qr, "SHIP;") {
		t.Fatalf("qr %q", m["qr"])
	}
}

func TestBefehleKopplung(t *testing.T) {
	tb := newTestBridge(t, "SER2")
	expectReply(t, tb.cmd(t, `{"cmd":"trust","id":1,"ski":"abc"}`), false, "ski must be 40 hex characters")
	r := tb.cmd(t, `{"cmd":"trust","id":2,"ski":"`+strings.Repeat("a", 40)+`"}`)
	expectReply(t, r, true, "")
	if r["id"] != float64(2) || r["cmd"] != "trust" {
		t.Fatalf("id/cmd zurück: %v", r)
	}
	expectReply(t, tb.cmd(t, `{"cmd":"untrust","id":3,"ski":"`+strings.Repeat("a", 40)+`"}`), true, "")
	expectReply(t, tb.cmd(t, `{"cmd":"pairing","id":4,"on":true}`), true, "")
	expectReply(t, tb.cmd(t, `{"cmd":"pairing","id":5,"on":false}`), true, "")
	expectReply(t, tb.cmd(t, `{"cmd":"cancel_pairing","id":6}`), false, "ski missing")
	expectReply(t, tb.cmd(t, `{"cmd":"cancel_pairing","id":7,"ski":"`+strings.Repeat("b", 40)+`"}`), true, "")
	expectReply(t, tb.cmd(t, `{"cmd":"bogus","id":8}`), false, "unknown command")
	expectReply(t, tb.cmd(t, `{"id":9}`), false, "no command")
}

func TestBefehleNetzseite(t *testing.T) {
	tb := newTestBridge(t, "SER3")
	expectReply(t, tb.cmd(t, `{"cmd":"grid_config","id":1,"uc":"x"}`), false, "uc must be lpc or lpp")
	expectReply(t, tb.cmd(t, `{"cmd":"grid_config","id":2,"uc":"lpc","nominal_max_w":43470,"failsafe_w":4200,"failsafe_duration_s":7200}`), true, "")
	if v, _, err := tb.b.csLPC.FailsafeConsumptionActivePowerLimit(); err != nil || v != 4200 {
		t.Fatalf("failsafe lpc %v %v", v, err)
	}
	if v, err := tb.b.csLPC.ConsumptionNominalMax(); err != nil || v != 43470 {
		t.Fatalf("nominal lpc %v %v", v, err)
	}
	expectReply(t, tb.cmd(t, `{"cmd":"grid_config","id":3,"uc":"lpp","nominal_max_w":30000,"failsafe_w":30000,"failsafe_duration_s":86400}`), true, "")
	if d, _, err := tb.b.csLPP.FailsafeDurationMinimum(); err != nil || d != 24*time.Hour {
		t.Fatalf("failsafe dauer lpp %v %v", d, err)
	}
	expectReply(t, tb.cmd(t, `{"cmd":"grid_config","id":4,"uc":"lpc","failsafe_duration_s":60}`), false, "setting grid values failed")

	expectReply(t, tb.cmd(t, `{"cmd":"grid_limit_state","id":5}`), false, "uc missing")
	expectReply(t, tb.cmd(t, `{"cmd":"grid_limit_state","id":6,"uc":"lpc"}`), false, "w missing")
	expectReply(t, tb.cmd(t, `{"cmd":"grid_limit_state","id":7,"uc":"lpc","w":5000,"active":true}`), true, "")
	expectReply(t, tb.cmd(t, `{"cmd":"grid_limit_state","id":8,"uc":"lpp","w":-3000,"active":false}`), true, "")

	st := tb.cmd(t, `{"cmd":"status","id":9}`)
	if st["ev"] != "status" || st["id"] != float64(9) {
		t.Fatalf("status %v", st)
	}
	lpc, _ := st["lpc"].(map[string]any)
	lpp, _ := st["lpp"].(map[string]any)
	if lpc["w"] != float64(5000) || lpc["active"] != true || lpc["heartbeat_ok"] != false {
		t.Fatalf("status lpc %v", lpc)
	}
	if lpp["w"] != float64(-3000) || lpp["active"] != false {
		t.Fatalf("status lpp %v", lpp)
	}
	if ski, _ := st["ski"].(string); len(ski) != 40 {
		t.Fatalf("status ski %v", st["ski"])
	}
}

func TestBefehlNetzanschlusspunkt(t *testing.T) {
	tb := newTestBridge(t, "SER4")
	// Ohne id keine Antwort (DVhub schreibt den Takt direkt, bridge.c CmdGcp).
	if r := tb.cmd(t, `{"cmd":"gcp","power_w":1234,"energy_consumed_wh":5000,"energy_feed_in_wh":700}`); r != nil {
		t.Fatalf("gcp ohne id darf nicht antworten: %v", r)
	}
	if v, err := tb.b.mgcp.PowerTotal(); err != nil || v != 1234 {
		t.Fatalf("power %v %v", v, err)
	}
	if v, err := tb.b.mgcp.EnergyConsumed(); err != nil || v != 5000 {
		t.Fatalf("consumed %v %v", v, err)
	}
	if v, err := tb.b.mgcp.EnergyFeedIn(); err != nil || v != 700 {
		t.Fatalf("feed-in %v %v", v, err)
	}
	expectReply(t, tb.cmd(t, `{"cmd":"gcp","id":1,"power_w":-800}`), true, "")
	if v, _ := tb.b.mgcp.PowerTotal(); v != -800 {
		t.Fatalf("power %v", v)
	}
}

func TestBefehleGeraeteseiteOhneGeraet(t *testing.T) {
	tb := newTestBridge(t, "SER5")
	expectReply(t, tb.cmd(t, `{"cmd":"device_limit","id":1,"uc":"lpc","entity":"d:_n:X/1","w":1000}`), false, "unknown device entity")
	expectReply(t, tb.cmd(t, `{"cmd":"device_failsafe","id":2,"uc":"lpp","entity":"d:_n:X/1","w":1000}`), false, "unknown device entity")
	expectReply(t, tb.cmd(t, `{"cmd":"ohpcf","id":3,"entity":"d:_n:X/1","action":"stop"}`), false, "unknown compressor entity")
	expectReply(t, tb.cmd(t, `{"cmd":"ev_current_limits","id":4,"ski":"`+strings.Repeat("e", 40)+`","amps":[16,16,16]}`), false, "unknown ev entity")
	expectReply(t, tb.cmd(t, `{"cmd":"ev_current_limits","id":5,"ski":"`+strings.Repeat("e", 40)+`","uc":"bogus","amps":[16]}`), false, "uc must be opev or oscev")
}

func TestHerzschlagZustandNurBeiAenderung(t *testing.T) {
	tb := newTestBridge(t, "SER6")
	tb.b.Tick()
	tb.b.Tick()
	n := 0
	for _, ev := range tb.out.events(t) {
		if ev["ev"] == "grid_heartbeat_state" {
			n++
			if ev["lpc_ok"] != false || ev["lpp_ok"] != false {
				t.Fatalf("ohne Steuerbox kein Herzschlag: %v", ev)
			}
		}
	}
	if n != 1 {
		t.Fatalf("grid_heartbeat_state einmal beim ersten Takt, dann nur bei Änderung: %d", n)
	}
}
