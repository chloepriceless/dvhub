/*
 * dvhub-eebus — EEBUS node of DVhub. See bridge.h for the entity layout and
 * main.c for the stdin/stdout protocol.
 */
#include "bridge.h"

#include <inttypes.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "out.h"
#include "src/common/array_util.h"
#include "src/common/eebus_date_time/eebus_date_time.h"
#include "src/common/eebus_date_time/eebus_duration.h"
#include "src/common/eebus_errors.h"
#include "src/common/eebus_malloc.h"
#include "src/common/entity_address_list.h"
#include "src/common/string_util.h"
#include "src/common/vector.h"
#include "src/service/api/service_reader_interface.h"
#include "src/service/service/eebus_service.h"
#include "src/ship/api/mdns_entry.h"
#include "src/ship/tls_certificate/tls_certificate.h"
#include "src/spine/api/device_local_interface.h"
#include "src/spine/api/device_remote_interface.h"
#include "src/spine/entity/entity_local.h"
#include "src/spine/model/result_types.h"
#include "src/use_case/actor/cem/ohpcf/cem_ohpcf.h"
#include "src/use_case/actor/cs/cs_lp.h"
#include "src/use_case/actor/cs/lpc/cs_lpc.h"
#include "src/use_case/actor/cs/lpp/cs_lpp.h"
#include "src/use_case/actor/eg/eg_lp.h"
#include "src/use_case/actor/eg/lpc/eg_lpc.h"
#include "src/use_case/actor/eg/lpp/eg_lpp.h"
#include "src/use_case/actor/gcp/mgcp/gcp_mgcp.h"
#include "src/use_case/actor/ma/mpc/ma_mpc.h"
#include "src/use_case/api/cem_ohpcf_listener_interface.h"
#include "src/use_case/api/cs_lp_listener_interface.h"
#include "src/use_case/api/cs_lpc_approver_interface.h"
#include "src/use_case/api/eg_lp_listener_interface.h"
#include "src/use_case/api/ma_mpc_listener_interface.h"
#include "src/use_case/model/scaled_value.h"

static const uint32_t kHeartbeatTimeoutSeconds        = 60;
static const ElectricalConnectionIdType kConnectionId = 0;

//-------------------------------------------------------------------------------------------//
// Small helpers
//-------------------------------------------------------------------------------------------//

static double ScaledToDouble(const ScaledValue* v) {
  double d = 0.0;
  if (v != NULL) {
    ScaledValueToDouble(v, &d);
  }
  return d;
}

static ScaledValue DoubleToScaled(double d) {
  ScaledValue v = {0};
  ScaledValueWithDouble(&v, d);
  return v;
}

static int64_t DurationSeconds(const DurationType* d) {
  return d != NULL ? EebusDurationToSeconds(d) : 0;
}

static EebusDuration SecondsToDuration(int64_t seconds) {
  EebusDuration d = {0};
  if (seconds < 0) {
    seconds = 0;
  }
  d.hours   = (int32_t)(seconds / 3600);
  d.minutes = (int32_t)((seconds % 3600) / 60);
  d.seconds = (int32_t)(seconds % 60);
  return d;
}

// "d:_n:NIBE_123/1/1" — stable key DVhub uses to address a remote entity.
static void EntityKey(const EntityAddressType* addr, char* buf, size_t size) {
  int pos = snprintf(buf, size, "%s", addr != NULL && addr->device != NULL ? addr->device : "");
  for (size_t i = 0; addr != NULL && i < addr->entity_size && pos > 0 && (size_t)pos < size; ++i) {
    if (addr->entity[i] != NULL) {
      pos += snprintf(buf + pos, size - (size_t)pos, "/%" PRIu32, *addr->entity[i]);
    }
  }
}

//-------------------------------------------------------------------------------------------//
// Bridge state
//-------------------------------------------------------------------------------------------//

typedef struct Listener Listener;

typedef enum UseCaseTag {
  kUcCsLpc,
  kUcCsLpp,
  kUcEgLpc,
  kUcEgLpp,
  kUcMaMpc,
  kUcCemOhpcf,
} UseCaseTag;

static const char* UcName(UseCaseTag tag) {
  switch (tag) {
    case kUcCsLpc: return "lpc";
    case kUcCsLpp: return "lpp";
    case kUcEgLpc: return "lpc";
    case kUcEgLpp: return "lpp";
    case kUcMaMpc: return "mpc";
    case kUcCemOhpcf: return "ohpcf";
  }
  return "?";
}

typedef struct Bridge Bridge;

struct Bridge {
  ServiceReaderObject service_reader;  // must be first ("inherits" the reader)
  EebusServiceConfig* cfg;
  EebusServiceObject* service;
  TlsCertificateObject* tls;

  // grid side (entity 1)
  CsLpUseCaseObject* cs_lpc;
  CsLpUseCaseObject* cs_lpp;
  // device side (entity 2)
  EgLpUseCaseObject* eg_lpc;
  EgLpUseCaseObject* eg_lpp;
  MaMpcUseCaseObject* ma_mpc;
  CemOhpcfUseCaseObject* cem_ohpcf;
  // grid connection point (entity 3)
  GcpMgcpUseCaseObject* gcp_mgcp;

  // remote entities per device-side use case, guarded by `mutex`
  EntityAddressList eg_lpc_remotes;
  EntityAddressList eg_lpp_remotes;
  EntityAddressList ma_mpc_remotes;
  EntityAddressList ohpcf_remotes;
  pthread_mutex_t mutex;

  bool eg_heartbeat_started;
  int last_lpc_heartbeat_ok;  // -1 unknown, 0 lost, 1 ok
  int last_lpp_heartbeat_ok;
};

static Bridge bridge;

//-------------------------------------------------------------------------------------------//
// Remote SKI of an entity (for events)
//-------------------------------------------------------------------------------------------//

static const char* SkiOfEntity(const EntityAddressType* addr) {
  if (bridge.service == NULL || addr == NULL || addr->device == NULL) {
    return NULL;
  }
  DeviceLocalObject* const local = EEBUS_SERVICE_GET_LOCAL_DEVICE(bridge.service);
  DeviceRemoteObject* const rdev = DEVICE_LOCAL_GET_REMOTE_DEVICE_WITH_ADDRESS(local, addr->device);
  return rdev != NULL ? DEVICE_REMOTE_GET_SKI(rdev) : NULL;
}

static cJSON* EntityEvent(const char* name, UseCaseTag uc, const EntityAddressType* addr) {
  cJSON* ev = OutEvent(name);
  if (ev == NULL) {
    return NULL;
  }
  char key[256];
  EntityKey(addr, key, sizeof(key));
  cJSON_AddStringToObject(ev, "uc", UcName(uc));
  cJSON_AddStringToObject(ev, "entity", key);
  const char* ski = SkiOfEntity(addr);
  if (ski != NULL) {
    cJSON_AddStringToObject(ev, "ski", ski);
  }
  return ev;
}

