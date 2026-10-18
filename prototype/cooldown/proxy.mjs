// Prototype: a pub.dev proxy that hides versions published after `cutoff`.
// pub reads only `versions` from the listing (pub: lib/src/source/hosted.dart),
// so `latest` is left as is.
import http from 'node:http';

const UPSTREAM = 'https://pub.dev';

/**
 * @param {object} o
 * @param {number} o.port
 * @param {Date} o.cutoff
 * @param {Map<string, string>} o.locked package -> version kept visible (no downgrades)
 */
export function startProxy({ port, cutoff, locked }) {
  const server = http.createServer(async (req, res) => {
    try {
      const upstream = await fetch(UPSTREAM + req.url, {
        headers: { accept: req.headers.accept ?? '*/*' },
      });
      const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
      const name = req.url.match(/^\/api\/packages\/([a-z0-9_]+)$/)?.[1];
      if (!name || !upstream.ok) {
        res.writeHead(upstream.status, { 'content-type': type });
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      const listing = await upstream.json();
      listing.versions = listing.versions.filter(
        (v) => new Date(v.published) <= cutoff || locked.get(name) === v.version,
      );
      res.writeHead(200, { 'content-type': type });
      res.end(JSON.stringify(listing));
    } catch (e) {
      res.writeHead(502).end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ponytail: regex scan of pubspec.lock, use a YAML parser in the real action.
export function lockedVersions(lockText) {
  const locked = new Map();
  for (const m of lockText.matchAll(/^ {2}(\S+):\n(?: {4}.*\n)*? {4}version: "([^"]+)"/gm)) {
    locked.set(m[1], m[2]);
  }
  return locked;
}
