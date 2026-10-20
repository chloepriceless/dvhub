package main

// dvhub-eebus (Go, enbility eebus-go) — EEBUS-Knoten von DVhub.
//
// Lokales SPINE-Gerät "EnergyManagementSystem" mit vier Entitäten, wie die
// C-Bridge (bridge/bridge.h):
//
//	[1] CEM — Netzseite, CS LPC (§14a-Steuerbox; DVhub ist das Controllable System)
//	[2] CEM — Netzseite, CS LPP (Einspeisegrenze); eigene Entität wie in bridge.c
//	[3] CEM — Geräteseite: EG LPC + EG LPP, MA MPC, CEM OHPCF und neu die
//	          E-Auto-Anwendungsfälle EVCC, EVCEM, EVSOC, OPEV, OSCEV, CEVC
//	[4] GridConnectionPointOfPremises — GCP MGCP (DVhubs Netzzähler)
//
// DVhub trifft alle Entscheidungen; dieser Prozess spricht nur das Protokoll.

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	eebusapi "github.com/enbility/eebus-go/api"
	"github.com/enbility/eebus-go/service"
	ucapi "github.com/enbility/eebus-go/usecases/api"
	cemcevc "github.com/enbility/eebus-go/usecases/cem/cevc"
	cemevcc "github.com/enbility/eebus-go/usecases/cem/evcc"
	cemevcem "github.com/enbility/eebus-go/usecases/cem/evcem"
	cemevsoc "github.com/enbility/eebus-go/usecases/cem/evsoc"
	cemohpcf "github.com/enbility/eebus-go/usecases/cem/ohpcf"
	cemopev "github.com/enbility/eebus-go/usecases/cem/opev"
	cemoscev "github.com/enbility/eebus-go/usecases/cem/oscev"
	cslpc "github.com/enbility/eebus-go/usecases/cs/lpc"
	cslpp "github.com/enbility/eebus-go/usecases/cs/lpp"
	eglpc "github.com/enbility/eebus-go/usecases/eg/lpc"
	eglpp "github.com/enbility/eebus-go/usecases/eg/lpp"
	gcpmgcp "github.com/enbility/eebus-go/usecases/gcp/mgcp"
	mampc "github.com/enbility/eebus-go/usecases/ma/mpc"
	shipapi "github.com/enbility/ship-go/api"
	"github.com/enbility/ship-go/mdns"
	spineapi "github.com/enbility/spine-go/api"
	"github.com/enbility/spine-go/model"
	"github.com/enbility/spine-go/spine"
	"github.com/enbility/spine-go/util"
)

const (
	// Herzschlag der Netzseite und des Netzanschlusspunkts (bridge.c: 60 s).
	gridHeartbeatTimeout = 60 * time.Second
	// Herzschlag der Geräteseite: 4 s, weil Wallboxen mit OPEV/OSCEV (z. B. Elli)
	// den Wert als Frist werten und sonst in den Rückfallbetrieb gehen. Neu
	// gegenüber bridge.c (60 s); LPC erlaubt jeden Wert bis 60 s.
	deviceHeartbeatTimeout = 4 * time.Second
)

// Kennzeichen der verfolgten entfernten Entitäten je Anwendungsfall.
type remoteTag string

const (
	tagCsLPC remoteTag = "cs_lpc"
	tagCsLPP remoteTag = "cs_lpp"
	tagEgLPC remoteTag = "eg_lpc"
	tagEgLPP remoteTag = "eg_lpp"
	tagMPC   remoteTag = "mpc"
	tagOHPCF remoteTag = "ohpcf"
	tagEV    remoteTag = "ev"
	tagEVCEM remoteTag = "evcem"
	tagEVSOC remoteTag = "evsoc"
	tagOPEV  remoteTag = "opev"
	tagOSCEV remoteTag = "oscev"
	tagCEVC  remoteTag = "cevc"
)