static EntityAddressList* RemotesFor(UseCaseTag uc) {
  switch (uc) {
    case kUcEgLpc: return &bridge.eg_lpc_remotes;
    case kUcEgLpp: return &bridge.eg_lpp_remotes;
    case kUcMaMpc: return &bridge.ma_mpc_remotes;
    case kUcCemOhpcf: return &bridge.ohpcf_remotes;
    default: return NULL;
  }
}

static void RemoteAdd(UseCaseTag uc, const EntityAddressType* addr) {
  EntityAddressList* list = RemotesFor(uc);
  if (list == NULL) {
    return;
  }
  pthread_mutex_lock(&bridge.mutex);
  EntityAddressListAdd(list, addr);
  pthread_mutex_unlock(&bridge.mutex);
}

static void RemoteRemove(UseCaseTag uc, const EntityAddressType* addr) {
  EntityAddressList* list = RemotesFor(uc);
  if (list == NULL) {
    return;
  }
  pthread_mutex_lock(&bridge.mutex);
  EntityAddressListRemove(list, addr);
  pthread_mutex_unlock(&bridge.mutex);
}

// Copy of the stored address for `key` (caller frees with EntityAddressDelete), or NULL.
static EntityAddressType* RemoteFind(UseCaseTag uc, const char* key) {
  EntityAddressList* list = RemotesFor(uc);
  if (list == NULL || key == NULL) {
    return NULL;
  }
  EntityAddressType* found = NULL;
  pthread_mutex_lock(&bridge.mutex);
  for (size_t i = 0; i < EntityAddressListGetSize(list); ++i) {
    const EntityAddressType* addr = EntityAddressListGet(list, i);
    char k[256];
    EntityKey(addr, k, sizeof(k));
    if (strcmp(k, key) == 0) {
      found = EntityAddressCopy(addr);
      break;
    }
  }
  pthread_mutex_unlock(&bridge.mutex);
  return found;
}

//-------------------------------------------------------------------------------------------//
// Grid side: CS LPC / CS LPP listener + write approver
//-------------------------------------------------------------------------------------------//

struct Listener {
  union {
    CsLpListenerObject cs;
    EgLpListenerObject eg;
    MaMpcListenerObject ma;
    CemOhpcfListenerObject cem;
    CsLpcApproverObject approver;
  } obj;  // must be first
  UseCaseTag uc;
};

#define LISTENER_UC(obj) (((Listener*)(obj))->uc)

static void CsDestruct(CsLpListenerObject* self) {
  (void)self;
}

static void CsOnRemoteEgAdded(CsLpListenerObject* self, const EntityAddressType* addr) {
  OutEmit(EntityEvent("grid_eg_added", LISTENER_UC(self), addr));
}

static void CsOnRemoteEgRemoved(CsLpListenerObject* self, const EntityAddressType* addr) {
  OutEmit(EntityEvent("grid_eg_removed", LISTENER_UC(self), addr));
}

static void CsOnPowerLimitReceive(
    CsLpListenerObject* self,
    const ScaledValue* limit,
    const DurationType* duration,
    bool is_active
) {
  cJSON* ev = OutEvent("grid_limit");
  cJSON_AddStringToObject(ev, "uc", UcName(LISTENER_UC(self)));
  cJSON_AddNumberToObject(ev, "w", ScaledToDouble(limit));
  cJSON_AddNumberToObject(ev, "duration_s", (double)DurationSeconds(duration));
  cJSON_AddBoolToObject(ev, "active", is_active);
  OutEmit(ev);
}

static void CsOnFailsafePowerLimitReceive(CsLpListenerObject* self, const ScaledValue* limit) {
  cJSON* ev = OutEvent("grid_failsafe_limit");
  cJSON_AddStringToObject(ev, "uc", UcName(LISTENER_UC(self)));
  cJSON_AddNumberToObject(ev, "w", ScaledToDouble(limit));
  OutEmit(ev);
}

static void CsOnFailsafeDurationReceive(CsLpListenerObject* self, const DurationType* duration) {
  cJSON* ev = OutEvent("grid_failsafe_duration");
  cJSON_AddStringToObject(ev, "uc", UcName(LISTENER_UC(self)));
  cJSON_AddNumberToObject(ev, "duration_s", (double)DurationSeconds(duration));
  OutEmit(ev);
}

static void CsOnHeartbeatReceive(CsLpListenerObject* self, uint64_t counter) {
  // Heartbeats arrive every few seconds; DVhub only needs the derived state
  // (BridgeTick reports changes) and an occasional sign of life.
  if (counter % 12 == 0) {
    cJSON* ev = OutEvent("grid_heartbeat");
    cJSON_AddStringToObject(ev, "uc", UcName(LISTENER_UC(self)));
    cJSON_AddNumberToObject(ev, "counter", (double)counter);
    OutEmit(ev);
  }
}

static const CsLpListenerInterface cs_listener_methods = {
    .destruct                        = CsDestruct,
    .on_remote_eg_added              = CsOnRemoteEgAdded,
    .on_remote_eg_removed            = CsOnRemoteEgRemoved,
    .on_power_limit_receive          = CsOnPowerLimitReceive,
    .on_failsafe_power_limit_receive = CsOnFailsafePowerLimitReceive,
    .on_failsafe_duration_receive    = CsOnFailsafeDurationReceive,
    .on_heartbeat_receive            = CsOnHeartbeatReceive,
};

static CsLpUseCaseObject* CsFor(UseCaseTag uc) {
  return uc == kUcCsLpc ? bridge.cs_lpc : bridge.cs_lpp;
}

// The protocol stack must answer a write quickly, so the bridge approves every
// valid write right here and reports it; DVhub decides what it does with the
// limit. Only peers DVhub trusts can reach this point (SHIP pairing).
static void ApproverDestruct(CsLpcApproverObject* self) {
  (void)self;
}

static void ApproverOnPowerLimit(
    CsLpcApproverObject* self,
    const char* ski,
    MsgCounterType msg_cnt,
    const ScaledValue* limit,
    const DurationType* duration,
    bool is_active
) {
  const UseCaseTag uc         = LISTENER_UC(self);
  const double w              = ScaledToDouble(limit);
  const int64_t duration_s    = DurationSeconds(duration);
  const bool valid            = CsLpIsLimitValid(w, (int32_t)duration_s);
  CsLpUseCaseObject* const cs = CsFor(uc);

  cJSON* ev = OutEvent("grid_write");
  cJSON_AddStringToObject(ev, "uc", UcName(uc));
  cJSON_AddStringToObject(ev, "kind", "limit");
  cJSON_AddStringToObject(ev, "ski", ski != NULL ? ski : "");
  cJSON_AddNumberToObject(ev, "w", w);
  cJSON_AddNumberToObject(ev, "duration_s", (double)duration_s);
  cJSON_AddBoolToObject(ev, "active", is_active);
  cJSON_AddBoolToObject(ev, "approved", valid);
  OutEmit(ev);

  if (valid) {
    CsLpApproveWrite(cs, ski, msg_cnt);
  } else {
    const ErrorType err = {.error_number = kErrorNumberTypeCommandRejected, .description = "invalid limit or duration"};
    CsLpDenyWrite(cs, ski, msg_cnt, &err);
  }
}

