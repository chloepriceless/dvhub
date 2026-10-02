#ifndef DVHUB_EEBUS_CERTGEN_H_
#define DVHUB_EEBUS_CERTGEN_H_

/** Generate a SHIP certificate (EC P-256, self-signed, SKI). Returns 0 on success. */
int CertGenerate(const char* cert_path, const char* key_path, const char* common_name);

#endif  // DVHUB_EEBUS_CERTGEN_H_