// Meldungen beim Erscheinen/Verschwinden einer Entität (bridge.c EntityEvent).
var tagEvents = map[remoteTag]struct{ uc, added, removed string }{
	tagCsLPC: {"lpc", "grid_eg_added", "grid_eg_removed"},
	tagCsLPP: {"lpp", "grid_eg_added", "grid_eg_removed"},
	tagEgLPC: {"lpc", "device_added", "device_removed"},
	tagEgLPP: {"lpp", "device_added", "device_removed"},
	tagMPC:   {"mpc", "device_added", "device_removed"},
	tagOHPCF: {"ohpcf", "device_added", "device_removed"},
}

type remoteEntry struct {
	ski    string
	entity spineapi.EntityRemoteInterface
}

// evLimitsRW: Stromgrenzen fürs Auto lesen und schreiben (OPEV und OSCEV).
type evLimitsRW interface {
	CurrentLimits(entity spineapi.EntityRemoteInterface) ([]float64, []float64, []float64, error)
	LoadControlLimits(entity spineapi.EntityRemoteInterface) ([]ucapi.LoadLimitsPhase, error)
	WriteLoadControlLimits(entity spineapi.EntityRemoteInterface, limits []ucapi.LoadLimitsPhase,
		resultCB func(result model.ResultDataType, msgCounter model.MsgCounterType)) (*model.MsgCounterType, error)
}

type Bridge struct {
	out    *Out
	opts   Options
	svc    eebusapi.ServiceInterface
	shipID string

	devEntity spineapi.EntityLocalInterface

	csLPC ucapi.CsLPCInterface
	csLPP ucapi.CsLPPInterface
	egLPC ucapi.EgLPCInterface
	egLPP ucapi.EgLPPInterface
	maMPC ucapi.MaMPCInterface
	ohpcf ucapi.CemOHPCFInterface
	mgcp  ucapi.GcpMGCPInterface
	evcc  ucapi.CemEVCCInterface
	evcem ucapi.CemEVCEMInterface
	evsoc ucapi.CemEVSOCInterface
	opev  ucapi.CemOPEVInterface
	oscev ucapi.CemOSCEVInterface
	cevc  ucapi.CemCEVCInterface

	evWriters map[string]evLimitsRW

	mu             sync.Mutex
	remotes        map[remoteTag]map[string]remoteEntry
	handled        map[string]bool
	hbCount        map[string]uint64
	lastHB         [2]int // -1 unbekannt, 0 verloren, 1 ok
	devHeartbeatOn bool
	shipIDs        map[string]string
	lastOhpcf      map[string]string
}

func NewBridge(out *Out, opts Options) *Bridge {
	return &Bridge{
		out:       out,
		opts:      opts,
		shipID:    fmt.Sprintf("%s-%s-%s", opts.Brand, opts.Model, opts.Serial),
		remotes:   map[remoteTag]map[string]remoteEntry{},
		handled:   map[string]bool{},
		hbCount:   map[string]uint64{},
		lastHB:    [2]int{-1, -1},
		shipIDs:   map[string]string{},
		lastOhpcf: map[string]string{},
		evWriters: map[string]evLimitsRW{},
	}
}

func normSki(ski string) string { return strings.ToLower(strings.TrimSpace(ski)) }

func skiOfEntity(e spineapi.EntityRemoteInterface) string {
	if e == nil || e.Device() == nil {
		return ""
	}
	return normSki(e.Device().Ski())
}

func keyOfEntity(e spineapi.EntityRemoteInterface) string {
	if e == nil {
		return ""
	}
	return entityKey(e.Address())
}

// entityEvent: {"ev": name, "uc": uc, "entity": key, "ski": ski} wie bridge.c EntityEvent.
func entityEvent(name, uc, key, ski string) *Obj {
	return newEvent(name).Str("uc", uc).Str("entity", key).StrIf("ski", ski)
}

// --- Aufbau -------------------------------------------------------------------

