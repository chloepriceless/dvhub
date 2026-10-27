// testserver.mjs — lokaler Ersatz für GitHub-Release-Downloads im Prüfstand.
// Liefert /srv/pub (Symlink auf einen Veröffentlichungsstand) aus, unterstützt
// Range wie GitHub und kann gesteuert stören (Dateien in /srv/ctl):
//   /srv/ctl/interrupt-once-<asset>    erste Übertragung bricht in der Mitte ab
//   /srv/ctl/interrupt-always-<asset>  jede Übertragung bricht ab
//   /srv/ctl/corrupt-<asset>           ein Byte gekippt (Prüfsumme falsch)
//   node testserver.mjs <port> <root> <ctl>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [port = '8088', root = '/srv/pub', ctl = '/srv/ctl'] = process.argv.slice(2);
const log = (m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const base = fs.realpathSync(root);
  const file = path.resolve(base, `.${decodeURIComponent(u.pathname)}`);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    log(`404 ${u.pathname}`);
    res.writeHead(404); res.end(); return;
  }
  const name = path.basename(file);
  let body = fs.readFileSync(file);
  if (fs.existsSync(path.join(ctl, `corrupt-${name}`))) { body = Buffer.from(body); body[body.length - 200] ^= 0xff; }
  const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
  if (range) body = body.subarray(Number(range[1]));
  res.writeHead(range ? 206 : 200, { 'content-length': body.length, 'accept-ranges': 'bytes' });
  const once = path.join(ctl, `interrupt-once-${name}`);
  if (fs.existsSync(path.join(ctl, `interrupt-always-${name}`)) || fs.existsSync(once)) {
    fs.rmSync(once, { force: true });
    log(`${range ? 206 : 200} ${u.pathname} ABBRUCH nach ${Math.floor(body.length / 2)} Bytes`);
    res.write(body.subarray(0, Math.floor(body.length / 2)));
    setTimeout(() => res.destroy(), 50);
    return;
  }
  log(`${range ? 206 : 200} ${u.pathname} ${body.length} Bytes${range ? ` ab ${range[1]}` : ''}`);
  res.end(body);
}).listen(Number(port), '127.0.0.1', () => log(`bereit auf ${port}, ${root}`));