static void ApproverOnFailsafeValue(CsLpcApproverObject* self, const char* ski, MsgCounterType msg_cnt, const ScaledValue* value) {
  const UseCaseTag uc = LISTENER_UC(self);
  const double w      = ScaledToDouble(value);
  const bool valid    = CsLpIsFailsafeValueValid(w);
  cJSON* ev           = OutEvent("grid_write");
  cJSON_AddStringToObject(ev, "uc", UcName(uc));
  cJSON_AddStringToObject(ev, "kind", "failsafe_limit");
  cJSON_AddStringToObject(ev, "ski", ski != NULL ? ski : "");
  cJSON_AddNumberToObject(ev, "w", w);
  cJSON_AddBoolToObject(ev, "approved", valid);
  OutEmit(ev);
  if (valid) {
    CsLpApproveWrite(CsFor(uc), ski, msg_cnt);
  } else {
    const ErrorType err = {.error_number = kErrorNumberTypeCommandRejected, .description = "invalid failsafe value"};
    CsLpDenyWrite(CsFor(uc), ski, msg_cnt, &err);
  }
}

static void ApproverOnFailsafeDuration(
    CsLpcApproverObject* self,
    const char* ski,
    MsgCounterType msg_cnt,
    const DurationType* duration
) {
  const UseCaseTag uc      = LISTENER_UC(self);
  const int64_t duration_s = DurationSeconds(duration);
  const bool valid         = CsLpIsFailsafeDurationValid((int32_t)duration_s);
  cJSON* ev                = OutEvent("grid_write");
  cJSON_AddStringToObject(ev, "uc", UcName(uc));
  cJSON_AddStringToObject(ev, "kind", "failsafe_duration");
  cJSON_AddStringToObject(ev, "ski", ski != NULL ? ski : "");
  cJSON_AddNumberToObject(ev, "duration_s", (double)duration_s);
  cJSON_AddBoolToObject(ev, "approved", valid);
  OutEmit(ev);
  if (valid) {
    CsLpApproveWrite(CsFor(uc), ski, msg_cnt);
  } else {
    const ErrorType err = {.error_number = kErrorNumberTypeCommandRejected, .description = "invalid failsafe duration"};
    CsLpDenyWrite(CsFor(uc), ski, msg_cnt, &err);
  }
}

static void ApproverOnExpired(CsLpcApproverObject* self, const char* ski, MsgCounterType msg_cnt) {
  (void)msg_cnt;
  cJSON* ev = OutEvent("grid_write_expired");
  cJSON_AddStringToObject(ev, "uc", UcName(LISTENER_UC(self)));
  cJSON_AddStringToObject(ev, "ski", ski != NULL ? ski : "");
  OutEmit(ev);
}

static const CsLpcApproverInterface approver_methods = {
    .destruct                                = ApproverDestruct,
    .on_power_limit_approval_requested       = ApproverOnPowerLimit,
    .on_failsafe_value_approval_requested    = ApproverOnFailsafeValue,
    .on_failsafe_duration_approval_requested = ApproverOnFailsafeDuration,
    .on_approval_request_expired             = ApproverOnExpired,
};

//-------------------------------------------------------------------------------------------//
// Device side: EG LPC / EG LPP listener
//-------------------------------------------------------------------------------------------//

static void EgDestruct(EgLpListenerObject* self) {
  (void)self;
}

static void EgOnRemoteCsAdded(EgLpListenerObject* self, const EntityAddressType* addr) {
  RemoteAdd(LISTENER_UC(self), addr);
  OutEmit(EntityEvent("device_added", LISTENER_UC(self), addr));
  // Ask for the nominal maximum so DVhub can share a limit sensibly.
  EgLpReadPowerNominalMax(LISTENER_UC(self) == kUcEgLpc ? bridge.eg_lpc : bridge.eg_lpp, addr, NULL, NULL);
}

static void EgOnRemoteCsRemoved(EgLpListenerObject* self, const EntityAddressType* addr) {
  RemoteRemove(LISTENER_UC(self), addr);
  OutEmit(EntityEvent("device_removed", LISTENER_UC(self), addr));
}

static void EgOnPowerLimitReceive(
    EgLpListenerObject* self,
    const EntityAddressType* addr,
    const ScaledValue* limit,
    const DurationType* duration,
    bool is_active
) {
  cJSON* ev = EntityEvent("device_limit", LISTENER_UC(self), addr);
  cJSON_AddNumberToObject(ev, "w", ScaledToDouble(limit));
  cJSON_AddNumberToObject(ev, "duration_s", (double)DurationSeconds(duration));
  cJSON_AddBoolToObject(ev, "active", is_active);
  OutEmit(ev);
}

static void EgOnFailsafePowerLimitReceive(EgLpListenerObject* self, const EntityAddressType* addr, const ScaledValue* limit) {
  cJSON* ev = EntityEvent("device_failsafe_limit", LISTENER_UC(self), addr);
  cJSON_AddNumberToObject(ev, "w", ScaledToDouble(limit));
  OutEmit(ev);
}

static void EgOnFailsafeDurationReceive(EgLpListenerObject* self, const EntityAddressType* addr, const DurationType* duration) {
  cJSON* ev = EntityEvent("device_failsafe_duration", LISTENER_UC(self), addr);
  cJSON_AddNumberToObject(ev, "duration_s", (double)DurationSeconds(duration));
  OutEmit(ev);
}

static void EgOnHeartbeatReceive(EgLpListenerObject* self, const EntityAddressType* addr, uint64_t counter) {
  (void)self;
  (void)addr;
  (void)counter;
}

static void EgOnPowerNominalMaxReceive(EgLpListenerObject* self, const EntityAddressType* addr, const ScaledValue* max) {
  cJSON* ev = EntityEvent("device_nominal_max", LISTENER_UC(self), addr);
  cJSON_AddNumberToObject(ev, "w", ScaledToDouble(max));
  OutEmit(ev);
}

static const EgLpListenerInterface eg_listener_methods = {
    .destruct                        = EgDestruct,
    .on_remote_cs_added              = EgOnRemoteCsAdded,
    .on_remote_cs_removed            = EgOnRemoteCsRemoved,
    .on_power_limit_receive          = EgOnPowerLimitReceive,
    .on_failsafe_power_limit_receive = EgOnFailsafePowerLimitReceive,
    .on_failsafe_duration_receive    = EgOnFailsafeDurationReceive,
    .on_heartbeat_receive            = EgOnHeartbeatReceive,
    .on_power_nominal_max_receive    = EgOnPowerNominalMaxReceive,
};

//-------------------------------------------------------------------------------------------//
// Device side: MA MPC listener
//-------------------------------------------------------------------------------------------//

