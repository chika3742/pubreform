// Integration test of the registry proxy with real pub.
// Needs network access to pub.dev, so it runs only with PUBREFORM_IT=1:
//   PUBREFORM_IT=1 bun test test/integration.test.ts
// `dart` (Dart 3 stable) and `fvm` (with Flutter 3.47.7 and 3.50.0 installable) must be on PATH.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { applyUnit } from '../src/applier.ts'
import { type FlutterRelease, chooseTarget, installFlutter, planFlutter, rewriteEnvironment, rewriteFvmrc } from '../src/flutter.ts'
import type { Unit } from '../src/planner.ts'
import { Pub, cachedPackageDir, pubCommand } from '../src/pub.ts'
import { directDeps, lockVersions } from '../src/pubspec.ts'
import { PROXY_PORT, RegistryProxy } from '../src/proxy.ts'
import { compareVersions } from '../src/version.ts'

const IT = process.env.PUBREFORM_IT === '1'
setDefaultTimeout(10 * 60 * 1000)
const run = promisify(execFile)

const FLUTTER_VERSION = '3.47.7'

interface Fixture {
  flutter: boolean
  /** A direct dependency and a transitive dependency of it. */
  direct: string
  transitive: string
  constraint: string
  OLD: string
  NEW: string
  /** Versions [direct, transitive] chosen with each cutoff. */
  old: string[]
  upgraded: string[]
  add: string
  added: string[]
}

const FIXTURES: Fixture[] = [
  {
    // http 1.5.0 2025-08-07, 1.6.0 2025-11-10 (direct)
    // async 2.13.0 2025-02-06, 2.13.1 2026-03-26 (transitive, via http)
    flutter: false,
    direct: 'http',
    transitive: 'async',
    constraint: '^1.3.0',
    OLD: '2025-10-01T00:00:00Z',
    NEW: '2026-01-01T00:00:00Z',
    old: ['1.5.0', '2.13.0'],
    upgraded: ['1.6.0', '2.13.0'],
    add: '^1.6.0',
    added: ['1.6.0', '2.13.0'],
  },
  {
    // Flutter 3.47.7 needs meta ^1.18.3 (2026-06-04) and vector_math ^2.4.0 (2026-06-03),
    // so the cutoffs must be later than those.
    // dio 5.10.0 2026-06-29, 5.11.0 2026-07-25, 5.11.1 2026-09-04 (direct)
    // vector_math 2.4.0 2026-06-03, 2.4.2 2026-07-29, 2.4.3 2026-09-18 (transitive, via flutter)
    flutter: true,
    direct: 'dio',
    transitive: 'vector_math',
    constraint: '^5.9.0',
    OLD: '2026-07-01T00:00:00Z',
    NEW: '2026-08-01T00:00:00Z',
    old: ['5.10.0', '2.4.0'],
    upgraded: ['5.11.0', '2.4.2'],
    add: '^5.11.0',
    added: ['5.11.0', '2.4.0'],
  },
]

const PROXY = `http://127.0.0.1:${PROXY_PORT}`
const PUB_DEV_URL = 'url: "https://pub.dev"'
const PROXY_URL = `url: "${PROXY}"`