func mdnsSelection(s string) mdns.MdnsProviderSelection {
	switch s {
	case "avahi":
		return mdns.MdnsProviderSelectionAvahiOnly
	case "zeroconf":
		return mdns.MdnsProviderSelectionGoZeroConfOnly
	}
	return mdns.MdnsProviderSelectionAll
}

func (b *Bridge) newLocalEntity(local spineapi.DeviceLocalInterface, t model.EntityTypeType, hb time.Duration) spineapi.EntityLocalInterface {
	id := model.AddressEntityType(len(local.Entities()))
	e := spine.NewEntityLocal(local, t, []model.AddressEntityType{id}, hb)
	local.AddEntity(e)
	return e
}

// setup baut Dienst, Entitäten und Anwendungsfälle auf, ohne zu lauschen.
func (b *Bridge) setup() error {
	cert, _, err := loadCertificate(b.opts.CertPath, b.opts.KeyPath)
	if err != nil {
		b.out.Logf("cannot load certificate %s / key %s: %v", b.opts.CertPath, b.opts.KeyPath, err)
		return err
	}
	if b.opts.Role != "" && b.opts.Role != "auto" {
		b.out.Logf("--role %s: ship-go lauscht und verbindet immer selbst, Angabe ignoriert", b.opts.Role)
	}
	cfg, err := eebusapi.NewConfiguration(
		b.opts.Vendor, b.opts.Brand, b.opts.Model, b.opts.Serial,
		[]shipapi.DeviceCategoryType{shipapi.DeviceCategoryTypeEnergyManagementSystem},
		model.DeviceTypeTypeEnergyManagementSystem,
		[]model.EntityTypeType{model.EntityTypeTypeCEM, model.EntityTypeTypeCEM},
		b.opts.Port, cert, gridHeartbeatTimeout, nil, nil,
	)
	if err != nil {
		return err
	}
	cfg.SetAlternateIdentifier(b.shipID)
	cfg.SetMdnsProviderSelection(mdnsSelection(b.opts.Mdns))

	svc := service.NewService(cfg, b)
	svc.SetLogging(&stderrLogger{out: b.out, debug: os.Getenv("DVHUB_EEBUS_DEBUG") != ""})
	if err := svc.Setup(); err != nil {
		b.out.Logf("service setup failed: %v", err)
		return err
	}
	b.svc = svc
	local := svc.LocalDevice()
	ents := local.Entities()
	if len(ents) < 3 {
		return errors.New("grid entities missing")
	}
	gridLPC, gridLPP := ents[1], ents[2]
	b.devEntity = b.newLocalEntity(local, model.EntityTypeTypeCEM, deviceHeartbeatTimeout)
	gcpEntity := b.newLocalEntity(local, model.EntityTypeTypeGridConnectionPointOfPremises, gridHeartbeatTimeout)

	// [1]/[2] Netzseite — LPC und LPP je eigene Entität (bridge.c AddGridSide).
	csLPC := cslpc.NewLPC(gridLPC, b.onCsLPC)
	csLPP := cslpp.NewLPP(gridLPP, b.onCsLPP)
	b.csLPC, b.csLPP = csLPC, csLPP

	// [3] Geräteseite
	dev := b.devEntity
	egLPC := eglpc.NewLPC(dev, b.onEgLPC)
	egLPP := eglpp.NewLPP(dev, b.onEgLPP)
	maMPC := mampc.NewMPC(dev, b.onMPC)
	ohpcf := cemohpcf.NewOHPCF(dev, b.onOHPCF)
	evcc := cemevcc.NewEVCC(svc, dev, b.onEVCC)
	evcem := cemevcem.NewEVCEM(svc, dev, b.onEVCEM)
	evsoc := cemevsoc.NewEVSOC(dev, b.onEVSOC)
	opev := cemopev.NewOPEV(dev, b.onOPEV)
	oscev := cemoscev.NewOSCEV(dev, b.onOSCEV)
	cevc := cemcevc.NewCEVC(dev, b.onCEVC)
	b.egLPC, b.egLPP, b.maMPC, b.ohpcf = egLPC, egLPP, maMPC, ohpcf
	b.evcc, b.evcem, b.evsoc, b.opev, b.oscev, b.cevc = evcc, evcem, evsoc, opev, oscev, cevc
	b.evWriters = map[string]evLimitsRW{"opev": opev, "oscev": oscev}

	// [4] Netzanschlusspunkt. DVhub kennt Leistung und (selbst aufsummierte)
	// Zählerstände, aber keine Phasenströme, Spannungen oder Frequenz — daher nur
	// Leistung (MGCP Szenario 2) und Energie (3 und 4), wie bridge.c.
	mgcp, err := gcpmgcp.NewMGCP(gcpEntity, nil, nil,
		&gcpmgcp.MonitorPowerConfig{ValueSource: util.Ptr(model.MeasurementValueSourceTypeMeasuredValue)},
		&gcpmgcp.MonitorEnergyConfig{
			ValueSourceProduction:  util.Ptr(model.MeasurementValueSourceTypeCalculatedValue),
			ValueSourceConsumption: util.Ptr(model.MeasurementValueSourceTypeCalculatedValue),
		}, nil, nil, nil)
	if err != nil {
		return err
	}
	// eebus-go (Stand 30.09.2026) meldet MGCP mit dem Akteur "MonitoringAppliance";
	// richtig (und wie openeebus) ist "GridConnectionPoint" — sonst findet eine
	// Steuerbox den Netzanschlusspunkt nicht (integration_test.go).
	mgcp.UseCaseActor = model.UseCaseActorTypeGridConnectionPoint
	b.mgcp = mgcp

	for _, uc := range []eebusapi.UseCaseInterface{csLPC, csLPP, egLPC, egLPP, maMPC, ohpcf, evcc, evcem, evsoc, opev, oscev, cevc, mgcp} {
		if err := svc.AddUseCase(uc); err != nil {
			b.out.Logf("use case creation failed: %v", err)
			return err
		}
	}

	// Ein Controllable System veröffentlicht seinen (inaktiven) Grenzeintrag selbst.
	noLimit := ucapi.LoadLimit{Value: 0, IsActive: false, IsChangeable: true}
	if csLPC.SetConsumptionLimit(noLimit) != nil || csLPP.SetProductionLimit(noLimit) != nil {
		b.out.Logf("grid side: initial limit entry failed")
		return errors.New("initial limit entry failed")
	}
	_ = mgcp.Update(mgcp.UpdateDataPowerTotal(0, nil, nil))

	// Herzschlag der Geräteseite erst mit der ersten Vorgabe an ein Gerät (bridge.c
	// CmdDeviceLimit); spine-go startet ihn sonst gleich beim Anlegen.
	if hm := dev.HeartbeatManager(); hm != nil {
		hm.StopHeartbeat()
	}
	_ = local.Events().Subscribe(&ohpcfWatcher{b: b})

	svc.UserIsAbleToApproveOrCancelPairingRequests(false)
	return nil
}

