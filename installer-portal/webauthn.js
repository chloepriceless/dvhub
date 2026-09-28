// installer-portal/webauthn.js — WebAuthn/Passkey-Verifikation ohne Libraries.
//
// bewusster Umfang:
//  · attestation 'none' (kein Trust-Fingerprint der Modellreihe nötig —
//    die Sicherheitsaussage kommt aus der Signatur, nicht vom Attest-Zertifikat)
//  · COSE EC2 P-256/ES256 (alg -7) — Apple/Microsoft/Android/FIDO2-Security-
//    Keys erzeugen das ausnahmslos; andere Kurven geben klare Fehlermeldung
//  · minimaler CBOR-Decoder (map/array/bytes/text/int/taggen genügt hier)
//
// Verifikation pro Spec (L2, §7.1 Registrierung / §7.2 Assertion):
// clientDataJSON: Typ + Challenge + Origin; authData: rpIdHash + UP-Flag;
// Signatur über authData || SHA-256(clientDataJSON-Bytes).

import crypto from 'node:crypto';

// ---------- base64url ----------
export const b64urlBuf = (s) => Buffer.from(String(s), 'base64url');
export const bufB64url = (b) => Buffer.from(b).toString('base64url');

// ---------- minimaler CBOR-Decoder (RFC 8949 Subset) ----------
// Gibt [wert, neuerOffset] zurück. Map → JS-Map (int- UND text-keys),
// Bytes → Buffer, Tags → Inhalt direkt.
export function cborDecode(buf, off = 0) {
  if (off >= buf.length) throw new Error('cbor_truncated');
  const initial = buf[off++];
  const mt = initial >> 5;
  const ai = initial & 31;
  let len = null;
  if (ai < 24) len = ai;
  else if (ai === 24) len = buf[off++];
  else if (ai === 25) { len = buf.readUInt16BE(off); off += 2; }
  else if (ai === 26) { len = buf.readUInt32BE(off); off += 4; }
  else if (ai === 27) { len = buf.readUInt32BE(off) * 2 ** 32 + buf.readUInt32BE(off + 4); off += 8; }
  else if (ai === 31) len = null; // indefinite
  else throw new Error('cbor_reserved_ai');
  switch (mt) {
    case 0: return [len, off];
    case 1: return [-1 - len, off];
    case 2: {
      if (len === null) { const end = buf.indexOf(0xff, off); return [Buffer.from(buf.subarray(off, end)), end + 1]; }
      if (off + len > buf.length) throw new Error('cbor_truncated');
      return [Buffer.from(buf.subarray(off, off + len)), off + len];
    }
    case 3: {
      if (len === null) { const end = buf.indexOf(0xff, off); return [buf.toString('utf8', off, end), end + 1]; }
      return [buf.toString('utf8', off, off + len), off + len];
    }
    case 4: {
      const arr = [];
      if (len === null) { while (buf[off] !== 0xff) { const [v, o] = cborDecode(buf, off); arr.push(v); off = o; } off++; }
      else for (let i = 0; i < len; i++) { const [v, o] = cborDecode(buf, off); arr.push(v); off = o; }
      return [arr, off];
    }
    case 5: {
      const m = new Map();
      if (len === null) { while (buf[off] !== 0xff) { const [k, o1] = cborDecode(buf, off); const [v, o2] = cborDecode(buf, o1); m.set(k, v); off = o2; } off++; }
      else for (let i = 0; i < len; i++) { const [k, o1] = cborDecode(buf, off); const [v, o2] = cborDecode(buf, o1); m.set(k, v); off = o2; }
      return [m, off];
    }
    case 6: return cborDecode(buf, off); // Tag: Inhalt direkt verwenden
    default: throw new Error('cbor_untersupported_mt');
  }
}

// ---------- COSE EC2 P-256 → crypto-KeyObject ----------
// COSE-Key (Map): 1=kty(2=EC2), 3=alg(-7=ES256), -1=crv(1=P-256), -2=x, -3=y
// → SPKI-DER: SEQUENCE{SEQUENCE{ecPublicKey OID, prime256v1 OID}, BITSTRING 04||x||y}
const ECDSA_OID = Buffer.from('06072a8648ce3d0201', 'hex');
const P256_OID = Buffer.from('06082a8648ce3d030107', 'hex');