for (const fx of FIXTURES) {
  describe.skipIf(!IT)(pubCommand(fx.flutter, fx.flutter).join(' '), () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-it-'))
    const env = { PUB_CACHE: path.join(tmp, 'pub-cache') }
    // fvm uses the nearest .fvmrc up from the project directory.
    if (fx.flutter) fs.writeFileSync(path.join(tmp, '.fvmrc'), JSON.stringify({ flutter: FLUTTER_VERSION }))
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const pubspec =
      'name: proto\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n' +
      (fx.flutter ? '  flutter:\n    sdk: flutter\n' : '') +
      `  ${fx.direct}: ${fx.constraint}\n`
    const versions = (lock: string) => [fx.direct, fx.transitive].map((p) => lockVersions(lock).get(p))

    function newDir(): string {
      return fs.mkdtempSync(path.join(tmp, 'p-'))
    }

    /** Runs pub without pubreform's lockfile handling. */
    async function rawPub(dir: string, args: string[], files: { lock?: string }, extraEnv: Record<string, string> = {}) {
      fs.writeFileSync(path.join(dir, 'pubspec.yaml'), pubspec)
      if (files.lock !== undefined) fs.writeFileSync(path.join(dir, 'pubspec.lock'), files.lock)
      const [cmd, ...cmdArgs] = pubCommand(fx.flutter, fx.flutter)
      await run(cmd!, [...cmdArgs, ...args], { cwd: dir, env: { ...process.env, ...env, ...extraEnv } })
      return fs.readFileSync(path.join(dir, 'pubspec.lock'), 'utf8')
    }

    /** Runs pub through the proxy with pubreform's Pub. */
    async function proxied(
      dir: string,
      args: string[],
      lock: string,
      cutoff: string,
      locked = new Map<string, string>(),
    ) {
      const proxy = new RegistryProxy({ cutoff: new Date(cutoff), locked, ignore: [] })
      await proxy.start()
      try {
        return await new Pub({ dir, flutter: fx.flutter, fvm: fx.flutter, hostedUrl: proxy.url, env }).run(args, {
          pubspec,
          lock,
        })
      } finally {
        await proxy.stop()
      }
    }

    let lockLatest = ''
    let lockOld = ''

    test('without the proxy, pub picks the latest versions', async () => {
      lockLatest = await rawPub(newDir(), ['get'], {})
      // The latest versions change as new versions are published, so only check that they are not older.
      const [direct, transitive] = versions(lockLatest)
      expect(compareVersions(direct!, fx.upgraded[0]!)).toBeGreaterThanOrEqual(0)
      expect(compareVersions(transitive!, fx.upgraded[1]!)).toBeGreaterThanOrEqual(0)
    })

    test('the proxy hides versions after the cutoff, for direct and transitive dependencies', async () => {
      const { lock } = await proxied(newDir(), ['get'], '', fx.OLD)
      expect(versions(lock)).toEqual(fx.old)
      expect(lock).toContain(PUB_DEV_URL)
      expect(lock).not.toContain(PROXY_URL)
      lockOld = lock
    })

    test('plain pub get keeps the lockfile written through the proxy byte-identical', async () => {
      expect(await rawPub(newDir(), ['get'], { lock: lockOld })).toBe(lockOld)
    })

    test('with the URL rewrite, pub get keeps the lockfile even if newer versions are visible', async () => {
      const { lock } = await proxied(newDir(), ['get'], lockOld, fx.NEW)
      expect(lock).toBe(lockOld)
    })

    test('without the URL rewrite, pub does not treat the entries as locked', async () => {
      const proxy = new RegistryProxy({ cutoff: new Date(fx.NEW), locked: new Map(), ignore: [] })
      await proxy.start()
      try {
        const lock = await rawPub(newDir(), ['get'], { lock: lockOld }, { PUB_HOSTED_URL: proxy.url })
        expect(lock).not.toBe(lockOld)
        expect(lock).toContain(PROXY_URL)
      } finally {
        await proxy.stop()
      }
    })

    test('pub upgrade through the proxy picks the newest visible versions', async () => {
      const { lock } = await proxied(newDir(), ['upgrade'], lockOld, fx.NEW)
      expect(versions(lock)).toEqual(fx.upgraded)
    })

    test('locked versions newer than the cutoff stay visible: no downgrade', async () => {
      const locked = lockVersions(lockLatest)
      const dir = newDir()
      const got = await proxied(dir, ['get'], lockLatest, fx.OLD, locked)
      expect(got.lock).toBe(lockLatest)
      const upgraded = await proxied(dir, ['upgrade'], lockLatest, fx.OLD, locked)
      expect(versions(upgraded.lock)).toEqual(versions(lockLatest))
    })

    test('pub add rejects a hidden version and applies a visible one', async () => {
      const dir = newDir()
      await expect(proxied(dir, ['add', `${fx.direct}:${fx.add}`], lockOld, fx.OLD)).rejects.toThrow(
        /version solving failed/i,
      )
      const added = await proxied(dir, ['add', `${fx.direct}:${fx.add}`], lockOld, fx.NEW)
      expect(added.pubspec).toContain(`${fx.direct}: ${fx.add}`)
      expect(versions(added.lock)).toEqual(fx.added)
      // The package is extracted where render.ts reads CHANGELOG.md from.
      const cached = cachedPackageDir(PROXY, fx.direct, fx.added[0]!, env)
      expect(fs.existsSync(path.join(cached, 'pubspec.yaml'))).toBe(true)
      expect(fs.existsSync(path.join(cached, 'CHANGELOG.md'))).toBe(true)
    })
  })
}

