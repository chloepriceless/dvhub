package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/enbility/ship-go/cert"
)

// Mit OpenSSL wie certgen.c erzeugt (EC P-256, SHA-256, SKI "hash",
// CA:TRUE kritisch, keyUsage kritisch). SKI laut `openssl x509 -ext subjectKeyIdentifier`.
const opensslFixtureSKI = "6d886692f4739c6278b41a176a5fc7c9c829a275"

func TestVorhandenesOpenSSLZertifikatGiltWeiter(t *testing.T) {
	// Nur für diesen Test erzeugt (nirgends sonst verwendet).
	ski, err := skiOfFiles("testdata/fixtures/openssl-cert.pem", "testdata/fixtures/openssl-key.pem")
	if err != nil {
		t.Fatal(err)
	}
	if ski != opensslFixtureSKI {
		t.Fatalf("SKI %s, erwartet %s — gekoppelte Gegenstellen würden DVhub nicht mehr erkennen", ski, opensslFixtureSKI)
	}
}

func TestGenCertWieCertgenC(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := generateCert(certPath, keyPath, "DVhub-TEST"); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("Schlüssel nur für den Besitzer: %v", st.Mode().Perm())
	}
	keyPEM, _ := os.ReadFile(keyPath)
	if blk, _ := pem.Decode(keyPEM); blk == nil || blk.Type != "PRIVATE KEY" {
		t.Fatal("Schlüssel als PKCS#8 (PEM_write_PrivateKey)")
	}
	pair, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if leaf.Subject.CommonName != "DVhub-TEST" || len(leaf.Subject.Organization) != 1 || leaf.Subject.Organization[0] != "DVhub" {
		t.Fatalf("subject %v", leaf.Subject)
	}
	if !leaf.IsCA || !leaf.BasicConstraintsValid {
		t.Fatal("CA:TRUE")
	}
	if leaf.KeyUsage != x509.KeyUsageDigitalSignature|x509.KeyUsageCertSign {
		t.Fatalf("keyUsage %v", leaf.KeyUsage)
	}
	if leaf.SignatureAlgorithm != x509.ECDSAWithSHA256 {
		t.Fatalf("sig %v", leaf.SignatureAlgorithm)
	}
	if pub, ok := leaf.PublicKey.(*ecdsa.PublicKey); !ok || pub.Curve != elliptic.P256() {
		t.Fatal("EC P-256")
	}
	if leaf.NotBefore.After(time.Now().Add(-23*time.Hour)) || leaf.NotAfter.Before(time.Now().Add(9*365*24*time.Hour)) {
		t.Fatalf("gültig ab gestern für 10 Jahre: %v – %v", leaf.NotBefore, leaf.NotAfter)
	}
	if leaf.SerialNumber.BitLen() > 63 {
		t.Fatal("Seriennummer 63 Bit wie certgen.c")
	}
	// ship-go prüft SKI == SHA-1 des öffentlichen Schlüssels.
	ski, err := cert.SkiFromCertificate(leaf)
	if err != nil || len(ski) != 40 {
		t.Fatalf("ski %q %v", ski, err)
	}
}
