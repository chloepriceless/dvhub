#!/usr/bin/env python3
# support-relay/enroll-from-portal.py — trägt Anlagen auf Auftrag des Portals
# beim Fern-Support-Relay ein (2026-10-14).
#
# Läuft als root auf dem Relay-Server (support.dvhub.de = portal.dvhub.de),
# ausgelöst von support-relay-enroll.path, sobald das Portal einen Auftrag
# ablegt. Ersetzt den Handgriff „Schlüssel nach keys/, Ports in registry.json,
# build-authorized-keys.sh“.
#
# Vertrauensgrenze: Das Portal (Container, uid 1000) ist für dieses Skript
# NICHT vertrauenswürdig. Es darf nur Aufträge in REQUEST_DIR legen und
# Ergebnisse in RESULT_DIR lesen. Alles im Auftrag wird hier geprüft:
#   - appliance-id ^[a-z0-9-]{1,36}$ (wie build-authorized-keys.sh)
#   - genau ein öffentlicher Schlüssel erlaubten Typs, von ssh-keygen akzeptiert
#   - eine schon eingetragene Anlage behält Ports und Schlüssel; ein ANDERER
#     Schlüssel für dieselbe ID wird abgelehnt (key_mismatch, Handarbeit)
#   - Ports vergibt nur dieses Skript (kleinstes freies Paar, shell gerade,
#     web = shell + 1), nie das Portal
# Was eine Anlage damit bekommt, ist unverändert wenig: auf dem Relay zwei
# Ports auf 127.0.0.1 belegen (permitlisten), sonst nichts. In die Anlage
# hinein kommt weiterhin nur der Support-Schlüssel.
#
# Gerendert wird mit dem bestehenden build-authorized-keys.sh. Scheitert das,
# werden registry.json und der neue Schlüssel zurückgenommen (das Ziel ist
# dann ohnehin unverändert).

import fcntl
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import base64
import hashlib

BASE = os.environ.get('RELAY_DIR', '/opt/support-relay')
REGISTRY = os.environ.get('RELAY_REGISTRY', os.path.join(BASE, 'registry.json'))
KEYS_DIR = os.environ.get('RELAY_KEYS_DIR', os.path.join(BASE, 'keys'))
REQUEST_DIR = os.environ.get('RELAY_REQUEST_DIR', os.path.join(BASE, 'spool', 'requests'))
RESULT_DIR = os.environ.get('RELAY_RESULT_DIR', os.path.join(BASE, 'spool', 'results'))
RENDER = os.environ.get('RELAY_RENDER_CMD', os.path.join(BASE, 'build-authorized-keys.sh'))
LOCK = os.environ.get('RELAY_LOCK', os.path.join(BASE, '.registry.lock'))
LOG = os.environ.get('RELAY_ENROLL_LOG', '/var/log/support-relay-enroll.log')
RESULT_GID = int(os.environ.get('RELAY_RESULT_GID', '1000'))
PORT_MIN = int(os.environ.get('RELAY_PORT_MIN', '49000'))
PORT_MAX = int(os.environ.get('RELAY_PORT_MAX', '49999'))
MAX_APPLIANCES = int(os.environ.get('RELAY_MAX_APPLIANCES', '400'))
MAX_PER_RUN = 20
MAX_REQUEST_BYTES = 4096

ID_RE = re.compile(r'^[a-z0-9-]{1,36}$')
REQ_ID_RE = re.compile(r'^[a-f0-9]{8,64}$')
KEY_RE = re.compile(r'^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) ([A-Za-z0-9+/]{16,2000}={0,3})$')


def log(msg):
    line = time.strftime('%Y-%m-%dT%H:%M:%S%z') + ' ' + msg + '\n'
    try:
        with open(LOG, 'a') as f:
            f.write(line)
    except OSError:
        sys.stderr.write(line)


def fingerprint(key_type_data):
    data = key_type_data.split(' ', 1)[1]
    digest = hashlib.sha256(base64.b64decode(data)).digest()
    return 'SHA256:' + base64.b64encode(digest).decode().rstrip('=')


def normalize_key(text):
    """'<typ> <daten>' aus genau einer Zeile, sonst None."""
    lines = [l.strip() for l in str(text).splitlines() if l.strip()]
    if len(lines) != 1:
        return None
    parts = lines[0].split()
    if len(parts) < 2:
        return None
    cand = parts[0] + ' ' + parts[1]
    if not KEY_RE.match(cand):
        return None
    try:
        base64.b64decode(parts[1], validate=True)
    except Exception:
        return None
    return cand


def keygen_ok(key):
    with tempfile.NamedTemporaryFile('w', suffix='.pub', delete=False) as f:
        f.write(key + ' check\n')
        tmp = f.name
    try:
        return subprocess.run(['ssh-keygen', '-l', '-f', tmp], capture_output=True, timeout=10).returncode == 0
    finally:
        os.unlink(tmp)