static const char* MeasurementName(MuMpcMeasurementNameId id) {
  switch (id) {
    case kMpcPowerTotal: return "power_w";
    case kMpcPowerPhaseA: return "power_l1_w";
    case kMpcPowerPhaseB: return "power_l2_w";
    case kMpcPowerPhaseC: return "power_l3_w";
    case kMpcEnergyConsumed: return "energy_consumed_wh";
    case kMpcEnergyProduced: return "energy_produced_wh";
    case kMpcCurrentPhaseA: return "current_l1_a";
    case kMpcCurrentPhaseB: return "current_l2_a";
    case kMpcCurrentPhaseC: return "current_l3_a";
    case kMpcVoltagePhaseA: return "voltage_l1_v";
    case kMpcVoltagePhaseB: return "voltage_l2_v";
    case kMpcVoltagePhaseC: return "voltage_l3_v";
    case kMpcFrequency: return "frequency_hz";
    default: return NULL;
  }
}

static void MaDestruct(MaMpcListenerObject* self) {
  (void)self;
}

static void MaOnRemoteMuAdded(MaMpcListenerObject* self, const EntityAddressType* addr) {
  RemoteAdd(kUcMaMpc, addr);
  OutEmit(EntityEvent("device_added", LISTENER_UC(self), addr));
}

static void MaOnRemoteMuRemoved(MaMpcListenerObject* self, const EntityAddressType* addr) {
  RemoteRemove(kUcMaMpc, addr);
  OutEmit(EntityEvent("device_removed", LISTENER_UC(self), addr));
}

static void MaOnMeasurementReceive(
    MaMpcListenerObject* self,
    MuMpcMeasurementNameId name_id,
    const ScaledValue* value,
    const EntityAddressType* addr
) {
  const char* name = MeasurementName(name_id);
  if (name == NULL) {
    return;
  }
  cJSON* ev = EntityEvent("device_measurement", LISTENER_UC(self), addr);
  cJSON_AddStringToObject(ev, "name", name);
  cJSON_AddNumberToObject(ev, "value", ScaledToDouble(value));
  OutEmit(ev);
}

static const MaMpcListenerInterface ma_listener_methods = {
    .destruct               = MaDestruct,
    .on_remote_mu_added     = MaOnRemoteMuAdded,
    .on_remote_mu_removed   = MaOnRemoteMuRemoved,
    .on_measurement_receive = MaOnMeasurementReceive,
};

//-------------------------------------------------------------------------------------------//
// Device side: CEM OHPCF listener (heat pump compressor flexibility)
//-------------------------------------------------------------------------------------------//

static const char* OhpcfStateName(CompressorOhpcfState s) {
  switch (s) {
    case kCompressorOhpcfStateAnnounced: return "announced";
    case kCompressorOhpcfStateScheduled: return "scheduled";
    case kCompressorOhpcfStateRunning: return "running";
    case kCompressorOhpcfStatePaused: return "paused";
    case kCompressorOhpcfStateStopped: return "stopped";
    case kCompressorOhpcfStateCompleted: return "completed";
    default: return "undefined";
  }
}

static void CemDestruct(CemOhpcfListenerObject* self) {
  (void)self;
}

static void CemOnCompressorAdded(CemOhpcfListenerObject* self, const EntityAddressType* addr) {
  RemoteAdd(kUcCemOhpcf, addr);
  OutEmit(EntityEvent("device_added", LISTENER_UC(self), addr));
}

static void CemOnCompressorRemoved(CemOhpcfListenerObject* self, const EntityAddressType* addr) {
  RemoteRemove(kUcCemOhpcf, addr);
  OutEmit(EntityEvent("device_removed", LISTENER_UC(self), addr));
}

static void CemOnAnnounce(CemOhpcfListenerObject* self, const OptionalPowerConsumption* opc, const EntityAddressType* addr) {
  cJSON* ev = EntityEvent("ohpcf_announce", LISTENER_UC(self), addr);
  cJSON_AddNumberToObject(ev, "max_power_w", ScaledToDouble(&opc->max_power_w));
  cJSON_AddNumberToObject(ev, "earliest_start_s", (double)EebusDurationToSeconds(&opc->earliest_start_time));
  cJSON_AddNumberToObject(ev, "latest_end_s", (double)EebusDurationToSeconds(&opc->latest_end_time));
  cJSON_AddNumberToObject(ev, "min_duration_s", (double)EebusDurationToSeconds(&opc->active_duration_min));
  cJSON_AddBoolToObject(ev, "stoppable", opc->is_stoppable);
  cJSON_AddBoolToObject(ev, "pausable", opc->is_pausable);
  OutEmit(ev);
}

static void CemOnStateReport(
    CemOhpcfListenerObject* self,
    CompressorOhpcfState state,
    const EebusDuration* start_time,
    const EntityAddressType* addr
) {
  cJSON* ev = EntityEvent("ohpcf_state", LISTENER_UC(self), addr);
  cJSON_AddStringToObject(ev, "state", OhpcfStateName(state));
  if (start_time != NULL) {
    cJSON_AddNumberToObject(ev, "start_in_s", (double)EebusDurationToSeconds(start_time));
  }
  OutEmit(ev);
}

static void CemOnClearProcess(CemOhpcfListenerObject* self, const EntityAddressType* addr) {
  OutEmit(EntityEvent("ohpcf_clear", LISTENER_UC(self), addr));
}

static const CemOhpcfListenerInterface cem_listener_methods = {
    .destruct                     = CemDestruct,
    .on_remote_compressor_added   = CemOnCompressorAdded,
    .on_remote_compressor_removed = CemOnCompressorRemoved,
    .on_announce                  = CemOnAnnounce,
    .on_state_report              = CemOnStateReport,
    .on_clear_process             = CemOnClearProcess,
};

//-------------------------------------------------------------------------------------------//
// Listener instances
//-------------------------------------------------------------------------------------------//

static Listener cs_lpc_listener   = {.obj.cs = {.interface_ = &cs_listener_methods}, .uc = kUcCsLpc};
static Listener cs_lpp_listener   = {.obj.cs = {.interface_ = &cs_listener_methods}, .uc = kUcCsLpp};
static Listener cs_lpc_approver   = {.obj.approver = {.interface_ = &approver_methods}, .uc = kUcCsLpc};
static Listener cs_lpp_approver   = {.obj.approver = {.interface_ = &approver_methods}, .uc = kUcCsLpp};
static Listener eg_lpc_listener   = {.obj.eg = {.interface_ = &eg_listener_methods}, .uc = kUcEgLpc};
static Listener eg_lpp_listener   = {.obj.eg = {.interface_ = &eg_listener_methods}, .uc = kUcEgLpp};
static Listener ma_mpc_listener   = {.obj.ma = {.interface = &ma_listener_methods}, .uc = kUcMaMpc};  // openeebus names this member without '_'
static Listener cem_ohpcf_listener = {.obj.cem = {.interface_ = &cem_listener_methods}, .uc = kUcCemOhpcf};

//-------------------------------------------------------------------------------------------//
// Service reader (connection events)
//-------------------------------------------------------------------------------------------//

static void ReaderDestruct(ServiceReaderObject* self) {
  (void)self;
}

static void OnRemoteSkiConnected(ServiceReaderObject* self, EebusServiceObject* service, const char* ski) {
  (void)self;
  (void)service;
  OutEmitSki("connected", ski);
}

static void OnRemoteSkiDisconnected(ServiceReaderObject* self, EebusServiceObject* service, const char* ski) {
  (void)self;
  (void)service;
  OutEmitSki("disconnected", ski);
}