// Start: Aufbau, lauschen, "ready" melden, Vertrauensliste übernehmen.
func (b *Bridge) Start() error {
	if err := b.setup(); err != nil {
		return err
	}
	if err := b.svc.Start(); err != nil {
		b.out.Logf("service start failed: %v", err)
		return err
	}
	b.out.Emit(b.readyEvent())
	for _, ski := range b.opts.Trust {
		b.HandleCommand(newCommand(map[string]any{"cmd": "trust", "ski": ski}))
	}
	return nil
}

func (b *Bridge) Stop() {
	if b.svc != nil {
		b.svc.Shutdown()
	}
}

func (b *Bridge) localSKI() string {
	if b.svc == nil || b.svc.LocalService() == nil {
		return ""
	}
	return normSki(b.svc.LocalService().SKI())
}

func (b *Bridge) readyEvent() *Obj {
	ev := newEvent("ready").Str("ski", b.localSKI()).Str("ship_id", b.shipID).Int("port", int64(b.opts.Port))
	if b.svc != nil {
		if qr, err := b.svc.QRCodeText(); err == nil && qr != "" {
			ev.Str("qr", qr)
		}
	}
	return ev
}

// --- entfernte Entitäten --------------------------------------------------------

// syncRemotes gleicht die bekannten Entitäten eines Anwendungsfalls mit eebus-go
// ab und meldet neue und verschwundene.
func (b *Bridge) syncRemotes(tag remoteTag, base eebusapi.UseCaseBaseInterface) {
	cur := map[string]remoteEntry{}
	for _, rs := range base.RemoteEntitiesScenarios() {
		if rs.Entity == nil || len(rs.Scenarios) == 0 {
			continue
		}
		cur[keyOfEntity(rs.Entity)] = remoteEntry{ski: skiOfEntity(rs.Entity), entity: rs.Entity}
	}
	b.applyRemotes(tag, cur)
}