export function coseToKey(coseMap) {
  const kty = coseMap.get(1), crv = coseMap.get(-1), x = coseMap.get(-2), y = coseMap.get(-3);
  if (kty !== 2 || crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
    throw new Error('nur_EC2_P256_unterstuetzt');
  }
  const pub = Buffer.concat([Buffer.from([0x04]), x, y]);
  const algoSeq = Buffer.concat([Buffer.from([0x30, 0x13]), ECDSA_OID, P256_OID]);
  const bitString = Buffer.concat([Buffer.from([0x03, 0x42, 0x00]), pub]);
  const der = Buffer.concat([Buffer.from([0x30, algoSeq.length + bitString.length]), algoSeq, bitString]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

// Raw-Röhre: WebAuthn-Signaturen sind je nach Plattform DER ODER fix 64 Byte
// (r||s). Beides akzeptieren, beides auf DER normalisieren.
function sigToDer(sig) {
  if (sig.length === 64) {
    const trimInt = (b) => {
      let i = 0; while (i < b.length - 1 && b[i] === 0) i++;
      const body = b.subarray(i);
      return Buffer.concat([Buffer.from([0x02, body.length + (body[0] & 0x80 ? 1 : 0)]), body[0] & 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body]);
    };
    const rs = Buffer.concat([trimInt(sig.subarray(0, 32)), trimInt(sig.subarray(32))]);
    return Buffer.concat([Buffer.from([0x30, rs.length]), rs]);
  }
  return sig; // DER assumed
}

// ---------- authenticatorData (§6.1) ----------
// rpIdHash(32) flags(1) count(4) [aaguid(16) credIdLen(2) credId credPublicKey(CBOR)]
export function parseAuthData(ad) {
  if (!Buffer.isBuffer(ad) || ad.length < 37) throw new Error('authdatan_kurz');
  const flags = ad[32];
  const out = {
    rpIdHash: ad.subarray(0, 32).toString('hex'),
    flags,
    up: !!(flags & 0x01),
    uv: !!(flags & 0x04),
    counter: ad.readUInt32BE(33),
  };
  if (flags & 0x40) { // ATED — nur bei Registrierung
    if (ad.length < 55) throw new Error('authdatan_kurz');
    const credIdLen = ad.readUInt16BE(53);
    // Spec (§6.1): höchstens 1023 Byte — längere IDs ablehnen (Portal-Routen
    // und Löschen rechnen mit dieser Obergrenze).
    if (credIdLen < 1 || credIdLen > 1023 || ad.length < 55 + credIdLen) throw new Error('credid_laenge');
    out.aaguid = ad.subarray(37, 53).toString('hex');
    out.credId = bufB64url(ad.subarray(55, 55 + credIdLen));
    const coseStart = 55 + credIdLen;
    const [coseMap, endOff] = cborDecode(ad, coseStart);
    out.coseBytes = Buffer.from(ad.subarray(coseStart, endOff));
    out.cose = coseMap;
  }
  return out;
}

function checkClientData(cdB64, { expectedType, expectedChallenge, expectedOrigin }) {
  const raw = b64urlBuf(cdB64);
  let cd;
  try { cd = JSON.parse(raw.toString('utf8')); } catch { throw new Error('clientdata_jsonungueltig'); }
  if (cd.type !== expectedType) throw new Error('clientdata_typ');
  if (cd.challenge !== expectedChallenge) throw new Error('clientdata_challenge');
  if (expectedOrigin && cd.origin !== expectedOrigin) throw new Error('clientdata_origin');
  return raw;
}

// Registrierung verifizieren (§7.1). Gibt die zu speichernden Felder zurück.
export function verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, expectedOrigin, expectedRpIdHash }) {
  const raw = checkClientData(clientDataJSON, { expectedType: 'webauthn.create', expectedChallenge, expectedOrigin });
  const [attObj] = cborDecode(b64urlBuf(attestationObject));
  if (!(attObj instanceof Map)) throw new Error('attestationobjektcbor');
  const fmt = attObj.get('fmt');
  if (fmt !== 'none') throw new Error('nur_attestation_none');
  const ad = parseAuthData(attObj.get('authData'));
  if (expectedRpIdHash && ad.rpIdHash !== expectedRpIdHash) throw new Error('rpid_hash');
  if (!ad.up) throw new Error('up_flag_fehlt');
  if (!ad.cose) throw new Error('kein_public_key');
  coseToKey(ad.cose); // wirft bei nicht unterstützten Kurven
  void raw;
  return {
    id: ad.credId,
    publicKey: Buffer.from(ad.coseBytes).toString('base64'),
    algorithm: -7,
    counter: ad.counter,
    aaguid: ad.aaguid,
  };
}

// Assertion verifizieren (§7.2). cred: {publicKey (b64-COSE)}.
// requireUV: beim passwortlosen Login ist der Passkey der EINZIGE Faktor —
// dann muss der Authenticator den Nutzer verifiziert haben (PIN/Biometrie),
// bloße Anwesenheit (UP) eines Keys ohne PIN reicht nicht.
export function verifyAssertion({ authenticatorData, clientDataJSON, signature, expectedChallenge, expectedOrigin, expectedRpIdHash, credential, requireUV = false }) {
  const raw = checkClientData(clientDataJSON, { expectedType: 'webauthn.get', expectedChallenge, expectedOrigin });
  const ad = parseAuthData(b64urlBuf(authenticatorData));
  if (expectedRpIdHash && ad.rpIdHash !== expectedRpIdHash) throw new Error('rpid_hash');
  if (!ad.up) throw new Error('up_flag_fehlt');
  if (requireUV && !ad.uv) throw new Error('uv_fehlt');
  const [coseMap] = cborDecode(b64urlBuf(credential.publicKey));
  const key = coseToKey(coseMap);
  const signed = Buffer.concat([b64urlBuf(authenticatorData), crypto.createHash('sha256').update(raw).digest()]);
  const ok = crypto.verify('sha256', signed, key, sigToDer(b64urlBuf(signature)));
  if (!ok) throw new Error('signatur_ungueltig');
  return { counter: ad.counter, flags: ad.flags };
}