static void AddStr(cJSON* obj, const char* key, const char* value) {
  if (value != NULL) {
    cJSON_AddStringToObject(obj, key, value);
  }
}

static void OnRemoteServicesUpdate(ServiceReaderObject* self, EebusServiceObject* service, const Vector* entries) {
  (void)self;
  (void)service;
  cJSON* ev   = OutEvent("mdns");
  cJSON* list = cJSON_AddArrayToObject(ev, "services");
  for (size_t i = 0; entries != NULL && i < VectorGetSize(entries); ++i) {
    const MdnsEntry* e = (const MdnsEntry*)VectorGetElement(entries, i);
    if (e == NULL) {
      continue;
    }
    cJSON* s = cJSON_CreateObject();
    AddStr(s, "ski", e->ski);
    AddStr(s, "name", e->name);
    AddStr(s, "host", e->host);
    AddStr(s, "id", e->id);
    AddStr(s, "brand", e->brand);
    AddStr(s, "model", e->model);
    AddStr(s, "type", e->type);
    AddStr(s, "register", e->reg);
    cJSON_AddNumberToObject(s, "port", e->port);
    cJSON_AddItemToArray(list, s);
  }
  OutEmit(ev);
}

static void OnShipIdUpdate(ServiceReaderObject* self, const char* ski, const char* ship_id) {
  (void)self;
  cJSON* ev = OutEvent("ship_id");
  AddStr(ev, "ski", ski);
  AddStr(ev, "ship_id", ship_id);
  OutEmit(ev);
}

static void OnShipStateUpdate(ServiceReaderObject* self, const char* ski, SmeState state) {
  (void)self;
  cJSON* ev = OutEvent("ship_state");
  AddStr(ev, "ski", ski);
  cJSON_AddNumberToObject(ev, "state", (double)state);
  const char* label = NULL;
  switch (state) {
    case kSmeHelloStatePendingInit:
    case kSmeHelloStatePendingListen: label = "waiting_trust"; break;
    case kSmeHelloStateRejected:
    case kSmeHelloStateRemoteAbortDone: label = "rejected"; break;
    default: break;
  }
  AddStr(ev, "label", label);
  OutEmit(ev);
}

static bool IsWaitingForTrustAllowed(const ServiceReaderObject* self, const char* ski) {
  (void)self;
  (void)ski;
  return true;  // the service decides with set_pairing_possible
}

static const ServiceReaderInterface reader_methods = {
    .destruct                     = ReaderDestruct,
    .on_remote_ski_connected      = OnRemoteSkiConnected,
    .on_remote_ski_disconnected   = OnRemoteSkiDisconnected,
    .on_remote_services_update    = OnRemoteServicesUpdate,
    .on_ship_id_update            = OnShipIdUpdate,
    .on_ship_state_update         = OnShipStateUpdate,
    .is_waiting_for_trust_allowed = IsWaitingForTrustAllowed,
};

//-------------------------------------------------------------------------------------------//
// Setup
//-------------------------------------------------------------------------------------------//

static EntityLocalObject* NewEntity(DeviceLocalObject* device, EntityTypeType type) {
  uint32_t ids[1] = {(uint32_t)VectorGetSize(DEVICE_LOCAL_GET_ENTITIES(device))};
  return EntityLocalCreate(device, type, ids, ARRAY_SIZE(ids), kHeartbeatTimeoutSeconds);
}

// LPC and LPP each get their own CEM entity: on a shared entity both use cases
// share one LoadControl feature, every write needs the approval of both, and
// the other use case rejects a limit that is not its own — the limit would
// never take effect (same layout as openeebus' heat pump example).
static int AddGridSide(DeviceLocalObject* device) {
  EntityLocalObject* lpc_entity = NewEntity(device, kEntityTypeTypeCEM);
  if (lpc_entity == NULL) {
    return -1;
  }
  bridge.cs_lpc = CsLpcUseCaseCreate(lpc_entity, kConnectionId, &cs_lpc_listener.obj.cs);
  if (bridge.cs_lpc == NULL) {
    OutLog("grid side: LPC use case creation failed");
    return -1;
  }
  CsLpSetWriteApprover(bridge.cs_lpc, &cs_lpc_approver.obj.approver);
  DEVICE_LOCAL_ADD_ENTITY(device, lpc_entity);

  EntityLocalObject* lpp_entity = NewEntity(device, kEntityTypeTypeCEM);
  if (lpp_entity == NULL) {
    return -1;
  }
  bridge.cs_lpp = CsLppUseCaseCreate(lpp_entity, kConnectionId, &cs_lpp_listener.obj.cs);
  if (bridge.cs_lpp == NULL) {
    OutLog("grid side: LPP use case creation failed");
    return -1;
  }
  CsLpSetWriteApprover(bridge.cs_lpp, &cs_lpp_approver.obj.approver);
  DEVICE_LOCAL_ADD_ENTITY(device, lpp_entity);
  return 0;
}

static int AddDeviceSide(DeviceLocalObject* device) {
  EntityLocalObject* entity = NewEntity(device, kEntityTypeTypeCEM);
  if (entity == NULL) {
    return -1;
  }
  bridge.eg_lpc    = EgLpcUseCaseCreate(entity, &eg_lpc_listener.obj.eg);
  bridge.eg_lpp    = EgLppUseCaseCreate(entity, &eg_lpp_listener.obj.eg);
  bridge.ma_mpc    = MaMpcUseCaseCreate(entity, &ma_mpc_listener.obj.ma);
  bridge.cem_ohpcf = CemOhpcfUseCaseCreate(entity, &cem_ohpcf_listener.obj.cem);
  if (bridge.eg_lpc == NULL || bridge.eg_lpp == NULL || bridge.ma_mpc == NULL || bridge.cem_ohpcf == NULL) {
    OutLog("device side: use case creation failed");
    return -1;
  }
  DEVICE_LOCAL_ADD_ENTITY(device, entity);
  return 0;
}

// DVhub has the grid power and (its own integrated) energy counters, but no
// per-phase currents, voltages or grid frequency — so only power (MGCP
// scenario 2) and energy (scenarios 3 and 4) are offered.
static int AddGridConnectionPoint(DeviceLocalObject* device) {
  static const GcpMgcpMeasurementConfig calculated = {.value_source = kMeasurementValueSourceTypeCalculatedValue};
  static const GcpMgcpMonitorEnergyConfig energy_cfg = {
      .energy_feed_in_cfg  = &calculated,
      .energy_consumed_cfg = &calculated,
  };
  static const GcpMgcpConfig cfg = {
      .power_cfg =
          {
              .phases          = kElectricalConnectionPhaseNameTypeAbc,
              .power_total_cfg = {.value_source = kMeasurementValueSourceTypeMeasuredValue},
          },
      .energy_cfg = &energy_cfg,
  };

  EntityLocalObject* entity = NewEntity(device, kEntityTypeTypeGridConnectionPointOfPremises);
  if (entity == NULL) {
    return -1;
  }
  bridge.gcp_mgcp = GcpMgcpUseCaseCreate(entity, kConnectionId, &cfg);
  if (bridge.gcp_mgcp == NULL) {
    OutLog("grid connection point: use case creation failed");
    return -1;
  }
  const ScaledValue zero = {.value = 0, .scale = 0};
  GcpMgcpSetMeasurementDataCache(bridge.gcp_mgcp, kGcpPowerTotal, &zero, NULL, NULL);
  GcpMgcpUpdate(bridge.gcp_mgcp);
  DEVICE_LOCAL_ADD_ENTITY(device, entity);
  return 0;
}