// applyRemotes übernimmt den neuen Stand eines Anwendungsfalls und meldet die Änderungen.
func (b *Bridge) applyRemotes(tag remoteTag, cur map[string]remoteEntry) {
	type change struct{ key, ski string }
	var added, removed []change
	// Unterschied unter dem Mutex berechnen und kopieren: cur liegt danach in b.remotes,
	// und dropSki/rememberEV (eigene Goroutinen von spine-go) ändern die Map dort.
	b.mu.Lock()
	old := b.remotes[tag]
	b.remotes[tag] = cur
	for k, e := range cur {
		if _, ok := old[k]; !ok {
			added = append(added, change{k, e.ski})
		}
	}
	for k, e := range old {
		if _, ok := cur[k]; !ok {
			removed = append(removed, change{k, e.ski})
		}
	}
	b.mu.Unlock()
	sort.Slice(added, func(i, j int) bool { return added[i].key < added[j].key })
	sort.Slice(removed, func(i, j int) bool { return removed[i].key < removed[j].key })
	info, ok := tagEvents[tag]
	if !ok {
		return
	}
	for _, c := range removed {
		b.out.Emit(entityEvent(info.removed, info.uc, c.key, c.ski))
	}
	for _, c := range added {
		b.out.Emit(entityEvent(info.added, info.uc, c.key, c.ski))
	}
}

func (b *Bridge) rememberEV(tag remoteTag, ski, key string, e spineapi.EntityRemoteInterface) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.remotes[tag] == nil {
		b.remotes[tag] = map[string]remoteEntry{}
	}
	_, had := b.remotes[tag][key]
	b.remotes[tag][key] = remoteEntry{ski: ski, entity: e}
	return !had
}

func (b *Bridge) forget(tag remoteTag, key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, had := b.remotes[tag][key]
	delete(b.remotes[tag], key)
	return had
}

// lookup sucht eine Entität über ihren Schlüssel oder, ohne Schlüssel, die erste der SKI.
func (b *Bridge) lookup(tag remoteTag, key, ski string) (remoteEntry, string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	m := b.remotes[tag]
	if key != "" {
		e, ok := m[key]
		return e, key, ok
	}
	ski = normSki(ski)
	if ski == "" {
		return remoteEntry{}, "", false
	}
	keys := make([]string, 0, len(m))
	for k, e := range m {
		if e.ski == ski {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return remoteEntry{}, "", false
	}
	sort.Strings(keys)
	return m[keys[0]], keys[0], true
}

// dropSki entfernt alle Entitäten einer getrennten Gegenstelle und meldet sie ab.
func (b *Bridge) dropSki(ski string) {
	type gone struct {
		tag remoteTag
		key string
	}
	var list []gone
	b.mu.Lock()
	for tag, m := range b.remotes {
		for k, e := range m {
			if e.ski == ski {
				list = append(list, gone{tag, k})
				delete(m, k)
			}
		}
	}
	for k := range b.lastOhpcf {
		if strings.HasPrefix(k, ski+"|") {
			delete(b.lastOhpcf, k)
		}
	}
	b.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		if list[i].tag != list[j].tag {
			return list[i].tag < list[j].tag
		}
		return list[i].key < list[j].key
	})
	for _, g := range list {
		if info, ok := tagEvents[g.tag]; ok {
			b.out.Emit(entityEvent(info.removed, info.uc, g.key, ski))
		} else if g.tag == tagEV {
			b.out.Emit(newEvent("ev_disconnected").Str("ski", ski).Str("entity", g.key))
		}
	}
}

