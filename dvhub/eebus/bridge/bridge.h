/*
 * dvhub-eebus — EEBUS node of DVhub (openeebus by NIBE).
 *
 * Local SPINE device "EnergyManagementSystem" with four entities:
 *   [1] CEM  — grid side, CS LPC (§14a EnWG control box / grid operator,
 *              a.k.a. "Steuerbox"; DVhub is the Controllable System)
 *   [2] CEM  — grid side, CS LPP (production limit); own entity, see AddGridSide
 *   [3] CEM  — device side: EG LPC + EG LPP (limit EEBUS heat pumps, wallboxes,
 *              inverters), MA MPC (read their power), CEM OHPCF (schedule heat
 *              pump compressor flexibility)
 *   [4] GridConnectionPointOfPremises — GCP MGCP (DVhub's grid meter)
 *
 * DVhub owns all decisions; this process only speaks the protocol. Commands
 * arrive as NDJSON on stdin, events leave as NDJSON on stdout (see main.c).
 */
#ifndef DVHUB_EEBUS_BRIDGE_H_
#define DVHUB_EEBUS_BRIDGE_H_

#include <stdbool.h>
#include <stdint.h>

#include "cJSON.h"

typedef struct BridgeOptions BridgeOptions;

struct BridgeOptions {
  int32_t port;
  const char* cert_path;
  const char* key_path;
  const char* vendor;
  const char* brand;
  const char* model;
  const char* serial;
  const char* role;  // "auto" | "client" | "server"
};

/** Start the EEBUS service. Returns 0 on success. */
int BridgeStart(const BridgeOptions* opts);

/** Handle one command object from DVhub (main thread). */
void BridgeHandleCommand(const cJSON* cmd);

/** Periodic housekeeping (heartbeat state of the grid side), ~every 5 s. */
void BridgeTick(void);

/** Stop and release everything. */
void BridgeStop(void);

#endif  // DVHUB_EEBUS_BRIDGE_H_