int BridgeStart(const BridgeOptions* opts) {
  memset(&bridge, 0, sizeof(bridge));
  SERVICE_READER_INTERFACE(&bridge.service_reader) = &reader_methods;
  pthread_mutex_init(&bridge.mutex, NULL);
  EntityAddressListInit(&bridge.eg_lpc_remotes);
  EntityAddressListInit(&bridge.eg_lpp_remotes);
  EntityAddressListInit(&bridge.ma_mpc_remotes);
  EntityAddressListInit(&bridge.ohpcf_remotes);
  bridge.last_lpc_heartbeat_ok = -1;
  bridge.last_lpp_heartbeat_ok = -1;

  bridge.tls = TlsCertificateLoadX509KeyPair(opts->cert_path, opts->key_path);
  if (bridge.tls == NULL) {
    OutLog("cannot load certificate %s / key %s", opts->cert_path, opts->key_path);
    return -1;
  }

  bridge.cfg = EebusServiceConfigCreate(
      opts->vendor,
      opts->brand,
      opts->model,
      opts->serial,
      "EnergyManagementSystem",
      opts->port
  );
  if (bridge.cfg == NULL) {
    return -1;
  }
  char ship_id[160];
  snprintf(ship_id, sizeof(ship_id), "%s-%s-%s", opts->brand, opts->model, opts->serial);
  EebusServiceConfigSetAlternateIdentifier(bridge.cfg, ship_id);

  bridge.service = EebusServiceCreate(bridge.cfg, opts->role, bridge.tls, &bridge.service_reader);
  if (bridge.service == NULL) {
    OutLog("service creation failed (port %d in use?)", opts->port);
    return -1;
  }

  DeviceLocalObject* const device = EEBUS_SERVICE_GET_LOCAL_DEVICE(bridge.service);
  if (AddGridSide(device) != 0 || AddDeviceSide(device) != 0 || AddGridConnectionPoint(device) != 0) {
    return -1;
  }

  // A Controllable System has to publish its (inactive) limit entry itself;
  // without it the Energy Guard's write has nothing to update and the limit
  // never takes effect (openeebus does not create it on its own).
  const ScaledValue no_limit = {.value = 0, .scale = 0};
  if (CsLpSetActivePowerLimit(bridge.cs_lpc, &no_limit, false, true) != kEebusErrorOk
      || CsLpSetActivePowerLimit(bridge.cs_lpp, &no_limit, false, true) != kEebusErrorOk) {
    OutLog("grid side: initial limit entry failed");
    return -1;
  }

  // The grid side announces its own heartbeat (LPC/LPP scenario 2).
  CsLpStartHeartbeat(bridge.cs_lpc);
  CsLpStartHeartbeat(bridge.cs_lpp);

  EEBUS_SERVICE_SET_PAIRING_POSSIBLE(bridge.service, false);
  EEBUS_SERVICE_START(bridge.service);

  cJSON* ev = OutEvent("ready");
  cJSON_AddStringToObject(ev, "ski", EEBUS_SERVICE_GET_LOCAL_SKI(bridge.service));
  cJSON_AddStringToObject(ev, "ship_id", ship_id);
  cJSON_AddNumberToObject(ev, "port", opts->port);
  const char* qr = EEBUS_SERVICE_GET_QR_CODE_STRING(bridge.service);
  if (qr != NULL) {
    cJSON_AddStringToObject(ev, "qr", qr);
  }
  OutEmit(ev);
  return 0;
}

//-------------------------------------------------------------------------------------------//
// Commands from DVhub
//-------------------------------------------------------------------------------------------//

static const char* Str(const cJSON* cmd, const char* key) {
  const cJSON* v = cJSON_GetObjectItemCaseSensitive(cmd, key);
  return cJSON_IsString(v) ? v->valuestring : NULL;
}

static bool Num(const cJSON* cmd, const char* key, double* out) {
  const cJSON* v = cJSON_GetObjectItemCaseSensitive(cmd, key);
  if (!cJSON_IsNumber(v) || !isfinite(v->valuedouble)) {
    return false;
  }
  *out = v->valuedouble;
  return true;
}

static bool Bool(const cJSON* cmd, const char* key, bool fallback) {
  const cJSON* v = cJSON_GetObjectItemCaseSensitive(cmd, key);
  return cJSON_IsBool(v) ? cJSON_IsTrue(v) : fallback;
}

static void Reply(const cJSON* cmd, bool ok, const char* error) {
  const cJSON* id = cJSON_GetObjectItemCaseSensitive(cmd, "id");
  cJSON* ev       = OutEvent("reply");
  if (cJSON_IsNumber(id)) {
    cJSON_AddNumberToObject(ev, "id", id->valuedouble);
  } else if (cJSON_IsString(id)) {
    cJSON_AddStringToObject(ev, "id", id->valuestring);
  }
  AddStr(ev, "cmd", Str(cmd, "cmd"));
  cJSON_AddBoolToObject(ev, "ok", ok);
  AddStr(ev, "error", error);
  OutEmit(ev);
}

// Result of an asynchronous write to a remote device (EG LPC/LPP, OHPCF).
static void WriteResult(const ResultMessage* result, const FeatureAddressType* remote, EebusError err, void* ctx) {
  (void)remote;
  cJSON* ev = OutEvent("write_result");
  cJSON_AddNumberToObject(ev, "id", (double)(intptr_t)ctx);
  bool ok = err == kEebusErrorOk;
  if (ok && result != NULL && result->result_data != NULL && result->result_data->error_number != NULL) {
    ok = *result->result_data->error_number == kErrorNumberTypeNoError;
  }
  cJSON_AddBoolToObject(ev, "ok", ok);
  OutEmit(ev);
}

static void* CmdCtx(const cJSON* cmd) {
  const cJSON* id = cJSON_GetObjectItemCaseSensitive(cmd, "id");
  return (void*)(intptr_t)(cJSON_IsNumber(id) ? (intptr_t)id->valuedouble : 0);
}

static void CmdTrust(const cJSON* cmd, bool trust) {
  const char* ski = Str(cmd, "ski");
  if (ski == NULL || strlen(ski) != 40) {
    Reply(cmd, false, "ski must be 40 hex characters");
    return;
  }
  if (trust) {
    EEBUS_SERVICE_REGISTER_REMOTE_SKI(bridge.service, ski, true);
  } else {
    EEBUS_SERVICE_UNREGISTER_REMOTE_SKI(bridge.service, ski);
  }
  Reply(cmd, true, NULL);
}

