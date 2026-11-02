// Integration test of the registry proxy with real pub.
// Needs network access to pub.dev, so it runs only with PUBREFORM_IT=1:
//   PUBREFORM_IT=1 bun test test/integration.test.ts
// `dart` (Dart 3 stable) and `fvm` (with Flutter 3.47.7 and 3.47.8 installable) must be on PATH.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { applyFlutter } from '../src/flutter.ts'
import { Generator, findSdk } from '../src/generate.ts'
import { Pub, cachedPackageDir, pubCacheDir, pubCommand } from '../src/pub.ts'
import { lockVersions } from '../src/pubspec.ts'
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

/** The version that the Flutter update goes to, from FLUTTER_VERSION. */
const FLUTTER_UPDATE = '3.47.8'

describe.skipIf(!IT)('Flutter update with fvm', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-it-flutter-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const git = (cwd: string, ...args: string[]) =>
    run('git', ['-c', 'user.name=it', '-c', 'user.email=it@example.com', ...args], { cwd })

  test('updateFlutter installs the new version and resolves with it, from pub.dev, keeping the edited files', async () => {
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(path.join(repo, '.vscode'), { recursive: true })
    // Language version 3.9: pub also reads the upper bound of environment.flutter.
    const pubspec = `name: app\nenvironment:\n  sdk: ^3.9.0\n  flutter: ^${FLUTTER_VERSION}\ndependencies:\n  flutter:\n    sdk: flutter\n`
    const fvmrc = `{\n  "flutter": "${FLUTTER_VERSION}"\n}\n`
    const settings = `{\n  // keep this comment\n  "dart.flutterSdkPath": ".fvm/versions/${FLUTTER_VERSION}"\n}\n`
    fs.writeFileSync(path.join(repo, 'pubspec.yaml'), pubspec)
    fs.writeFileSync(path.join(repo, '.fvmrc'), fvmrc)
    fs.writeFileSync(path.join(repo, '.vscode', 'settings.json'), settings)
    // Not .fvm/: the update must not make it.
    fs.writeFileSync(path.join(repo, '.gitignore'), '.dart_tool/\n.flutter-plugins-dependencies\n')
    await run('fvm', ['flutter', 'pub', 'get', '--no-example'], { cwd: repo })
    const lock = fs.readFileSync(path.join(repo, 'pubspec.lock'), 'utf8')
    await git(repo, 'init', '--quiet')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '--quiet', '-m', 'base')

    const result = applyFlutter({ from: FLUTTER_VERSION, to: FLUTTER_UPDATE, releases: [], pubspec, lock, fvmrc, vscodeSettings: settings })
    const generator = new Generator({
      baseDir: repo,
      commands: [],
      flutter: true,
      fvm: true,
      hostedUrl: 'http://127.0.0.1:1',
      upstreamUrl: 'https://pub.dev',
      pubCache: pubCacheDir(),
    })
    const g = await generator.updateFlutter(result)
    expect(g.failure).toBeUndefined()
    // The lower bound: the upper bound of the merged constraint is not checked.
    expect(g.lock).toMatch(new RegExp(`^  flutter: ">=${FLUTTER_UPDATE.replaceAll('.', '\\.')}[ "]`, 'm'))
    expect(g.lock).toContain('url: "https://pub.dev"')
    const entry = (file: string) => g.entries.find((e) => e.path === file)
    expect(entry('.fvmrc')).toMatchObject({ content: `{\n  "flutter": "${FLUTTER_UPDATE}"\n}\n` })
    // fvm install did not rewrite the project's files.
    expect(entry('.vscode/settings.json')).toMatchObject({
      content: `{\n  // keep this comment\n  "dart.flutterSdkPath": ".fvm/versions/${FLUTTER_UPDATE}"\n}\n`,
    })
    expect(g.entries.some((e) => e.path.startsWith('.fvm/'))).toBe(false)

    const dir = fs.mkdtempSync(path.join(tmp, 'sdk-'))
    fs.writeFileSync(path.join(dir, '.fvmrc'), result.flutter!.files['.fvmrc']!)
    const sdk = await findSdk({ flutter: true, fvm: true, cwd: dir })
    expect(sdk.flutter).toBe(true)
    expect(path.basename(sdk.root)).toBe(FLUTTER_UPDATE)
  })
})
