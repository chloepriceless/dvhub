package main

// SHIP-Zertifikat erzeugen — wie bridge/certgen.c.
//
// SHIP (EEBUS) erkennt einen Knoten an der Subject Key Identifier (SKI) seines
// selbst signierten Zertifikats: EC prime256v1, SHA-256-Signatur, SKI aus dem
// öffentlichen Schlüssel (SHA-1 des unkomprimierten Punkts, OpenSSL "hash").
// Zertifikate der C-Bridge gelten unverändert weiter (cert_test.go).

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1" // #nosec G505 — SKI ist laut SHIP/RFC 5280 SHA-1
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"time"

	"github.com/enbility/ship-go/cert"
)

func generateCert(certPath, keyPath, commonName string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("certgen: key: %w", err)
	}
	ecdhKey, err := key.PublicKey.ECDH()
	if err != nil {
		return fmt.Errorf("certgen: key: %w", err)
	}
	ski := sha1.Sum(ecdhKey.Bytes()) // #nosec G401
	// Zufällige 63-Bit-Seriennummer (certgen.c BN_rand(63)).
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 63))
	if err != nil {
		return fmt.Errorf("certgen: serial: %w", err)
	}
	name := pkix.Name{CommonName: commonName, Organization: []string{"DVhub"}}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               name,
		Issuer:                name,
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		SignatureAlgorithm:    x509.ECDSAWithSHA256,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		SubjectKeyId:          ski[:],
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("certgen: signing: %w", err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return fmt.Errorf("certgen: key: %w", err)
	}
	// Privater Schlüssel nur für den Besitzer lesbar.
	if err := writeFileAtomic(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}), 0o600); err != nil {
		return fmt.Errorf("certgen: cannot write %s: %w", keyPath, err)
	}
	if err := writeFileAtomic(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return fmt.Errorf("certgen: cannot write %s: %w", certPath, err)
	}
	return nil
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	_ = os.Remove(path)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// loadCertificate lädt Zertifikat und Schlüssel und gibt die SKI zurück.
func loadCertificate(certPath, keyPath string) (tls.Certificate, string, error) {
	pair, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	if len(pair.Certificate) == 0 {
		return tls.Certificate{}, "", errors.New("no certificate")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return tls.Certificate{}, "", err
	}
	ski, err := cert.SkiFromCertificate(leaf)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	pair.Leaf = leaf
	return pair, ski, nil
}

func skiOfFiles(certPath, keyPath string) (string, error) {
	_, ski, err := loadCertificate(certPath, keyPath)
	return ski, err
}
