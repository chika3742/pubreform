// Prototype check for the cooldown proxy (design doc §4.2).
// Needs network access to pub.dev. Run:
//   DART=/path/to/dart node prototype/cooldown/check.mjs   # dart pub
//   FLUTTER=3.47.7 node prototype/cooldown/check.mjs       # fvm flutter pub (fvm on PATH)
//
// Expected versions are as of 2026-10-18 (step 1 breaks when a newer version is published).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { lockedVersions, startProxy } from './proxy.mjs';

const run = promisify(execFile);
const FLUTTER = process.env.FLUTTER;
const [CMD, ...CMD_ARGS] = FLUTTER ? ['fvm', 'flutter', 'pub'] : [process.env.DART ?? 'dart', 'pub'];

// Each fixture: a direct dep and a transitive dep, with versions [direct, transitive].
const FX = FLUTTER
  ? {
      // Flutter 3.47.7 needs meta ^1.18.3 (2026-06-04) and vector_math ^2.4.0 (2026-06-03),
      // so the cutoffs must be later than those.
      // dio 5.10.0 2026-06-29, 5.11.0 2026-07-25, 5.11.1 2026-09-04 (direct)
      // vector_math 2.4.0 2026-06-03, 2.4.2 2026-07-29, 2.4.3 2026-09-18 (transitive, via flutter)
      direct: 'dio', transitive: 'vector_math', constraint: '^5.9.0',
      OLD: '2026-07-01T00:00:00Z', NEW: '2026-08-01T00:00:00Z',
      latest: ['5.11.1', '2.4.3'], old: ['5.10.0', '2.4.0'], upgraded: ['5.11.0', '2.4.2'],
      add: '^5.11.0', added: ['5.11.0', '2.4.0'],
    }
  : {
      // http 1.5.0 2025-08-07, 1.6.0 2025-11-10 (direct)
      // async 2.13.0 2025-02-06, 2.13.1 2026-03-26 (transitive, via http)
      direct: 'http', transitive: 'async', constraint: '^1.3.0',
      OLD: '2025-10-01T00:00:00Z', NEW: '2026-01-01T00:00:00Z',
      latest: ['1.6.0', '2.13.1'], old: ['1.5.0', '2.13.0'], upgraded: ['1.6.0', '2.13.0'],
      add: '^1.6.0', added: ['1.6.0', '2.13.0'],
    };

const PORT = 8471;
const PROXY = `http://127.0.0.1:${PORT}`;
const PUB_DEV_URL = 'url: "https://pub.dev"';
const PROXY_URL = `url: "${PROXY}"`; // what pub writes when PUB_HOSTED_URL=PROXY

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-'));
const PUB_CACHE = path.join(tmp, 'pub-cache');
// fvm picks the nearest .fvmrc up from the project dir.
if (FLUTTER) fs.writeFileSync(path.join(tmp, '.fvmrc'), JSON.stringify({ flutter: FLUTTER }));

function project(lock) {
  const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
  fs.writeFileSync(
    path.join(dir, 'pubspec.yaml'),
    'name: proto\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n' +
      (FLUTTER ? '  flutter:\n    sdk: flutter\n' : '') +
      `  ${FX.direct}: ${FX.constraint}\n`,
  );
  if (lock) fs.writeFileSync(path.join(dir, 'pubspec.lock'), lock);
  return dir;
}

const lockPath = (dir) => path.join(dir, 'pubspec.lock');
const readLock = (dir) => fs.readFileSync(lockPath(dir), 'utf8');
const editLock = (dir, f) => fs.existsSync(lockPath(dir)) && fs.writeFileSync(lockPath(dir), f(readLock(dir)));
const versions = (dir) => [FX.direct, FX.transitive].map((p) => lockedVersions(readLock(dir)).get(p));

