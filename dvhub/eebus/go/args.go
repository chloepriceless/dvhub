package main

// Aufrufargumente — dieselben wie bridge/main.c:
//
//	dvhub-eebus --gen-cert <cert.pem> <key.pem> <common-name>
//	dvhub-eebus --port 4712 --cert <cert.pem> --key <key.pem>
//	            [--vendor DVhub] [--brand DVhub] [--model DVhub] [--serial <id>]
//	            [--role auto|client|server] [--trust <ski>]...

import (
	"errors"
	"os"
	"strconv"
)

const usageText = "usage: dvhub-eebus --gen-cert <cert> <key> <cn>\n" +
	"       dvhub-eebus --port <p> --cert <cert> --key <key> [--vendor v] [--brand b] [--model m]\n" +
	"                   [--serial s] [--role auto|client|server] [--trust <ski>]...\n"

// maxTrusted wie main.c (trusted[32]).
const maxTrusted = 32

var errUsage = errors.New("usage")

type Options struct {
	Port     int
	CertPath string
	KeyPath  string
	Vendor   string
	Brand    string
	Model    string
	Serial   string
	// Role nimmt ship-go nicht entgegen (es lauscht und verbindet sich immer);
	// der Wert wird nur angenommen, damit DVhub unverändert starten kann.
	Role  string
	Trust []string
	// Mdns: auto (Avahi über D-Bus, sonst Go-Zeroconf), avahi, zeroconf.
	// Nicht in der C-Bridge; Umgebungsvariable DVHUB_EEBUS_MDNS.
	Mdns string
}

type certArgs struct {
	Cert, Key, CN string
}

func defaultOptions() Options {
	mdns := os.Getenv("DVHUB_EEBUS_MDNS")
	if mdns == "" {
		mdns = "auto"
	}
	return Options{
		Port:   4712,
		Vendor: "DVhub",
		Brand:  "DVhub",
		Model:  "DVhub",
		Serial: "0",
		Role:   "auto",
		Mdns:   mdns,
	}
}

func parseArgs(args []string) (Options, *certArgs, error) {
	o := defaultOptions()
	if len(args) >= 1 && args[0] == "--gen-cert" {
		if len(args) != 4 {
			return o, nil, errUsage
		}
		return o, &certArgs{Cert: args[1], Key: args[2], CN: args[3]}, nil
	}
	for i := 0; i < len(args); i += 2 {
		if i+1 >= len(args) {
			return o, nil, errUsage
		}
		a, v := args[i], args[i+1]
		switch a {
		case "--port":
			// atoi wie main.c: Unsinn ergibt 0 und scheitert an der Bereichsprüfung.
			p, err := strconv.Atoi(v)
			if err != nil {
				p = 0
			}
			o.Port = p
		case "--cert":
			o.CertPath = v
		case "--key":
			o.KeyPath = v
		case "--vendor":
			o.Vendor = v
		case "--brand":
			o.Brand = v
		case "--model":
			o.Model = v
		case "--serial":
			o.Serial = v
		case "--role":
			o.Role = v
		case "--trust":
			if len(o.Trust) < maxTrusted {
				o.Trust = append(o.Trust, v)
			}
		default:
			return o, nil, errUsage
		}
	}
	if o.CertPath == "" || o.KeyPath == "" || o.Port <= 0 || o.Port > 65535 {
		return o, nil, errUsage
	}
	return o, nil, nil
}
