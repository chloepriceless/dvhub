package main

// Prozessverhalten wie bridge/main.c: Nutzungsfehler → 2, --gen-cert, belegter
// Port → fatal, ready auf stdout, Ende sobald stdin schließt.

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProzessNutzungsfehlerUndZertifikat(t *testing.T) {
	var out, errb bytes.Buffer
	if code := run([]string{"--bogus"}, strings.NewReader(""), &out, &errb); code != 2 || !strings.HasPrefix(errb.String(), "usage: dvhub-eebus") {
		t.Fatalf("code %d stderr %q", code, errb.String())
	}
	dir := t.TempDir()
	c, k := filepath.Join(dir, "c.pem"), filepath.Join(dir, "k.pem")
	if code := run([]string{"--gen-cert", c, k, "selftest"}, strings.NewReader(""), &out, &errb); code != 0 {
		t.Fatalf("gen-cert %d %s", code, errb.String())
	}
	if _, err := skiOfFiles(c, k); err != nil {
		t.Fatal(err)
	}
	if code := run([]string{"--gen-cert", filepath.Join(dir, "missing", "c.pem"), k, "x"}, strings.NewReader(""), &out, &errb); code != 1 {
		t.Fatalf("Schreibfehler → 1, war %d", code)
	}
}

func TestProzessPortBelegt(t *testing.T) {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port
	var out, errb bytes.Buffer
	code := run([]string{"--port", fmt.Sprint(port), "--cert", "x", "--key", "y"}, strings.NewReader(""), &out, &errb)
	if code != 1 || strings.TrimSpace(out.String()) != fmt.Sprintf(`{"ev":"fatal","error":"port in use","port":%d}`, port) {
		t.Fatalf("code %d out %q", code, out.String())
	}
}

func TestProzessStartfehlerOhneZertifikat(t *testing.T) {
	var out, errb bytes.Buffer
	dir := t.TempDir()
	code := run([]string{"--port", fmt.Sprint(freePort(t)), "--cert", filepath.Join(dir, "no.pem"), "--key", filepath.Join(dir, "no.key")},
		strings.NewReader(""), &out, &errb)
	if code != 1 || strings.TrimSpace(out.String()) != `{"ev":"fatal","error":"start failed"}` {
		t.Fatalf("code %d out %q", code, out.String())
	}
	if !strings.Contains(errb.String(), "cannot load certificate") {
		t.Fatalf("stderr %q", errb.String())
	}
}

func TestProzessLaeuftBisStdinSchliesst(t *testing.T) {
	skipIntegration(t) // startet echtes mDNS
	dir := t.TempDir()
	c, k := filepath.Join(dir, "c.pem"), filepath.Join(dir, "k.pem")
	if err := generateCert(c, k, "DVhub-proc"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DVHUB_EEBUS_MDNS", "zeroconf")
	pr, pw := io.Pipe()
	out := &syncBuffer{}
	var errb syncBuffer
	done := make(chan int, 1)
	go func() {
		done <- run([]string{"--port", fmt.Sprint(freePort(t)), "--cert", c, "--key", k, "--serial", "P1", "--role", "server",
			"--trust", strings.Repeat("a", 40)}, pr, out, &errb)
	}()
	ready := out.waitFor(t, 20*time.Second, "ready", func(m map[string]any) bool { return m["ev"] == "ready" })
	if ready["ship_id"] != "DVhub-DVhub-P1" {
		t.Fatalf("ready %v", ready)
	}
	// Vertrauensliste aus --trust: Antwort ohne id (wie main.c).
	out.waitFor(t, 5*time.Second, "trust reply", func(m map[string]any) bool {
		_, hasID := m["id"]
		return m["ev"] == "reply" && m["cmd"] == "trust" && m["ok"] == true && !hasID
	})
	fmt.Fprintln(pw, `{"cmd":"status","id":1}`)
	fmt.Fprintln(pw, `kein json`)
	fmt.Fprintln(pw, ``)
	fmt.Fprintln(pw, `{"cmd":"pairing","id":2,"on":true}`)
	out.waitFor(t, 5*time.Second, "status", func(m map[string]any) bool { return m["ev"] == "status" && m["id"] == float64(1) })
	out.waitFor(t, 5*time.Second, "pairing", func(m map[string]any) bool { return m["ev"] == "reply" && m["id"] == float64(2) })
	pw.Close()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("Prozess endet nicht, obwohl stdin zu ist")
	}
	se := errb.dump()
	for _, want := range []string{"ignoring malformed command", "dvhub-eebus: stopped", "--role server"} {
		if !strings.Contains(se, want) {
			t.Fatalf("stderr ohne %q:\n%s", want, se)
		}
	}
}
