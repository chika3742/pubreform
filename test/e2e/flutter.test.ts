// Local E2E test of the Flutter update: like e2e.test.ts, with a project that has .fvmrc, a fake fvm (fake-fvm.ts),
// fake Flutter SDKs and a Flutter release list served by the fixture registry. Nothing outside this machine is used.
// The scenarios with post_update also need docker, and run only where `docker version` succeeds:
//   bun run build && PUBREFORM_E2E=1 bun test test/e2e
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMeta } from '../../src/render.ts'
import { installFakeFvm } from './fake-fvm.ts'
import { FakeGitHub, type FakePr } from './fake-github.ts'
import { type FixtureServer, startFixtureServer } from './fixtures.ts'
import { CONFIG, FLUTTER_BASE, makeProject, writeFakeFlutterSdk } from './make-project.ts'

const E2E = process.env.PUBREFORM_E2E === '1'
const DOCKER = E2E && spawnSync('docker', ['version']).status === 0
setDefaultTimeout(5 * 60 * 1000)

const MAIN = path.join(import.meta.dir, '../../dist/main.js')
const TOKEN = 'e2e-secret-token'
const FLUTTER = 'pubreform/flutter'
const MINOR = 'pubreform/minor-and-patch'

describe.skipIf(!E2E)('local E2E: Flutter', () => {
  let tmp = ''
  let registry: FixtureServer
  let github: FakeGitHub
  const sdks = () => path.join(tmp, 'flutter-sdks')
  const fvmLog = () => path.join(tmp, 'fvm.log')

  beforeAll(async () => {
    if (!fs.existsSync(MAIN)) throw new Error('dist/main.js is missing. Run `bun run build` first.')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-e2e-flutter-'))
    installFakeFvm(path.join(tmp, 'bin'))
    for (const v of [FLUTTER_BASE, '3.47.9']) writeFakeFlutterSdk(path.join(sdks(), v), v)
    fs.writeFileSync(fvmLog(), '')
    const project = await makeProject({ flutter: FLUTTER_BASE, dependencies: ['fx_patch'] })
    registry = await startFixtureServer({
      flutterReleases: [
        { version: 'v1.0.0' },
        { version: FLUTTER_BASE, dart: '3.13.7' },
        { version: '3.47.9', dart: '3.13.7' },
        { version: '3.48.0-0.1.pre', channel: 'beta', dart: '3.14.0' },
      ],
    })

    const bare = path.join(tmp, 'origin', 'owner', 'repo.git')
    fs.mkdirSync(bare, { recursive: true })
    github = new FakeGitHub(bare)
    github.git(['init', '--quiet', '--bare', '--initial-branch=main'])
    const emptyTree = github.git(['hash-object', '-t', 'tree', '/dev/null'])
    const tree = github.writeTree(emptyTree, project)
    github.git(['update-ref', 'refs/heads/main', github.commitTree(tree, [], 'Initial commit')])
    await github.start()
  })

  afterAll(async () => {
    await github?.stop()
    await registry?.close()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function runAction(): Promise<{ status: number; output: string; summary: string }> {
    const summaryFile = path.join(tmp, 'summary.md')
    fs.writeFileSync(summaryFile, '')
    const env: Record<string, string> = {
      PATH: `${path.join(tmp, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? tmp,
      PUB_CACHE: path.join(tmp, 'pub-cache'),
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SERVER_URL: `file://${path.join(tmp, 'origin')}`,
      GITHUB_API_URL: github.url,
      GITHUB_STEP_SUMMARY: summaryFile,
      RUNNER_TEMP: path.join(tmp, 'runner'),
      INPUT_TOKEN: TOKEN,
      INPUT_CONFIG: '.github/pubreform.yaml',
      // The runner's temporary directory, where pub makes its own.
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      PUBREFORM_UPSTREAM: registry.url,
      PUBREFORM_FLUTTER_RELEASES: registry.flutterReleasesUrl,
      FAKE_FLUTTER_SDKS: sdks(),
      FAKE_FVM_LOG: fvmLog(),
    }
    const child = spawn('node', [MAIN], { env })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    const status = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))
    expect(output.replace(/^::add-mask::.*$/gm, '')).not.toContain(TOKEN)
    return { status, output, summary: fs.readFileSync(summaryFile, 'utf8') }
  }

  async function runOk() {
    const result = await runAction()
    if (result.status !== 0) throw new Error(`pubreform failed:\n${result.output.split('\n').slice(-40).join('\n')}`)
    return result
  }

  const open = () => github.prs.filter((pr) => pr.state === 'open')
  const openOn = (branch: string) => {
    const pr = open().find((p) => p.branch === branch)
    if (!pr) throw new Error(`no open PR on ${branch}`)
    return pr
  }
  const installs = () => fs.readFileSync(fvmLog(), 'utf8').split('\n').filter((line) => line.startsWith('install '))
  const read = (pr: FakePr, file: string) => github.readFile(github.headOf(pr), file)
  const lockFlutter = (pr: FakePr) => /^sdks:\n(?: {2}.*\n)*? {2}flutter: (.+)$/m.exec(read(pr, 'pubspec.lock'))?.[1]
  const files = (pr: FakePr) => github.git(['ls-tree', '-r', '--name-only', github.headOf(pr)]).split('\n')
  const failureHeading = (to: string, what: string) => `pubreform updated this PR to Flutter ${to}, but ${what} failed.`

  test('1. creates the Flutter pull request, apart from the package one', async () => {
    const { summary } = await runOk()
    expect(open().map((pr) => [pr.branch, pr.title]).sort()).toEqual([
      [FLUTTER, 'Update Flutter from 3.47.8 to 3.47.9'],
      [MINOR, 'Update fx_patch from 1.0.0 to 1.0.1'],
    ])
    const pr = openOn(FLUTTER)
    // readFile trims the end of the file.
    expect(read(pr, '.fvmrc')).toBe('{\n  "flutter": "3.47.9"\n}')
    // Only the version in the path changes: the comment and the rest stay.
    expect(read(pr, '.vscode/settings.json')).toBe(
      '{\n  // The Flutter SDK of fvm.\n  "dart.flutterSdkPath": ".fvm/versions/3.47.9",\n  "editor.formatOnSave": true\n}',
    )
    expect(read(pr, 'pubspec.yaml')).toContain('  flutter: ^3.47.9\n')
    // pub get ran with the new SDK: the lockfile has its Flutter constraint, and pub.dev URLs.
    expect(lockFlutter(pr)).toBe('">=3.47.9"')
    expect(read(pr, 'pubspec.lock')).not.toContain('127.0.0.1')
    expect(files(pr).some((f) => f.startsWith('.fvm/'))).toBe(false)
    // The package pull request is resolved with the base Flutter.
    expect(lockFlutter(openOn(MINOR))).toBe('">=3.47.8"')
    expect(github.git(['log', '-1', '--format=%B', github.headOf(pr)])).toBe('Update Flutter from 3.47.8 to 3.47.9')

    expect(pr.body).toStartWith(
      'Updates Flutter.\n\n| SDK | From | To |\n|---|---|---|\n| Flutter | 3.47.8 | 3.47.9 |\n| Dart | 3.13.7 | 3.13.7 |\n\n' +
        '[Release notes](https://docs.flutter.dev/release/release-notes) · [Changelog](https://github.com/flutter/flutter/blob/flutter-3.47-candidate.0/CHANGELOG.md)\n\n',
    )
    expect(parseMeta(pr.body)).toMatchObject({ kind: 'flutter', packages: { flutter: ['3.47.8', '3.47.9'] }, commit: github.headOf(pr) })
    expect(pr.labels).toEqual(['dependencies'])
    expect(installs()).toEqual(['install 3.47.9 --skip-pub-get'])
    expect(summary).toContain('<td>flutter</td><td>Flutter</td><td>created</td>')
  })

  test('2. a second run changes nothing, and installs nothing', async () => {
    const heads = github.prs.map((pr) => [github.headOf(pr), pr.comments.length])
    await runOk()
    expect(github.prs.map((pr) => [github.headOf(pr), pr.comments.length])).toEqual(heads)
    expect(installs()).toHaveLength(1)
  })

  test('3. a new release regenerates with a comment on the change', async () => {
    writeFakeFlutterSdk(path.join(sdks(), '3.47.10'), '3.47.10')
    registry.addFlutterRelease({ version: '3.47.10', dart: '3.13.8' })
    await runOk()
    const pr = openOn(FLUTTER)
    expect(pr.title).toBe('Update Flutter from 3.47.8 to 3.47.10')
    expect(read(pr, '.fvmrc')).toContain('"3.47.10"')
    expect(pr.body).toContain('| Dart | 3.13.7 | 3.13.8 |')
    expect(pr.comments.map((c) => c.body)).toEqual([
      'The update in this PR has changed.\n\n| Package | Before | After |\n|---|---|---|\n| flutter | 3.47.8 → 3.47.9 | 3.47.8 → 3.47.10 |',
    ])
  })

  test('4. a failed pub get still updates the pull request, with the log in a comment, once', async () => {
    // No SDK for 3.47.11: fvm install fails.
    registry.addFlutterRelease({ version: '3.47.11' })
    const { summary } = await runOk()
    const pr = openOn(FLUTTER)
    expect(pr.title).toBe('Update Flutter from 3.47.8 to 3.47.11')
    expect(read(pr, '.fvmrc')).toContain('"3.47.11"')
    expect(read(pr, 'pubspec.yaml')).toContain('  flutter: ^3.47.11\n')
    // The lockfile is the base one.
    expect(lockFlutter(pr)).toBe('">=3.47.8"')
    expect(pr.body).toContain('`dart pub get` failed with Flutter 3.47.11, so `pubspec.lock` is not updated. The log is in a comment.')
    const comment = pr.comments.at(-1)!.body
    expect(comment).toStartWith(failureHeading('3.47.11', '`dart pub get`'))
    expect(comment).toContain('fvm install 3.47.11 --skip-pub-get failed with exit code 1')
    expect(summary).toContain('<td>flutter</td><td>Flutter</td><td>regenerated (pub get failed)</td>')

    // Regenerated by the box: the same failure, with another timing in the output, is not commented again.
    const comments = pr.comments.length
    github.checkRebaseBox(pr.number)
    const head = github.headOf(pr)
    await runOk()
    expect(github.headOf(pr)).not.toBe(head)
    expect(pr.comments).toHaveLength(comments)
  })

  test('5. without the release list, the pull request is kept and the job fails', async () => {
    registry.failFlutterReleases(500)
    const pr = openOn(FLUTTER)
    const head = github.headOf(pr)
    const { status, summary } = await runAction()
    expect(status).not.toBe(0)
    expect(pr.state).toBe('open')
    expect(github.headOf(pr)).toBe(head)
    expect(summary).toContain('cannot get the Flutter releases')
  })

  test('6. ignore closes the pull request, without reading the release list', async () => {
    // The release list still fails: it is not read.
    github.commitToBase({ '.github/pubreform.yaml': `${CONFIG}  - name: flutter\n` }, 'Ignore Flutter')
    await runOk()
    const pr = github.prs.find((p) => p.branch === FLUTTER)!
    expect(pr.state).toBe('closed')
    expect(pr.comments.at(-1)!.body).toBe('Closing: this update is no longer needed.')
    registry.failFlutterReleases(undefined)
  })

  // A command that records the SDK that it sees, and whether it can write to it.
  const PROBE = 'tool/flutter-probe.sh'
  const probe = `{ cat "$FLUTTER_ROOT/bin/cache/flutter.version.json"; echo; if touch "$FLUTTER_ROOT/probe" 2>/dev/null; then echo writable; else echo read-only; fi; } > flutter.txt\n`

  test.skipIf(!DOCKER)('7. post_update runs with the new SDK, read-only, and its files are committed', async () => {
    writeFakeFlutterSdk(path.join(sdks(), '3.47.11'), '3.47.11')
    github.commitToBase(
      { '.github/pubreform.yaml': `${CONFIG}post_update:\n  - run: sh ${PROBE}\n`, [PROBE]: probe },
      'Probe the SDK',
    )
    await runOk()
    const pr = openOn(FLUTTER)
    expect(pr.title).toBe('Update Flutter from 3.47.8 to 3.47.11')
    expect(read(pr, 'flutter.txt')).toBe('{"flutterVersion":"3.47.11"}\nread-only')
    expect(pr.body).toContain('Files changed by the `post_update` commands: 1')
    // The package pull request runs the commands with the base SDK.
    expect(read(openOn(MINOR), 'flutter.txt')).toBe('{"flutterVersion":"3.47.8"}\nread-only')
  })

  test.skipIf(!DOCKER)('8. a failed command still updates the pull request, without the files of the commands', async () => {
    // Passes with the base SDK (the package pull request), and fails with the new one.
    const run = `grep -q '"${FLUTTER_BASE}"' "$FLUTTER_ROOT/bin/cache/flutter.version.json" || exit 3`
    github.commitToBase({ '.github/pubreform.yaml': `${CONFIG}post_update:\n  - run: sh ${PROBE}\n  - run: ${run}\n` }, 'Fail with the new SDK')
    await runOk()
    const pr = openOn(FLUTTER)
    expect(files(pr)).not.toContain('flutter.txt')
    expect(lockFlutter(pr)).toBe('">=3.47.11"')
    expect(pr.body).toContain('A `post_update` command failed with Flutter 3.47.11, so the files that the commands change are not included.')
    const comment = pr.comments.at(-1)!.body
    expect(comment).toStartWith(failureHeading('3.47.11', 'a `post_update` command'))
    expect(comment).toContain(`post_update command failed with exit code 3: ${run}`)
    expect(files(openOn(MINOR))).toContain('flutter.txt')
  })
})
