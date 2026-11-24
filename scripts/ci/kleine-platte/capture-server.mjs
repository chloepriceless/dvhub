// scripts/ci/kleine-platte/capture-server.mjs — nimmt Push-Meldungen an (ntfy-Format:
// POST, Titel im Header „Title“, Text im Rumpf) und schreibt je Meldung eine
// JSON-Zeile auf stdout. Der Test liest sie mit `docker logs`.
import http from 'node:http';
const port = Number(process.env.PORT || 18398);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    process.stdout.write(JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url,
      title: req.headers.title || null, priority: req.headers.priority || null, body }) + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"kp"}');
  });
}).listen(port, '0.0.0.0', () => process.stdout.write(`capture listening ${port}\n`));
