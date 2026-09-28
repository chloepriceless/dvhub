// installer-portal/test/fake-auth.js — minimales WebAuthn-Authenticator-
// Modell für Tests (CBOR-Encoder + P-256-Signaturen nach Spec).
import crypto from 'node:crypto';

export const enc = (v) => {
  const head = (mt, n) => n < 24 ? Buffer.concat([Buffer.from([(mt << 5) | n])])
    : n < 256 ? Buffer.concat([Buffer.from([(mt << 5) | 24, n])])
    : Buffer.concat([Buffer.from([(mt << 5) | 25]), Buffer.from([n >> 8, n & 0xff])]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(enc)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
  throw new Error('enc: ' + typeof v);
};

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

// opts.uv=false: Authenticator ohne Nutzer-Verifikation (z. B. Key ohne PIN).
// opts.credIdBytes: Länge der Credential-ID (Default 16).
export function makeAuthenticator(rpId = 'localhost', { uv = true, credIdBytes = 16 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  const credId = crypto.randomBytes(credIdBytes);
  const rpIdHash = sha256(Buffer.from(rpId, 'utf8'));
  let counter = 0;
  const authData = (withCred) => {
    const flags = 0x01 | (uv ? 0x04 : 0) | (withCred ? 0x40 : 0);
    const base = Buffer.concat([rpIdHash, Buffer.from([flags]), Buffer.from([0, 0, 0, ++counter])]);
    if (!withCred) return base;
    const cidLen = Buffer.alloc(2); cidLen.writeUInt16BE(credId.length);
    return Buffer.concat([base, Buffer.alloc(16), cidLen, credId, enc(cose)]);
  };
  return {
    create(origin, challenge) {
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }), 'utf8');
      const attObj = enc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(true)]]));
      return {
        id: b64u(credId),
        response: { clientDataJSON: b64u(cd), attestationObject: b64u(attObj) },
      };
    },
    get(origin, challenge) {
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }), 'utf8');
      const ad = authData(false);
      const sig = crypto.sign('sha256', Buffer.concat([ad, sha256(cd)]), privateKey);
      return {
        id: b64u(credId),
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig) },
      };
    },
  };
}
