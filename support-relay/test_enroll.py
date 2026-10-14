#!/usr/bin/env python3
# support-relay/test_enroll.py — Tests für enroll-from-portal.py.
#
# Lokal: mit einem Ersatz-Renderer (prüft nur, dass registry.json gültig ist).
# Auf dem Relay mit dem echten Renderer in ein Testverzeichnis:
#   RELAY_TEST_REAL_RENDER=/opt/support-relay/build-authorized-keys.sh python3 test_enroll.py

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'enroll-from-portal.py')
REAL_RENDER = os.environ.get('RELAY_TEST_REAL_RENDER', '')


def keypair(d, name):
    p = os.path.join(d, name)
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', p, '-C', name], check=True)
    with open(p + '.pub') as f:
        t, data = f.read().split()[:2]
    return f'{t} {data}'


class Enroll(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='relay-enroll-')
        for sub in ('keys', 'req', 'res', 'ak'):
            os.makedirs(os.path.join(self.d, sub))
        self.registry = os.path.join(self.d, 'registry.json')
        self.keys = os.path.join(self.d, 'keys')
        self.req = os.path.join(self.d, 'req')
        self.res = os.path.join(self.d, 'res')
        self.ak = os.path.join(self.d, 'ak')
        # Bestand wie auf dem echten Relay: zwei Anlagen, ungerade Shell-Ports.
        self.k1 = keypair(self.d, 'old1')
        self.k2 = keypair(self.d, 'old2')
        self.write_registry({'762fb93c-0e2e': {'shellPort': 49101, 'webPort': 49102},
                             '554bbdfd-6127': {'shellPort': 49111, 'webPort': 49112}})
        with open(os.path.join(self.keys, '762fb93c-0e2e.pub'), 'w') as f:
            f.write(self.k1 + ' dvhub-appliance-762fb93c\n')
        with open(os.path.join(self.keys, '554bbdfd-6127.pub'), 'w') as f:
            f.write(self.k2 + ' dvhub-appliance-554bbdfd\n')
        self.render = REAL_RENDER or os.path.join(self.d, 'fake-render.sh')
        if not REAL_RENDER:
            with open(self.render, 'w') as f:
                f.write('#!/usr/bin/env bash\nset -e\n'
                        '[ -f "$RELAY_AK_DIR/FAIL" ] && { echo "FATAL: Test-Fehler" >&2; exit 1; }\n'
                        'python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$RELAY_REGISTRY"\n'
                        'cp "$RELAY_REGISTRY" "$RELAY_AK_DIR/dvhub-support"\n')

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def write_registry(self, apps):
        with open(self.registry, 'w') as f:
            json.dump({'appliances': apps}, f)

    def reg(self):
        with open(self.registry) as f:
            return json.load(f)['appliances']

    def run_script(self):
        env = dict(os.environ, RELAY_DIR=self.d, RELAY_REGISTRY=self.registry, RELAY_KEYS_DIR=self.keys,
                   RELAY_REQUEST_DIR=self.req, RELAY_RESULT_DIR=self.res, RELAY_RENDER_CMD=self.render,
                   RELAY_AK_DIR=self.ak, RELAY_AK_USER='dvhub-support',
                   RELAY_LOCK=os.path.join(self.d, '.lock'), RELAY_ENROLL_LOG=os.path.join(self.d, 'enroll.log'))
        r = subprocess.run([sys.executable, SCRIPT], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)

    def request(self, aid, pubkey, request_id='a1b2c3d4e5f6', name=None):
        with open(os.path.join(self.req, name or f'{aid}.json'), 'w') as f:
            json.dump({'requestId': request_id, 'applianceId': aid, 'pubkey': pubkey}, f)

    def result(self, aid):
        with open(os.path.join(self.res, f'{aid}.json')) as f:
            return json.load(f)

    def test_neue_anlage_bekommt_kleinstes_freies_paar(self):
        k = keypair(self.d, 'new')
        self.request('9f00aa11-new', k)
        self.run_script()
        r = self.result('9f00aa11-new')
        self.assertTrue(r['ok'], r)
        self.assertEqual((r['shellPort'], r['webPort']), (49000, 49001))
        self.assertEqual(r['requestId'], 'a1b2c3d4e5f6')
        self.assertEqual(self.reg()['9f00aa11-new'], {'shellPort': 49000, 'webPort': 49001})
        with open(os.path.join(self.keys, '9f00aa11-new.pub')) as f:
            self.assertEqual(f.read(), f'{k} dvhub-appliance-9f00aa11-new\n')
        # Bestand unverändert, Auftrag verbraucht
        self.assertEqual(self.reg()['762fb93c-0e2e'], {'shellPort': 49101, 'webPort': 49102})
        self.assertEqual(os.listdir(self.req), [])
        self.assertTrue(os.path.exists(os.path.join(self.ak, 'dvhub-support')))

    def test_bekannte_anlage_mit_gleichem_schluessel_behaelt_ports(self):
        self.request('762fb93c-0e2e', self.k1)
        self.run_script()
        r = self.result('762fb93c-0e2e')
        self.assertTrue(r['ok'], r)
        self.assertEqual((r['shellPort'], r['webPort'], r['existing']), (49101, 49102, True))

    def test_anderer_schluessel_fuer_bekannte_anlage_wird_abgelehnt(self):
        before = self.reg()
        self.request('762fb93c-0e2e', keypair(self.d, 'evil'))
        self.run_script()
        r = self.result('762fb93c-0e2e')
        self.assertFalse(r['ok'])
        self.assertEqual(r['error'], 'key_mismatch')
        self.assertEqual(self.reg(), before)
        with open(os.path.join(self.keys, '762fb93c-0e2e.pub')) as f:
            self.assertIn(self.k1, f.read())

    def test_luecke_wird_gefuellt_und_kollisionen_vermieden(self):
        apps = self.reg()
        apps['a'] = {'shellPort': 49000, 'webPort': 49001}
        apps['b'] = {'shellPort': 49003, 'webPort': 49004}   # belegt 49003/49004 (ungerade Lage)
        self.write_registry(apps)
        for aid in ('a', 'b'):
            with open(os.path.join(self.keys, f'{aid}.pub'), 'w') as f:
                f.write(keypair(self.d, aid) + '\n')
        self.request('c', keypair(self.d, 'c'))
        self.run_script()
        r = self.result('c')
        self.assertEqual((r['shellPort'], r['webPort']), (49006, 49007))

    def test_boesartige_auftraege_aendern_nichts(self):
        before = self.reg()
        k = keypair(self.d, 'x')
        cases = {
            'bad1': ('Ungültige-ID', k),                     # passt nicht zum Dateinamen
            'bad2': ('bad2', k + '\nssh-ed25519 AAAA zweite'),
            'bad3': ('bad3', 'ssh-dss AAAAB3NzaC1kc3MAAACBAP'),
            'bad4': ('bad4', 'ssh-ed25519 AAAA",command="rm -rf /'),
            'bad5': ('bad5', 'restrict ssh-ed25519 ' + k.split()[1]),
            'bad6': ('bad6', 'ssh-ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),   # base64, aber kein Schlüssel
        }
        for name, (aid, pub) in cases.items():
            self.request(aid, pub, name=f'{name}.json')
        # Dateiname mit Pfadanteil / Großbuchstaben
        with open(os.path.join(self.req, 'BAD.json'), 'w') as f:
            json.dump({'requestId': 'a1b2c3d4', 'applianceId': 'BAD', 'pubkey': k}, f)
        self.run_script()
        self.assertEqual(self.reg(), before)
        for name in cases:
            r = self.result(name)
            self.assertFalse(r['ok'], (name, r))
        self.assertFalse(os.path.exists(os.path.join(self.res, 'BAD.json')))
        self.assertEqual(sorted(os.listdir(self.keys)), ['554bbdfd-6127.pub', '762fb93c-0e2e.pub'])
        self.assertEqual(os.listdir(self.req), [])

    def test_symlink_als_auftrag_wird_nicht_gelesen(self):
        secret = os.path.join(self.d, 'geheim.json')
        with open(secret, 'w') as f:
            json.dump({'requestId': 'a1b2c3d4', 'applianceId': 'link', 'pubkey': keypair(self.d, 'l')}, f)
        os.symlink(secret, os.path.join(self.req, 'link.json'))
        self.run_script()
        self.assertNotIn('link', self.reg())
        self.assertFalse(os.path.exists(os.path.join(self.res, 'link.json')))
        self.assertTrue(os.path.exists(secret))

    def test_zu_grosser_auftrag_wird_verworfen(self):
        with open(os.path.join(self.req, 'big.json'), 'w') as f:
            f.write('{"requestId":"a1b2c3d4","applianceId":"big","pubkey":"' + 'A' * 5000 + '"}')
        self.run_script()
        self.assertNotIn('big', self.reg())
        self.assertEqual(os.listdir(self.req), [])

    def test_render_fehler_nimmt_alles_zurueck(self):
        if REAL_RENDER:
            self.skipTest('nur mit Ersatz-Renderer')
        before = self.reg()
        open(os.path.join(self.ak, 'FAIL'), 'w').close()
        self.request('newbox', keypair(self.d, 'nb'))
        self.run_script()
        r = self.result('newbox')
        self.assertFalse(r['ok'])
        self.assertEqual(r['error'], 'render_failed')
        self.assertEqual(self.reg(), before)
        self.assertFalse(os.path.exists(os.path.join(self.keys, 'newbox.pub')))

    def test_haengender_renderer_nimmt_alles_zurueck(self):
        if REAL_RENDER:
            self.skipTest('nur mit Ersatz-Renderer')
        before = self.reg()
        with open(self.render, 'w') as f:
            f.write('#!/usr/bin/env bash\nsleep 120\n')
        self.request('slowbox', keypair(self.d, 'sb'))
        # Zeitlimit des Skripts ist 60 s; für den Test verkürzt per Python-Patch.
        with open(SCRIPT) as f:
            script = f.read().replace('timeout=60', 'timeout=1')
        patched = os.path.join(self.d, 'enroll-fast.py')
        with open(patched, 'w') as f:
            f.write(script)
        env = dict(os.environ, RELAY_DIR=self.d, RELAY_REGISTRY=self.registry, RELAY_KEYS_DIR=self.keys,
                   RELAY_REQUEST_DIR=self.req, RELAY_RESULT_DIR=self.res, RELAY_RENDER_CMD=self.render,
                   RELAY_AK_DIR=self.ak, RELAY_LOCK=os.path.join(self.d, '.lock'), RELAY_ENROLL_LOG=os.path.join(self.d, 'enroll.log'))
        subprocess.run([sys.executable, patched], env=env, check=True, timeout=30)
        r = self.result('slowbox')
        self.assertFalse(r['ok'])
        self.assertEqual(r['error'], 'render_failed')
        self.assertEqual(self.reg(), before)
        self.assertFalse(os.path.exists(os.path.join(self.keys, 'slowbox.pub')))

    def test_echter_renderer_schreibt_permitlisten_zeile(self):
        if not REAL_RENDER:
            self.skipTest('nur mit RELAY_TEST_REAL_RENDER')
        k = keypair(self.d, 'real')
        self.request('realbox-01', k)
        self.run_script()
        with open(os.path.join(self.ak, 'dvhub-support')) as f:
            lines = f.read().splitlines()
        self.assertIn(f'restrict,port-forwarding,permitlisten="127.0.0.1:49000",permitlisten="127.0.0.1:49001" {k} dvhub-support@realbox-01', lines)
        self.assertEqual(len(lines), 3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
