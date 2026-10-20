package main

// Befehle von DVhub: ein JSON-Objekt je Zeile auf stdin, {"cmd": "...", "id": n, ...}.
// Gleiche Auslegung wie bridge.c (Str/Num/Bool): Typen werden streng geprüft,
// eine Zahl als Zeichenkette ist keine Zahl.

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
)

type Command struct {
	m map[string]json.RawMessage
}

func parseCommand(line []byte) (*Command, error) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' {
		return nil, errors.New("not an object")
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(line, &m); err != nil {
		return nil, err
	}
	if m == nil {
		return nil, errors.New("not an object")
	}
	return &Command{m: m}, nil
}

// newCommand baut einen Befehl im Programm (z. B. aus --trust).
func newCommand(fields map[string]any) *Command {
	m := map[string]json.RawMessage{}
	for k, v := range fields {
		b, _ := json.Marshal(v)
		m[k] = b
	}
	return &Command{m: m}
}

func (c *Command) Has(k string) bool {
	_, ok := c.m[k]
	return ok
}

func (c *Command) Str(k string) (string, bool) {
	raw, ok := c.m[k]
	if !ok || len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

func isJSONNumber(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	ch := raw[0]
	return ch == '-' || (ch >= '0' && ch <= '9')
}

func (c *Command) Num(k string) (float64, bool) {
	raw, ok := c.m[k]
	if !ok || !isJSONNumber(raw) {
		return 0, false
	}
	var f float64
	if json.Unmarshal(raw, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

func (c *Command) Bool(k string, fallback bool) bool {
	switch string(c.m[k]) {
	case "true":
		return true
	case "false":
		return false
	}
	return fallback
}

// NumList liest eine Zahlenliste; null wird ausdrücklich gemeldet.
func (c *Command) NumList(k string) (vals []float64, null bool, ok bool) {
	raw, has := c.m[k]
	if !has {
		return nil, false, false
	}
	if string(raw) == "null" {
		return nil, true, true
	}
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return nil, false, false
	}
	for _, item := range list {
		if !isJSONNumber(item) {
			return nil, false, false
		}
		var f float64
		if json.Unmarshal(item, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, false, false
		}
		vals = append(vals, f)
	}
	return vals, false, true
}

// replyID ist die id zum Zurückgeben: nur Zahl oder Zeichenkette (bridge.c Reply).
func (c *Command) replyID() json.RawMessage {
	raw, ok := c.m["id"]
	if !ok {
		return nil
	}
	if isJSONNumber(raw) || (len(raw) > 0 && raw[0] == '"') {
		return raw
	}
	return nil
}

// CtxID ist die id für write_result (bridge.c CmdCtx: ganzzahlig, sonst 0).
func (c *Command) CtxID() int64 {
	if v, ok := c.Num("id"); ok {
		return int64(v)
	}
	return 0
}

func replyEvent(c *Command, ok bool, errMsg string) *Obj {
	ev := newEvent("reply")
	if id := c.replyID(); id != nil {
		ev.Raw("id", id)
	}
	if name, has := c.Str("cmd"); has {
		ev.Str("cmd", name)
	}
	ev.Bool("ok", ok)
	ev.StrIf("error", errMsg)
	return ev
}
