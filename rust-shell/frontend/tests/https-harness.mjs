import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';

export async function httpsProxy(directory, socketPath) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  const tls = { cert: await readFile(join(directory, 'cert.pem')), key: await readFile(join(directory, 'key.pem')) };
  const spki = new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' });
  const pin = createHash('sha256').update(spki).digest('base64');
  const connections = new Set();
  const proxy = createServer(tls, (req, res) => {
    const upstream = request({ socketPath, method: req.method, path: req.url, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.on('connection', (socket) => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  proxy.on('upgrade', (req, downstream, head) => {
    const upstream = createConnection(socketPath, () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      upstream.write('\r\n'); upstream.write(head);
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
    upstream.on('error', () => downstream.destroy());
    upstream.on('close', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.on('close', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  return { tls, pin, origin: `https://localhost:${proxy.address().port}`,
    async close() { for (const socket of connections) socket.destroy(); await new Promise((resolve) => proxy.close(resolve)); },
  };
}
