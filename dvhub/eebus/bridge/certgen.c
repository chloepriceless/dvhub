/*
 * dvhub-eebus — SHIP certificate generation.
 *
 * SHIP (EEBUS) identifies a node by the Subject Key Identifier (SKI) of its
 * self-signed certificate: EC prime256v1, SHA-256 signature, SKI extension
 * computed from the public key ("hash"). The private key never leaves the
 * device; DVhub keeps both files in its data directory and includes them in
 * the encrypted device-replacement export so pairings survive a device swap.
 */
#include "certgen.h"

#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#include <stdio.h>
#include <sys/stat.h>

#include "out.h"

static int AddExt(X509* cert, X509* issuer, int nid, const char* value) {
  X509V3_CTX ctx;
  X509V3_set_ctx_nodb(&ctx);
  X509V3_set_ctx(&ctx, issuer, cert, NULL, NULL, 0);
  X509_EXTENSION* ext = X509V3_EXT_conf_nid(NULL, &ctx, nid, value);
  if (ext == NULL) {
    return 0;
  }
  const int ok = X509_add_ext(cert, ext, -1);
  X509_EXTENSION_free(ext);
  return ok;
}

int CertGenerate(const char* cert_path, const char* key_path, const char* common_name) {
  int rc        = 1;
  EVP_PKEY* key = EVP_EC_gen("P-256");
  X509* cert    = X509_new();
  FILE* fkey    = NULL;
  FILE* fcert   = NULL;

  if (key == NULL || cert == NULL) {
    OutLog("certgen: key or certificate allocation failed");
    goto done;
  }

  X509_set_version(cert, 2);  // v3
  // Random 64-bit serial
  ASN1_INTEGER* serial = X509_get_serialNumber(cert);
  BIGNUM* bn           = BN_new();
  if (bn == NULL || !BN_rand(bn, 63, BN_RAND_TOP_ANY, BN_RAND_BOTTOM_ANY) || !BN_to_ASN1_INTEGER(bn, serial)) {
    BN_free(bn);
    OutLog("certgen: serial failed");
    goto done;
  }
  BN_free(bn);

  X509_gmtime_adj(X509_getm_notBefore(cert), -24L * 3600L);
  X509_gmtime_adj(X509_getm_notAfter(cert), 10L * 365L * 24L * 3600L);
  X509_set_pubkey(cert, key);

  X509_NAME* name = X509_get_subject_name(cert);
  X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_UTF8, (const unsigned char*)common_name, -1, -1, 0);
  X509_NAME_add_entry_by_txt(name, "O", MBSTRING_UTF8, (const unsigned char*)"DVhub", -1, -1, 0);
  X509_set_issuer_name(cert, name);

  if (!AddExt(cert, cert, NID_subject_key_identifier, "hash")
      || !AddExt(cert, cert, NID_basic_constraints, "critical,CA:TRUE")
      || !AddExt(cert, cert, NID_key_usage, "critical,digitalSignature,keyCertSign")) {
    OutLog("certgen: extensions failed");
    goto done;
  }

  if (!X509_sign(cert, key, EVP_sha256())) {
    OutLog("certgen: signing failed");
    goto done;
  }

  // Private key with owner-only permissions.
  const mode_t old_mask = umask(077);
  fkey                  = fopen(key_path, "w");
  umask(old_mask);
  if (fkey == NULL || !PEM_write_PrivateKey(fkey, key, NULL, NULL, 0, NULL, NULL)) {
    OutLog("certgen: cannot write %s", key_path);
    goto done;
  }
  fcert = fopen(cert_path, "w");
  if (fcert == NULL || !PEM_write_X509(fcert, cert)) {
    OutLog("certgen: cannot write %s", cert_path);
    goto done;
  }
  rc = 0;

done:
  if (fkey != NULL) {
    fclose(fkey);
  }
  if (fcert != NULL) {
    fclose(fcert);
  }
  X509_free(cert);
  EVP_PKEY_free(key);
  return rc;
}
