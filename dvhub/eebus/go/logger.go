package main

import "fmt"

// stderrLogger leitet die Meldungen von eebus-go/ship-go/spine-go auf stderr
// (DVhub hält die letzten Zeilen für die Oberfläche). Debug/Trace nur mit
// DVHUB_EEBUS_DEBUG=1.
type stderrLogger struct {
	out   *Out
	debug bool
}

func (l *stderrLogger) Trace(args ...interface{}) {
	if l.debug {
		l.out.Logf("trace: %s", fmt.Sprint(args...))
	}
}
func (l *stderrLogger) Tracef(f string, args ...interface{}) {
	if l.debug {
		l.out.Logf("trace: "+f, args...)
	}
}
func (l *stderrLogger) Debug(args ...interface{}) {
	if l.debug {
		l.out.Logf("debug: %s", fmt.Sprint(args...))
	}
}
func (l *stderrLogger) Debugf(f string, args ...interface{}) {
	if l.debug {
		l.out.Logf("debug: "+f, args...)
	}
}
func (l *stderrLogger) Info(args ...interface{})             { l.out.Logf("%s", fmt.Sprint(args...)) }
func (l *stderrLogger) Infof(f string, args ...interface{})  { l.out.Logf(f, args...) }
func (l *stderrLogger) Error(args ...interface{})            { l.out.Logf("error: %s", fmt.Sprint(args...)) }
func (l *stderrLogger) Errorf(f string, args ...interface{}) { l.out.Logf("error: "+f, args...) }
