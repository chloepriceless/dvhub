// dvhub-eebus — EEBUS-Knoten (SHIP/SPINE) für DVhub, gebaut auf enbility
// eebus-go/ship-go/spine-go (MIT). Ersetzt die C-Bridge auf openeebus
// (dvhub/eebus/bridge/), Protokoll unverändert — siehe PROTOKOLL.md.
//
// Aufruf:
//
//	dvhub-eebus --gen-cert <cert.pem> <key.pem> <common-name>
//	dvhub-eebus --port 4712 --cert <cert.pem> --key <key.pem>
//	            [--vendor DVhub] [--brand DVhub] [--model DVhub] [--serial <id>]
//	            [--role auto|client|server] [--trust <ski>]...
//
// Protokoll mit DVhub (ein JSON-Objekt je Zeile):
//
//	stdin  — Befehle {"cmd": "...", "id": n, ...}
//	stdout — Meldungen {"ev": "...", ...}
//	stderr — Diagnose
//
// Schließt sich stdin (DVhub beendet oder abgestürzt), beendet sich der Prozess.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// portAvailable: ship-go meldet einen belegten Port erst spät; vorher prüfen
// und laut scheitern, damit DVhub den Fehler zeigt (main.c PortAvailable).
func portAvailable(port int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return !errors.Is(err, syscall.EADDRINUSE)
	}
	_ = l.Close()
	return true
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	out := NewOut(stdout, stderr)
	opts, gen, err := parseArgs(args)
	if err != nil {
		_, _ = io.WriteString(stderr, usageText)
		return 2
	}
	if gen != nil {
		if err := generateCert(gen.Cert, gen.Key, gen.CN); err != nil {
			out.Logf("%v", err)
			return 1
		}
		return 0
	}

	if !portAvailable(opts.Port) {
		out.Emit(newEvent("fatal").Str("error", "port in use").Int("port", int64(opts.Port)))
		return 1
	}

	b := NewBridge(out, opts)
	if err := b.Start(); err != nil {
		out.Emit(newEvent("fatal").Str("error", "start failed"))
		b.Stop()
		return 1
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	signal.Ignore(syscall.SIGPIPE)

	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(stdin)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 {
				continue
			}
			c, err := parseCommand(line)
			if err != nil {
				out.Logf("ignoring malformed command")
				continue
			}
			b.HandleCommand(c)
		}
	}()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
loop:
	for {
		select {
		case <-ticker.C:
			b.Tick()
		case <-stop:
			break loop
		case <-done:
			break loop
		}
	}
	b.Stop()
	out.Logf("stopped")
	return 0
}
