#include "out.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

static pthread_mutex_t out_mutex = PTHREAD_MUTEX_INITIALIZER;

void OutEmit(cJSON* obj) {
  if (obj == NULL) {
    return;
  }
  char* line = cJSON_PrintUnformatted(obj);
  cJSON_Delete(obj);
  if (line == NULL) {
    return;
  }
  pthread_mutex_lock(&out_mutex);
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  pthread_mutex_unlock(&out_mutex);
  free(line);
}

cJSON* OutEvent(const char* name) {
  cJSON* obj = cJSON_CreateObject();
  if (obj != NULL) {
    cJSON_AddStringToObject(obj, "ev", name);
  }
  return obj;
}

void OutEmitSki(const char* name, const char* ski) {
  cJSON* obj = OutEvent(name);
  if (obj == NULL) {
    return;
  }
  cJSON_AddStringToObject(obj, "ski", ski != NULL ? ski : "");
  OutEmit(obj);
}

void OutLog(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  pthread_mutex_lock(&out_mutex);
  fputs("dvhub-eebus: ", stderr);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  fflush(stderr);
  pthread_mutex_unlock(&out_mutex);
  va_end(ap);
}