func (b *Bridge) startDeviceHeartbeat() {
	b.mu.Lock()
	started := b.devHeartbeatOn
	b.devHeartbeatOn = true
	b.mu.Unlock()
	if started || b.devEntity == nil {
		return
	}
	if hm := b.devEntity.HeartbeatManager(); hm != nil {
		_ = hm.StartHeartbeat()
	}
}

// --- Verbindungen (eebus-go ServiceReaderInterface) ------------------------------

var _ eebusapi.ServiceReaderInterface = (*Bridge)(nil)

func (b *Bridge) noteShipID(ski, shipID string) {
	if ski == "" || shipID == "" {
		return
	}
	b.mu.Lock()
	same := b.shipIDs[ski] == shipID
	b.shipIDs[ski] = shipID
	b.mu.Unlock()
	if !same {
		b.out.Emit(newEvent("ship_id").Str("ski", ski).Str("ship_id", shipID))
	}
}

func (b *Bridge) RemoteServiceConnected(_ eebusapi.ServiceInterface, id shipapi.ServiceIdentity) {
	ski := normSki(id.SKI)
	b.out.EmitSki("connected", ski)
	b.noteShipID(ski, id.ShipID)
}

func (b *Bridge) RemoteServiceDisconnected(_ eebusapi.ServiceInterface, id shipapi.ServiceIdentity) {
	ski := normSki(id.SKI)
	b.out.EmitSki("disconnected", ski)
	b.dropSki(ski)
}

func (b *Bridge) VisibleRemoteMdnsServicesUpdated(_ eebusapi.ServiceInterface, entries []shipapi.RemoteMdnsService) {
	b.out.Emit(mdnsEvent(entries))
}

// mdnsEvent: wie bridge.c OnRemoteServicesUpdate. ship-go gibt Host, Port und
// "register" nicht heraus — diese Felder fehlen (DVhub zeigt dann nichts an).
func mdnsEvent(entries []shipapi.RemoteMdnsService) *Obj {
	list := []*Obj{}
	for _, e := range entries {
		list = append(list, newObj().StrIf("ski", normSki(e.Ski)).StrIf("name", e.Name).StrIf("id", e.ShipID).
			StrIf("brand", e.Brand).StrIf("model", e.Model).StrIf("type", e.Type).StrIf("serial", e.Serial))
	}
	return newEvent("mdns").Any("services", list)
}

func (b *Bridge) ServiceUpdated(id shipapi.ServiceIdentity) {
	b.noteShipID(normSki(id.SKI), id.ShipID)
}

func (b *Bridge) ServicePairingDetailUpdate(id shipapi.ServiceIdentity, detail *shipapi.ConnectionStateDetail) {
	if detail == nil {
		return
	}
	b.out.Emit(shipStateEvent(normSki(id.SKI), detail.State()))
}

// shipStateEvent: wie bridge.c OnShipStateUpdate; "state" ist hier der
// ship-go-Verbindungszustand (nicht openeebus' SmeState), DVhub nutzt nur "label".
func shipStateEvent(ski string, st shipapi.ConnectionState) *Obj {
	ev := newEvent("ship_state").StrIf("ski", ski).Int("state", int64(st))
	switch st {
	case shipapi.ConnectionStateReceivedPairingRequest:
		ev.Str("label", "waiting_trust")
	case shipapi.ConnectionStateRemoteDeniedTrust, shipapi.ConnectionStateError:
		ev.Str("label", "rejected")
	}
	return ev
}