def write_atomic(path, text, mode):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.enroll-')
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_request(path):
    """Auftrag lesen: keine Symlinks, nur reguläre Datei, höchstens 4 KB."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_REQUEST_BYTES:
            return None
        raw = os.read(fd, MAX_REQUEST_BYTES + 1)
    finally:
        os.close(fd)
    try:
        return json.loads(raw.decode('utf-8'))
    except Exception:
        return None


def write_result(aid, result):
    path = os.path.join(RESULT_DIR, aid + '.json')
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    try:
        if os.geteuid() == 0:
            os.fchown(fd, 0, RESULT_GID)
        os.write(fd, (json.dumps(result) + '\n').encode())
    finally:
        os.close(fd)


def load_registry():
    with open(REGISTRY) as f:
        reg = json.load(f)
    if not isinstance(reg, dict) or not isinstance(reg.get('appliances', {}), dict):
        raise ValueError('registry.json hat nicht die Form {"appliances": {...}}')
    reg.setdefault('appliances', {})
    return reg


def free_pair(reg):
    used = set()
    for entry in reg['appliances'].values():
        for k in ('shellPort', 'webPort'):
            try:
                used.add(int(entry.get(k)))
            except (TypeError, ValueError):
                pass
    start = PORT_MIN + (PORT_MIN % 2)
    for p in range(start, PORT_MAX, 2):
        if p not in used and p + 1 not in used and p + 1 <= PORT_MAX:
            return p, p + 1
    return None


def render():
    # Auch eine Zeitüberschreitung oder ein fehlendes Skript ist ein Fehlschlag —
    # sonst bliebe der Eintrag ohne gerenderte authorized_keys stehen.
    try:
        r = subprocess.run(['bash', RENDER], capture_output=True, text=True, timeout=60)
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, f'Renderer: {type(e).__name__}'
    return r.returncode == 0, (r.stderr or r.stdout or '').strip()[-300:]


def enroll(aid, req):
    """Liefert das Ergebnis-Objekt (ohne requestId)."""
    if req.get('applianceId') != aid:
        return {'ok': False, 'error': 'invalid_request', 'detail': 'appliance-id passt nicht zum Auftrag'}
    key = normalize_key(req.get('pubkey', ''))
    if not key or not keygen_ok(key):
        return {'ok': False, 'error': 'invalid_key'}
    fp = fingerprint(key)
    reg = load_registry()
    keyfile = os.path.join(KEYS_DIR, aid + '.pub')
    if aid in reg['appliances']:
        entry = reg['appliances'][aid]
        try:
            with open(keyfile) as f:
                have = normalize_key(f.read())
        except OSError:
            have = None
        if have != key:
            have_fp = fingerprint(have) if have else 'keiner'
            return {'ok': False, 'error': 'key_mismatch', 'detail': f'eingetragen {have_fp}, gemeldet {fp}'}
        return {'ok': True, 'shellPort': int(entry['shellPort']), 'webPort': int(entry['webPort']), 'fingerprint': fp, 'existing': True}
    if len(reg['appliances']) >= MAX_APPLIANCES:
        return {'ok': False, 'error': 'relay_full'}
    pair = free_pair(reg)
    if not pair:
        return {'ok': False, 'error': 'no_free_ports'}
    shell, web = pair
    old_text = json.dumps(reg, indent=2) + '\n'
    reg['appliances'][aid] = {'shellPort': shell, 'webPort': web}
    write_atomic(keyfile, f'{key} dvhub-appliance-{aid}\n', 0o644)
    write_atomic(REGISTRY, json.dumps(reg, indent=2) + '\n', 0o644)
    ok, out = render()
    if not ok:
        write_atomic(REGISTRY, old_text, 0o644)
        try:
            os.unlink(keyfile)
        except OSError:
            pass
        return {'ok': False, 'error': 'render_failed', 'detail': out}
    return {'ok': True, 'shellPort': shell, 'webPort': web, 'fingerprint': fp, 'existing': False}


def main():
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    with open(LOCK, 'a') as lockf:
        fcntl.flock(lockf, fcntl.LOCK_EX)
        try:
            names = sorted(os.listdir(REQUEST_DIR))
        except FileNotFoundError:
            return 0
        done = 0
        for name in names:
            path = os.path.join(REQUEST_DIR, name)
            if not name.endswith('.json') or name.startswith('.'):
                # Halbfertige Aufträge des Portals (.tmp) nach einer Stunde aufräumen.
                try:
                    if time.time() - os.lstat(path).st_mtime > 3600:
                        os.unlink(path)
                except OSError:
                    pass
                continue
            if done >= MAX_PER_RUN:
                break
            done += 1
            aid = name[:-5]
            try:
                req = read_request(path) if ID_RE.match(aid) else None
            except OSError:
                req = None
            try:
                os.unlink(path)
            except OSError:
                pass
            if not ID_RE.match(aid):
                log(f'verworfen: ungültiger Dateiname {name!r}')
                continue
            if not isinstance(req, dict) or not REQ_ID_RE.match(str(req.get('requestId', ''))):
                log(f'{aid}: verworfen (Auftrag unlesbar)')
                continue
            try:
                result = enroll(aid, req)
            except Exception as e:  # nie mit halbem Zustand stehen bleiben
                result = {'ok': False, 'error': 'internal', 'detail': str(e)[:200]}
            result['requestId'] = req['requestId']
            result['at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            try:
                write_result(aid, result)
            except OSError as e:
                log(f'{aid}: Ergebnis nicht geschrieben: {e}')
            if result['ok']:
                log(f"{aid}: {'bestätigt' if result.get('existing') else 'eingetragen'} {result['fingerprint']} Ports {result['shellPort']}/{result['webPort']}")
            else:
                log(f"{aid}: abgelehnt {result['error']} {result.get('detail', '')}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