/** Runs `dart pub` / `fvm flutter pub`, through the proxy when `cutoff` is given. Throws on failure. */
async function pub(dir, args, { cutoff, locked = new Map(), rewrite = true } = {}) {
  const env = { ...process.env, PUB_CACHE };
  let server;
  if (cutoff) {
    server = await startProxy({ port: PORT, cutoff: new Date(cutoff), locked });
    env.PUB_HOSTED_URL = PROXY;
    if (rewrite) editLock(dir, (l) => l.replaceAll(PUB_DEV_URL, PROXY_URL));
  }
  try {
    return (await run(CMD, [...CMD_ARGS, ...args], { cwd: dir, env })).stdout;
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (rewrite) editLock(dir, (l) => l.replaceAll(PROXY_URL, PUB_DEV_URL));
    }
  }
}

const ok = (name) => console.log(`ok - ${name}`);
console.log(`# ${[CMD, ...CMD_ARGS].join(' ')}: ${FX.direct} (direct), ${FX.transitive} (transitive)`);

// 1. Baseline without the proxy: latest versions.
const direct = project();
await pub(direct, ['get']);
assert.deepEqual(versions(direct), FX.latest);
const lockLatest = readLock(direct);
ok(`direct: ${FX.latest}`);

// 2. Proxy hides versions after the cutoff, for direct and transitive deps.
const old = project();
await pub(old, ['get'], { cutoff: FX.OLD });
assert.deepEqual(versions(old), FX.old);
const lockOld = readLock(old);
assert.ok(!lockOld.includes(PROXY_URL) && lockOld.includes(PUB_DEV_URL), 'lock uses https://pub.dev after rewrite back');
ok(`proxy(OLD): ${FX.old}`);

// 3. The lock written through the proxy is what plain pub writes (same sha256, same format).
const plain = project(lockOld);
await pub(plain, ['get']);
assert.equal(readLock(plain), lockOld);
ok('plain pub get keeps the proxy-made lock byte-identical');

// 4. With the URL rewrite, pub get through the proxy keeps the lock even if newer versions are visible.
const kept = project(lockOld);
await pub(kept, ['get'], { cutoff: FX.NEW });
assert.equal(readLock(kept), lockOld);
ok('proxy(NEW) + rewrite: pub get keeps the lock byte-identical');

// 5. Without the rewrite, pub does not treat the entries as locked.
const noRewrite = project(lockOld);
await pub(noRewrite, ['get'], { cutoff: FX.NEW, rewrite: false });
const raw = readLock(noRewrite);
console.log(`   without rewrite: ${versions(noRewrite)}, proxy URL in lock: ${raw.includes(PROXY_URL)}`);
assert.notEqual(raw, lockOld);
ok('proxy(NEW) without rewrite: lock is rewritten by pub');

// 6. pub upgrade through the proxy picks the newest visible versions only.
const up = project(lockOld);
await pub(up, ['upgrade'], { cutoff: FX.NEW });
assert.deepEqual(versions(up), FX.upgraded);
ok(`proxy(NEW) upgrade: ${FX.upgraded}`);

// 7. Locked versions newer than the cutoff stay visible: no downgrade on get or upgrade.
const locked = lockedVersions(lockLatest);
const noDown = project(lockLatest);
await pub(noDown, ['get'], { cutoff: FX.OLD, locked });
assert.equal(readLock(noDown), lockLatest);
await pub(noDown, ['upgrade'], { cutoff: FX.OLD, locked });
assert.deepEqual(versions(noDown), FX.latest);
ok('proxy(OLD) with locked versions kept: no downgrade on get/upgrade');

// 8. pub add cannot select a hidden version, and works for a visible one.
const add = project(lockOld);
await assert.rejects(pub(add, ['add', `${FX.direct}:${FX.add}`], { cutoff: FX.OLD }), /version solving failed/i);
await pub(add, ['add', `${FX.direct}:${FX.add}`], { cutoff: FX.NEW });
assert.ok(fs.readFileSync(path.join(add, 'pubspec.yaml'), 'utf8').includes(`${FX.direct}: ${FX.add}`));
assert.deepEqual(versions(add), FX.added);
ok(`pub add: hidden version rejected, visible version applied (${FX.added})`);

// 9. Where the proxied packages are cached.
console.log(`   hosted cache dirs: ${fs.readdirSync(path.join(PUB_CACHE, 'hosted')).join(', ')}`);
fs.rmSync(tmp, { recursive: true, force: true });