static void CmdGridConfig(const cJSON* cmd) {
  const char* uc_name = Str(cmd, "uc");
  if (uc_name == NULL || (strcmp(uc_name, "lpc") != 0 && strcmp(uc_name, "lpp") != 0)) {
    Reply(cmd, false, "uc must be lpc or lpp");
    return;
  }
  CsLpUseCaseObject* const cs = strcmp(uc_name, "lpc") == 0 ? bridge.cs_lpc : bridge.cs_lpp;
  double v                    = 0.0;
  EebusError err              = kEebusErrorOk;
  if (Num(cmd, "nominal_max_w", &v)) {
    const ScaledValue sv = DoubleToScaled(v);
    err                  = CsLpSetNominalMax(cs, &sv);
  }
  if (err == kEebusErrorOk && Num(cmd, "failsafe_w", &v)) {
    const ScaledValue sv = DoubleToScaled(v);
    err                  = CsLpSetFailsafeActivePowerLimit(cs, &sv, true);
  }
  if (err == kEebusErrorOk && Num(cmd, "failsafe_duration_s", &v)) {
    const EebusDuration d = SecondsToDuration((int64_t)v);
    err                   = CsLpSetFailsafeDurationMinimum(cs, &d, true);
  }
  Reply(cmd, err == kEebusErrorOk, err == kEebusErrorOk ? NULL : "setting grid values failed");
}

// DVhub reports the limit it actually applies (e.g. after the limit expired
// or the failsafe state ended): LPC scenario 1 "read limit" stays consistent.
static void CmdGridLimitState(const cJSON* cmd) {
  const char* uc_name = Str(cmd, "uc");
  if (uc_name == NULL) {
    Reply(cmd, false, "uc missing");
    return;
  }
  CsLpUseCaseObject* const cs = strcmp(uc_name, "lpc") == 0 ? bridge.cs_lpc : bridge.cs_lpp;
  double w                    = 0.0;
  if (!Num(cmd, "w", &w)) {
    Reply(cmd, false, "w missing");
    return;
  }
  const ScaledValue sv = DoubleToScaled(w);
  const EebusError err = CsLpSetActivePowerLimit(cs, &sv, Bool(cmd, "active", false), true);
  Reply(cmd, err == kEebusErrorOk, err == kEebusErrorOk ? NULL : "setting limit state failed");
}

typedef struct GcpField GcpField;
struct GcpField {
  const char* key;
  GcpMeasurementNameId id;
};

static void CmdGcp(const cJSON* cmd) {
  static const GcpField fields[] = {
      {"power_w", kGcpPowerTotal},
  };
  double v = 0.0;
  for (size_t i = 0; i < ARRAY_SIZE(fields); ++i) {
    if (Num(cmd, fields[i].key, &v)) {
      const ScaledValue sv = DoubleToScaled(v);
      GcpMgcpSetMeasurementDataCache(bridge.gcp_mgcp, fields[i].id, &sv, NULL, NULL);
    }
  }
  if (Num(cmd, "energy_feed_in_wh", &v)) {
    const ScaledValue sv = DoubleToScaled(v);
    GcpMgcpSetEnergyFeedInCache(bridge.gcp_mgcp, &sv, NULL, NULL, NULL, NULL);
  }
  if (Num(cmd, "energy_consumed_wh", &v)) {
    const ScaledValue sv = DoubleToScaled(v);
    GcpMgcpSetEnergyConsumedCache(bridge.gcp_mgcp, &sv, NULL, NULL, NULL, NULL);
  }
  const EebusError err = GcpMgcpUpdate(bridge.gcp_mgcp);
  if (cJSON_GetObjectItemCaseSensitive(cmd, "id") != NULL) {
    Reply(cmd, err == kEebusErrorOk, err == kEebusErrorOk ? NULL : "gcp update failed");
  }
}

static void CmdDeviceLimit(const cJSON* cmd) {
  const char* uc_name   = Str(cmd, "uc");
  const UseCaseTag uc   = uc_name != NULL && strcmp(uc_name, "lpp") == 0 ? kUcEgLpp : kUcEgLpc;
  EgLpUseCaseObject* eg = uc == kUcEgLpc ? bridge.eg_lpc : bridge.eg_lpp;
  EntityAddressType* addr = RemoteFind(uc, Str(cmd, "entity"));
  if (addr == NULL) {
    Reply(cmd, false, "unknown device entity");
    return;
  }
  double w = 0.0, duration_s = 0.0;
  const bool has_w = Num(cmd, "w", &w);
  Num(cmd, "duration_s", &duration_s);
  LoadLimit limit = {0};
  limit.value           = DoubleToScaled(has_w ? w : 0.0);
  limit.is_active       = Bool(cmd, "active", has_w);
  limit.duration        = SecondsToDuration((int64_t)duration_s);
  limit.delete_duration = duration_s <= 0.0;
  const EebusError err  = EgLpSetActivePowerLimit(eg, addr, &limit, WriteResult, CmdCtx(cmd));
  EntityAddressDelete(addr);
  if (err == kEebusErrorOk && !bridge.eg_heartbeat_started) {
    EgLpStartHeartbeat(bridge.eg_lpc);
    EgLpStartHeartbeat(bridge.eg_lpp);
    bridge.eg_heartbeat_started = true;
  }
  Reply(cmd, err == kEebusErrorOk, err == kEebusErrorOk ? NULL : "write failed");
}

static void CmdDeviceFailsafe(const cJSON* cmd) {
  const char* uc_name     = Str(cmd, "uc");
  const UseCaseTag uc     = uc_name != NULL && strcmp(uc_name, "lpp") == 0 ? kUcEgLpp : kUcEgLpc;
  EgLpUseCaseObject* eg   = uc == kUcEgLpc ? bridge.eg_lpc : bridge.eg_lpp;
  EntityAddressType* addr = RemoteFind(uc, Str(cmd, "entity"));
  if (addr == NULL) {
    Reply(cmd, false, "unknown device entity");
    return;
  }
  double v       = 0.0;
  EebusError err = kEebusErrorOk;
  if (Num(cmd, "w", &v)) {
    const ScaledValue sv = DoubleToScaled(v);
    err                  = EgLpSetFailsafeActivePowerLimit(eg, addr, &sv, WriteResult, CmdCtx(cmd));
  }
  if (err == kEebusErrorOk && Num(cmd, "duration_s", &v)) {
    const EebusDuration d = SecondsToDuration((int64_t)v);
    err                   = EgLpSetFailsafeDurationMinimum(eg, addr, &d, WriteResult, CmdCtx(cmd));
  }
  EntityAddressDelete(addr);
  Reply(cmd, err == kEebusErrorOk, err == kEebusErrorOk ? NULL : "write failed");
}