func (b *Bridge) ServiceAutoTrusted(_ eebusapi.ServiceInterface, id shipapi.ServiceIdentity) {
	b.out.Logf("auto trusted %s", id.SKI)
}

func (b *Bridge) ServiceAutoTrustFailed(_ eebusapi.ServiceInterface, id shipapi.ServiceIdentity, reason error) {
	b.out.Logf("auto trust failed %s: %v", id.SKI, reason)
}

func (b *Bridge) ServiceAutoTrustRemoved(_ eebusapi.ServiceInterface, id shipapi.ServiceIdentity, reason string) {
	b.out.Logf("auto trust removed %s: %s", id.SKI, reason)
}

// --- Befehle --------------------------------------------------------------------

func (b *Bridge) reply(c *Command, ok bool, errMsg string) {
	b.out.Emit(replyEvent(c, ok, errMsg))
}

// writeResultCB meldet das Ergebnis eines Schreibvorgangs an ein Gerät (bridge.c WriteResult).
func (b *Bridge) writeResultCB(c *Command) func(model.ResultDataType, model.MsgCounterType) {
	id := c.CtxID()
	return func(result model.ResultDataType, _ model.MsgCounterType) {
		ok := result.ErrorNumber == nil || *result.ErrorNumber == model.ErrorNumberTypeNoError
		b.out.Emit(newEvent("write_result").Int("id", id).Bool("ok", ok))
	}
}

func (b *Bridge) HandleCommand(c *Command) {
	name, ok := c.Str("cmd")
	if !ok {
		b.reply(c, false, "no command")
		return
	}
	if name == "ev_current_limits" {
		b.cmdEvCurrentLimits(c)
		return
	}
	if b.svc == nil {
		b.reply(c, false, "no command")
		return
	}
	switch name {
	case "trust", "untrust":
		b.cmdTrust(c, name == "trust")
	case "pairing":
		b.svc.UserIsAbleToApproveOrCancelPairingRequests(c.Bool("on", false))
		b.reply(c, true, "")
	case "cancel_pairing":
		ski, has := c.Str("ski")
		if has {
			b.svc.CancelPairing(shipapi.NewServiceIdentity(ski, "", ""))
			b.reply(c, true, "")
		} else {
			b.reply(c, false, "ski missing")
		}
	case "grid_config":
		b.cmdGridConfig(c)
	case "grid_limit_state":
		b.cmdGridLimitState(c)
	case "gcp":
		b.cmdGcp(c)
	case "device_limit":
		b.cmdDeviceLimit(c)
	case "device_failsafe":
		b.cmdDeviceFailsafe(c)
	case "ohpcf":
		b.cmdOhpcf(c)
	case "status":
		b.cmdStatus(c)
	default:
		b.reply(c, false, "unknown command")
	}
}

func (b *Bridge) cmdTrust(c *Command, trust bool) {
	ski, _ := c.Str("ski")
	if len(ski) != 40 {
		b.reply(c, false, "ski must be 40 hex characters")
		return
	}
	id := shipapi.NewServiceIdentity(ski, "", "")
	if trust {
		b.svc.RegisterRemoteService(id)
	} else {
		b.svc.UnregisterRemoteService(id)
	}
	b.reply(c, true, "")
}

// Tick: Herzschlag-Zustand der Netzseite, alle ~5 s (bridge.c BridgeTick).
func (b *Bridge) Tick() {
	if b.csLPC == nil || b.csLPP == nil {
		return
	}
	lpc, lpp := 0, 0
	if b.csLPC.IsHeartbeatWithinDuration() {
		lpc = 1
	}
	if b.csLPP.IsHeartbeatWithinDuration() {
		lpp = 1
	}
	b.mu.Lock()
	changed := lpc != b.lastHB[0] || lpp != b.lastHB[1]
	b.lastHB = [2]int{lpc, lpp}
	b.mu.Unlock()
	if changed {
		b.out.Emit(newEvent("grid_heartbeat_state").Bool("lpc_ok", lpc == 1).Bool("lpp_ok", lpp == 1))
	}
}
