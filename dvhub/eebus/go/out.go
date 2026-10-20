package main

// Ausgabe an DVhub: eine JSON-Zeile je Meldung auf stdout, Diagnose auf
// stderr (Gegenstück zu bridge/out.c). Die Felder bleiben in der Reihenfolge,
// in der sie gesetzt werden ("ev" zuerst) — DVhub braucht das nicht, aber die
// Zeilen lesen sich wie die der C-Bridge.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sync"
)

type kv struct {
	k string
	v any
}

// Obj ist ein JSON-Objekt mit fester Feldreihenfolge.
type Obj struct {
	fields []kv
}

func newObj() *Obj { return &Obj{} }

// newEvent beginnt eine Meldung {"ev": name, ...}.
func newEvent(name string) *Obj { return newObj().Str("ev", name) }

func (o *Obj) set(k string, v any) *Obj {
	for i := range o.fields {
		if o.fields[i].k == k {
			o.fields[i].v = v
			return o
		}
	}
	o.fields = append(o.fields, kv{k, v})
	return o
}

func (o *Obj) Str(k, v string) *Obj { return o.set(k, v) }

// Num schreibt eine Zahl; NaN/Inf werden 0 (JSON kennt sie nicht).
func (o *Obj) Num(k string, v float64) *Obj {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		v = 0
	}
	return o.set(k, v)
}

func (o *Obj) Int(k string, v int64) *Obj  { return o.set(k, v) }
func (o *Obj) Bool(k string, v bool) *Obj  { return o.set(k, v) }
func (o *Obj) Any(k string, v any) *Obj    { return o.set(k, v) }
func (o *Obj) Raw(k string, v []byte) *Obj { return o.set(k, json.RawMessage(v)) }

// StrIf setzt das Feld nur bei nicht leerem Wert (bridge.c AddStr).
func (o *Obj) StrIf(k, v string) *Obj {
	if v == "" {
		return o
	}
	return o.Str(k, v)
}

// Get liefert einen Feldwert (für Tests und interne Prüfungen).
func (o *Obj) Get(k string) (any, bool) {
	for _, f := range o.fields {
		if f.k == k {
			return f.v, true
		}
	}
	return nil, false
}

func (o *Obj) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, f := range o.fields {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, _ := json.Marshal(f.k)
		buf.Write(k)
		buf.WriteByte(':')
		v, err := marshalValue(f.v)
		if err != nil {
			return nil, err
		}
		buf.Write(v)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func marshalValue(v any) ([]byte, error) {
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return []byte("0"), nil
		}
	case []float64:
		clean := make([]float64, len(x))
		for i, f := range x {
			if !math.IsNaN(f) && !math.IsInf(f, 0) {
				clean[i] = f
			}
		}
		v = clean
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// Out schreibt Meldungen und Diagnosezeilen threadsicher.
type Out struct {
	mu     sync.Mutex
	stdout io.Writer
	stderr io.Writer
}

func NewOut(stdout, stderr io.Writer) *Out { return &Out{stdout: stdout, stderr: stderr} }

// Emit schreibt eine Meldung als eine Zeile (nil wird ignoriert).
func (o *Out) Emit(ev *Obj) {
	if o == nil || ev == nil {
		return
	}
	b, err := json.Marshal(ev)
	if err != nil {
		o.Logf("cannot encode event: %v", err)
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	_, _ = o.stdout.Write(append(b, '\n'))
}

// Logf schreibt "dvhub-eebus: …" auf stderr (bridge/out.c OutLog).
func (o *Out) Logf(format string, args ...any) {
	if o == nil {
		return
	}
	line := fmt.Sprintf("dvhub-eebus: "+format+"\n", args...)
	o.mu.Lock()
	defer o.mu.Unlock()
	_, _ = io.WriteString(o.stderr, line)
}

// EmitSki schreibt {"ev": name, "ski": ski} (bridge/out.c OutEmitSki).
func (o *Out) EmitSki(name, ski string) {
	o.Emit(newEvent(name).Str("ski", ski))
}