// Flutter updates with the new SDK's pub: Flutter 3.47.7 → 3.50.0 with fvm.
// Flutter 3.47.7's flutter_test pins test_api 0.7.12, and 3.50.0's pins 0.7.14.
// test 1.31.1 needs test_api 0.7.12, and only 1.32.0 needs 0.7.14, so newer releases of test do not change the results.
// The release list is fixed, so that a newer stable Flutter does not change them either.
describe.skipIf(!IT)('Flutter update with fvm', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-it-flutter-'))
  const env = { PUB_CACHE: path.join(tmp, 'pub-cache') }
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const releases: FlutterRelease[] = [
    { version: '3.50.0', dart: '3.14.0', released: new Date('2026-11-11T18:00:00Z') },
    { version: '3.47.9', dart: '3.13.7', released: new Date('2026-10-29T18:00:00Z') },
    { version: '3.47.8', dart: '3.13.6', released: new Date('2026-10-23T18:00:00Z') },
    { version: '3.47.7', dart: '3.13.5', released: new Date('2026-10-08T18:00:00Z') },
  ]
  const cutoff = new Date('2026-11-13T00:00:00Z')
  const pubspec = (test: string) => `name: app
environment:
  sdk: ^3.9.0
  flutter: 3.47.7
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  flutter_test:
    sdk: flutter
  test: ${test} # the test runner
`

  /** The base lockfile, resolved with Flutter 3.47.7 and test 1.31.1, and the constraint of `test`. */
  async function baseOf(test: string) {
    const dir = fs.mkdtempSync(path.join(tmp, 'base-'))
    fs.writeFileSync(path.join(dir, '.fvmrc'), JSON.stringify({ flutter: '3.47.7' }))
    const proxy = new RegistryProxy({ cutoff, locked: new Map(), ignore: [] })
    await proxy.start()
    try {
      const pub = new Pub({ dir, flutter: true, fvm: true, hostedUrl: proxy.url, env })
      const pinned = await pub.run(['get'], { pubspec: pubspec('1.31.1'), lock: '' })
      return await pub.run(['get'], { pubspec: pubspec(test), lock: pinned.lock })
    } finally {
      await proxy.stop()
    }
  }

  const cases: [constraint: string, targets: Record<string, string>, written: string][] = [
    ['"^1.31.1"', {}, 'test: "^1.31.1" # the test runner'],
    ['1.31.1', { test: '1.32.0' }, 'test: 1.32.0 # the test runner'],
    ['">=1.31.1 <1.32.0"', { test: '1.32.0' }, 'test: ^1.32.0 # the test runner'],
  ]
  for (const [constraint, targets, written] of cases) {
    test(`test: ${constraint}`, async () => {
      const base = await baseOf(constraint)
      const locked = lockVersions(base.lock)
      expect([locked.get('test'), locked.get('test_api'), locked.get('test_core')]).toEqual(['1.31.1', '0.7.12', '0.6.18'])
      const deps = directDeps(base.pubspec, base.lock)
      const { target } = chooseTarget(releases, '3.47.7', cutoff)
      expect(target).toMatchObject({ from: '3.47.7', to: '3.50.0', dartFrom: '3.13.5', dartTo: '3.14.0' })
      const environment = rewriteEnvironment(base.pubspec, { flutter: '3.50.0', dart: '3.14.0' }, 'increase')
      expect(environment).toContain('  sdk: ^3.14.0\n  flutter: 3.50.0\n')

      const dir = fs.mkdtempSync(path.join(tmp, 'flutter-'))
      fs.writeFileSync(path.join(dir, '.fvmrc'), rewriteFvmrc(JSON.stringify({ flutter: '3.47.7' }), '3.47.7', '3.50.0'))
      await installFlutter(dir, '3.50.0')
      const proxy = new RegistryProxy({ cutoff, locked, ignore: [] })
      await proxy.start()
      try {
        const pub = new Pub({ dir, flutter: true, fvm: true, hostedUrl: proxy.url, env })
        const planned = await planFlutter({
          deps,
          pubspec: environment,
          resolve: async (args, p) => lockVersions((await pub.run(args, { pubspec: p, lock: base.lock })).lock),
        })
        expect(planned).toEqual({ unit: { kind: 'flutter', members: constraint.startsWith('">=') ? ['test'] : [], targets } })
        const unit = (planned as { unit: Unit }).unit
        const calls: string[][] = []
        const result = (await applyUnit(unit, {
          base: { pubspec: environment, lock: base.lock },
          deps,
          versioning: 'increase',
          pub: (args, f) => {
            calls.push(args)
            return pub.run(args, f)
          },
          fixes: new Map(),
          cutoff,
          flutter: { from: '3.47.7', to: '3.50.0', dartTo: '3.14.0', files: [] },
        }))!
        expect(calls).toEqual([Object.keys(targets).length === 0 ? ['get'] : ['add', `dev:test:${constraint === '1.31.1' ? '' : '^'}1.32.0`]])
        expect(result.changes).toEqual({ test: { from: '1.31.1', to: '1.32.0', section: 'dev_dependencies' } })
        const after = lockVersions(result.files.lock)
        expect([after.get('test'), after.get('test_api'), after.get('test_core')]).toEqual(['1.32.0', '0.7.14', '0.6.20'])
        expect(result.files.lock).toContain('  flutter: "3.50.0"')
        expect(result.files.lock).toContain('  dart: ">=3.14.0 <4.0.0"')
        // The comment and the other constraints are kept.
        expect(result.files.pubspec).toContain(`  ${written}\n`)
        expect(result.files.pubspec).toContain('  sdk: ^3.14.0\n  flutter: 3.50.0\n')
      } finally {
        await proxy.stop()
      }
    })
  }

  test('a new SDK whose packages are hidden by the release age does not resolve', async () => {
    const base = await baseOf('"^1.31.1"')
    const dir = fs.mkdtempSync(path.join(tmp, 'flutter-'))
    fs.writeFileSync(path.join(dir, '.fvmrc'), JSON.stringify({ flutter: '3.50.0' }))
    // test_api 0.7.14 was published on 2026-09-02.
    const proxy = new RegistryProxy({ cutoff: new Date('2026-08-01T00:00:00Z'), locked: lockVersions(base.lock), ignore: [] })
    await proxy.start()
    try {
      const pub = new Pub({ dir, flutter: true, fvm: true, hostedUrl: proxy.url, env })
      const planned = await planFlutter({
        deps: directDeps(base.pubspec, base.lock),
        pubspec: rewriteEnvironment(base.pubspec, { flutter: '3.50.0', dart: '3.14.0' }, 'lockfile-only'),
        resolve: async (args, p) => lockVersions((await pub.run(args, { pubspec: p, lock: base.lock })).lock),
      })
      expect(planned).toEqual({ unresolvable: expect.stringContaining('version solving failed.') })
      expect((planned as { unresolvable: string }).unresolvable).toContain('test_api 0.7.14')
    } finally {
      await proxy.stop()
    }
  })
})
