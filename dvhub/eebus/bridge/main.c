/*
 * dvhub-eebus — EEBUS (SHIP/SPINE) node for DVhub, built on openeebus by NIBE.
 *
 * Usage:
 *   dvhub-eebus --gen-cert <cert.pem> <key.pem> <common-name>
 *   dvhub-eebus --port 4712 --cert <cert.pem> --key <key.pem>
 *               [--vendor DVhub] [--brand DVhub] [--model DVhub] [--serial <id>]
 *               [--role auto|client|server] [--trust <ski>]...
 *
 * Protocol with DVhub (one JSON object per line):
 *   stdin  — commands {"cmd": "...", "id": n, ...}            (bridge.c, BridgeHandleCommand)
 *   stdout — events   {"ev": "...", ...}                      (bridge.c)
 *   stderr — diagnostics (libwebsockets, errors)
 * When stdin closes (DVhub stopped or crashed) the process shuts down.
 */
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "bridge.h"
#include "certgen.h"
#include "cJSON.h"
#include "out.h"

static volatile sig_atomic_t should_stop = 0;

static void OnSignal(int sig) {
  (void)sig;
  should_stop = 1;
}

static void* TickThread(void* arg) {
  (void)arg;
  while (!should_stop) {
    for (int i = 0; i < 50 && !should_stop; ++i) {
      const struct timespec ts = {.tv_sec = 0, .tv_nsec = 100 * 1000 * 1000};
      nanosleep(&ts, NULL);
    }
    if (!should_stop) {
      BridgeTick();
    }
  }
  return NULL;
}

static void Usage(void) {
  fprintf(stderr,
          "usage: dvhub-eebus --gen-cert <cert> <key> <cn>\n"
          "       dvhub-eebus --port <p> --cert <cert> --key <key> [--vendor v] [--brand b] [--model m]\n"
          "                   [--serial s] [--role auto|client|server] [--trust <ski>]...\n");
}

int main(int argc, char** argv) {
  if (argc >= 2 && strcmp(argv[1], "--gen-cert") == 0) {
    if (argc != 5) {
      Usage();
      return 2;
    }
    return CertGenerate(argv[2], argv[3], argv[4]) == 0 ? 0 : 1;
  }

  BridgeOptions opts = {
      .port      = 4712,
      .cert_path = NULL,
      .key_path  = NULL,
      .vendor    = "DVhub",
      .brand     = "DVhub",
      .model     = "DVhub",
      .serial    = "0",
      .role      = "auto",
  };
  const char* trusted[32];
  size_t trusted_count = 0;

  for (int i = 1; i < argc; ++i) {
    const char* a = argv[i];
    const char* v = i + 1 < argc ? argv[i + 1] : NULL;
    if (v == NULL) {
      Usage();
      return 2;
    }
    if (strcmp(a, "--port") == 0) {
      opts.port = atoi(v);
    } else if (strcmp(a, "--cert") == 0) {
      opts.cert_path = v;
    } else if (strcmp(a, "--key") == 0) {
      opts.key_path = v;
    } else if (strcmp(a, "--vendor") == 0) {
      opts.vendor = v;
    } else if (strcmp(a, "--brand") == 0) {
      opts.brand = v;
    } else if (strcmp(a, "--model") == 0) {
      opts.model = v;
    } else if (strcmp(a, "--serial") == 0) {
      opts.serial = v;
    } else if (strcmp(a, "--role") == 0) {
      opts.role = v;
    } else if (strcmp(a, "--trust") == 0) {
      if (trusted_count < sizeof(trusted) / sizeof(trusted[0])) {
        trusted[trusted_count++] = v;
      }
    } else {
      Usage();
      return 2;
    }
    ++i;
  }
  if (opts.cert_path == NULL || opts.key_path == NULL || opts.port <= 0 || opts.port > 65535) {
    Usage();
    return 2;
  }

  signal(SIGINT, OnSignal);
  signal(SIGTERM, OnSignal);
  signal(SIGPIPE, SIG_IGN);

  if (BridgeStart(&opts) != 0) {
    cJSON* ev = OutEvent("fatal");
    cJSON_AddStringToObject(ev, "error", "start failed");
    OutEmit(ev);
    BridgeStop();
    return 1;
  }
  for (size_t i = 0; i < trusted_count; ++i) {
    cJSON* cmd = cJSON_CreateObject();
    cJSON_AddStringToObject(cmd, "cmd", "trust");
    cJSON_AddStringToObject(cmd, "ski", trusted[i]);
    BridgeHandleCommand(cmd);
    cJSON_Delete(cmd);
  }

  pthread_t tick;
  pthread_create(&tick, NULL, TickThread, NULL);

  // Commands are short; anything longer than this is not ours.
  static char line[16384];
  while (!should_stop && fgets(line, sizeof(line), stdin) != NULL) {
    const size_t len = strlen(line);
    if (len == 0 || line[0] == '\n') {
      continue;
    }
    cJSON* cmd = cJSON_Parse(line);
    if (cmd == NULL || !cJSON_IsObject(cmd)) {
      OutLog("ignoring malformed command");
      cJSON_Delete(cmd);
      continue;
    }
    BridgeHandleCommand(cmd);
    cJSON_Delete(cmd);
  }

  should_stop = 1;
  pthread_join(tick, NULL);
  BridgeStop();
  OutLog("stopped");
  return 0;
}
