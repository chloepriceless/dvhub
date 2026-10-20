// dvhub-eebus (Go) — EEBUS-Knoten von DVhub auf enbility eebus-go (MIT).
//
// Gepinnt auf den dev-Stand von eebus-go vom 30.09.2026 (Pseudo-Version, fest
// über go.sum): erst dieser Stand enthält GCP MGCP und CEM OHPCF, die das
// letzte Release v0.7.0 (09/2024) nicht hat. ship-go/spine-go folgen eebus-go.
// Neue Version: Pseudo-Versionen hier ändern, `go mod tidy`, build-go.sh, Tests.
module dvhub-eebus

go 1.24.1

require (
	github.com/enbility/eebus-go v0.7.1-0.20260930170458-8583642861c3
	github.com/enbility/ship-go v0.6.1-0.20260518113001-134687068e3c
	github.com/enbility/spine-go v0.7.1-0.20260520153416-0104ce40c885
)

require (
	github.com/enbility/go-avahi v0.0.0-20240909195612-d5de6b280d7a // indirect
	github.com/enbility/zeroconf/v2 v2.0.0-20240920094356-be1cae74fda6 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/golanguzb70/lrucache v1.2.0 // indirect
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/govalues/decimal v0.1.36 // indirect
	github.com/miekg/dns v1.1.72 // indirect
	github.com/rickb777/period v1.0.22 // indirect
	github.com/rickb777/plural v1.4.7 // indirect
	gitlab.com/c0b/go-ordered-json v0.0.0-20201030195603-febf46534d5a // indirect
	golang.org/x/mod v0.33.0 // indirect
	golang.org/x/net v0.50.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
	golang.org/x/sys v0.41.0 // indirect
	golang.org/x/tools v0.42.0 // indirect
)
