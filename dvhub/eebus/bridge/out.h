/*
 * dvhub-eebus — thread-safe NDJSON event output to DVhub (stdout).
 *
 * Every line on stdout is exactly one JSON object. openeebus calls our
 * listeners from its own threads, so all writes go through one mutex.
 * Diagnostics go to stderr, never to stdout.
 */
#ifndef DVHUB_EEBUS_OUT_H_
#define DVHUB_EEBUS_OUT_H_

#include <stdbool.h>
#include <stdint.h>

#include "cJSON.h"

/** Write one event object and free it. */
void OutEmit(cJSON* obj);

/** Create an event object {"ev": name}. */
cJSON* OutEvent(const char* name);

/** Convenience: {"ev": name, "ski": ski} */
void OutEmitSki(const char* name, const char* ski);

/** Log a line to stderr (prefixed with the program name). */
void OutLog(const char* fmt, ...) __attribute__((format(printf, 1, 2)));

#endif  // DVHUB_EEBUS_OUT_H_