static void CmdOhpcf(const cJSON* cmd) {
  EntityAddressType* addr = RemoteFind(kUcCemOhpcf, Str(cmd, "entity"));
  if (addr == NULL) {
    Reply(cmd, false, "unknown compressor entity");
    return;
  }
  const char* action = Str(cmd, "action");
  EebusError err     = kEebusErrorInputArgument;
  if (action != NULL && strcmp(action, "schedule") == 0) {
    double start_in_s = 0.0;
    Num(cmd, "start_in_s", &start_in_s);
    const EebusDuration start = SecondsToDuration((int64_t)start_in_s);
    err = CemOhpcfScheduleOptionalPowerConsumption(bridge.cem_ohpcf, addr, &start, WriteResult, CmdCtx(cmd));
  } else if (action != NULL && strcmp(action, "stop") == 0) {
    err = CemOhpcfWriteStopCommand(bridge.cem_ohpcf, addr, WriteResult, CmdCtx(cmd));
  } else if (action != NULL && strcmp(action, "pause") == 0) {
    err = CemOhpcfWritePauseCommand(bridge.cem_ohpcf, addr, WriteResult, CmdCtx(cmd));
  } else if (action != NULL && strcmp(action, "resume") == 0) {
    err = CemOhpcfWriteResumeCommand(bridge.cem_ohpcf, addr, WriteResult, CmdCtx(cmd));
  }
  EntityAddressDelete(addr);
  Reply(cmd, err == kEebusErrorOk, err == kEebusErrorOk ? NULL : "ohpcf command failed");
}

static void CmdStatus(const cJSON* cmd) {
  cJSON* ev = OutEvent("status");
  AddStr(ev, "ski", EEBUS_SERVICE_GET_LOCAL_SKI(bridge.service));
  LoadLimit l = {0};
  if (CsLpGetActivePowerLimit(bridge.cs_lpc, &l) == kEebusErrorOk) {
    cJSON* o = cJSON_AddObjectToObject(ev, "lpc");
    cJSON_AddNumberToObject(o, "w", ScaledToDouble(&l.value));
    cJSON_AddBoolToObject(o, "active", l.is_active);
    cJSON_AddBoolToObject(o, "heartbeat_ok", CsLpIsHeartbeatWithinDuration(bridge.cs_lpc));
  }
  if (CsLpGetActivePowerLimit(bridge.cs_lpp, &l) == kEebusErrorOk) {
    cJSON* o = cJSON_AddObjectToObject(ev, "lpp");
    cJSON_AddNumberToObject(o, "w", ScaledToDouble(&l.value));
    cJSON_AddBoolToObject(o, "active", l.is_active);
    cJSON_AddBoolToObject(o, "heartbeat_ok", CsLpIsHeartbeatWithinDuration(bridge.cs_lpp));
  }
  const cJSON* id = cJSON_GetObjectItemCaseSensitive(cmd, "id");
  if (cJSON_IsNumber(id)) {
    cJSON_AddNumberToObject(ev, "id", id->valuedouble);
  }
  OutEmit(ev);
}

void BridgeHandleCommand(const cJSON* cmd) {
  const char* name = Str(cmd, "cmd");
  if (name == NULL || bridge.service == NULL) {
    Reply(cmd, false, "no command");
    return;
  }
  if (strcmp(name, "trust") == 0) {
    CmdTrust(cmd, true);
  } else if (strcmp(name, "untrust") == 0) {
    CmdTrust(cmd, false);
  } else if (strcmp(name, "pairing") == 0) {
    EEBUS_SERVICE_SET_PAIRING_POSSIBLE(bridge.service, Bool(cmd, "on", false));
    Reply(cmd, true, NULL);
  } else if (strcmp(name, "cancel_pairing") == 0) {
    const char* ski = Str(cmd, "ski");
    if (ski != NULL) {
      EEBUS_SERVICE_CANCEL_PAIRING_WITH_SKI(bridge.service, ski);
    }
    Reply(cmd, ski != NULL, ski != NULL ? NULL : "ski missing");
  } else if (strcmp(name, "grid_config") == 0) {
    CmdGridConfig(cmd);
  } else if (strcmp(name, "grid_limit_state") == 0) {
    CmdGridLimitState(cmd);
  } else if (strcmp(name, "gcp") == 0) {
    CmdGcp(cmd);
  } else if (strcmp(name, "device_limit") == 0) {
    CmdDeviceLimit(cmd);
  } else if (strcmp(name, "device_failsafe") == 0) {
    CmdDeviceFailsafe(cmd);
  } else if (strcmp(name, "ohpcf") == 0) {
    CmdOhpcf(cmd);
  } else if (strcmp(name, "status") == 0) {
    CmdStatus(cmd);
  } else {
    Reply(cmd, false, "unknown command");
  }
}

void BridgeTick(void) {
  if (bridge.service == NULL) {
    return;
  }
  const int lpc = CsLpIsHeartbeatWithinDuration(bridge.cs_lpc) ? 1 : 0;
  const int lpp = CsLpIsHeartbeatWithinDuration(bridge.cs_lpp) ? 1 : 0;
  if (lpc != bridge.last_lpc_heartbeat_ok || lpp != bridge.last_lpp_heartbeat_ok) {
    bridge.last_lpc_heartbeat_ok = lpc;
    bridge.last_lpp_heartbeat_ok = lpp;
    cJSON* ev                    = OutEvent("grid_heartbeat_state");
    cJSON_AddBoolToObject(ev, "lpc_ok", lpc == 1);
    cJSON_AddBoolToObject(ev, "lpp_ok", lpp == 1);
    OutEmit(ev);
  }
}

void BridgeStop(void) {
  if (bridge.service != NULL) {
    EEBUS_SERVICE_STOP(bridge.service);
  }
  // Use cases unsubscribe from the service's event manager while being
  // destroyed, so they go before the service (same order as the examples).
  if (bridge.cs_lpc != NULL) {
    CsLpSetWriteApprover(bridge.cs_lpc, NULL);
    UseCaseDelete(USE_CASE_OBJECT(bridge.cs_lpc));
  }
  if (bridge.cs_lpp != NULL) {
    CsLpSetWriteApprover(bridge.cs_lpp, NULL);
    UseCaseDelete(USE_CASE_OBJECT(bridge.cs_lpp));
  }
  if (bridge.eg_lpc != NULL) {
    UseCaseDelete(USE_CASE_OBJECT(bridge.eg_lpc));
  }
  if (bridge.eg_lpp != NULL) {
    UseCaseDelete(USE_CASE_OBJECT(bridge.eg_lpp));
  }
  if (bridge.ma_mpc != NULL) {
    UseCaseDelete(USE_CASE_OBJECT(bridge.ma_mpc));
  }
  if (bridge.cem_ohpcf != NULL) {
    UseCaseDelete(USE_CASE_OBJECT(bridge.cem_ohpcf));
  }
  if (bridge.gcp_mgcp != NULL) {
    UseCaseDelete(USE_CASE_OBJECT(bridge.gcp_mgcp));
  }
  if (bridge.service != NULL) {
    EebusServiceDelete(bridge.service);
  }
  EebusServiceConfigDelete(bridge.cfg);
  TlsCertificateDelete(bridge.tls);
  EntityAddressListRelease(&bridge.eg_lpc_remotes);
  EntityAddressListRelease(&bridge.eg_lpp_remotes);
  EntityAddressListRelease(&bridge.ma_mpc_remotes);
  EntityAddressListRelease(&bridge.ohpcf_remotes);
  memset(&bridge, 0, sizeof(bridge));
}
