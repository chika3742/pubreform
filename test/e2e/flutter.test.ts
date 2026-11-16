// Local E2E test of Flutter updates: like e2e.test.ts, with a project whose .fvmrc pins Flutter 3.47.7.
// fvm and the Flutter SDKs are fakes (fake-flutter.ts); pub is the real `dart pub`. Nothing outside this machine is used.
//   bun run build && PUBREFORM_E2E=1 bun test test/e2e
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMeta } from '../../src/render.ts'
import { FakeGitHub } from './fake-github.ts'
import {
  FLUTTER_CHANGELOGS,
  FLUTTER_CONFIG,
  FLUTTER_RELEASES,
  FLUTTER_SDKS,
  type FakeFlutter,
  flutterFixtures,
  flutterPubspec,
  makeFakeFlutter,
  makeFlutterProject,
} from './fake-flutter.ts'
import { type FixtureServer, startFixtureServer } from './fixtures.ts'

const E2E = process.env.PUBREFORM_E2E === '1'
setDefaultTimeout(5 * 60 * 1000)

const MAIN = path.join(import.meta.dir, '../../dist/main.js')
const TOKEN = 'e2e-secret-token'
const BRANCH = 'pubreform/flutter'

describe.skipIf(!E2E)('local E2E: Flutter', () => {
  let tmp = ''
  let registry: FixtureServer
  let github: FakeGitHub
  let fake: FakeFlutter

  beforeAll(async () => {
    if (!fs.existsSync(MAIN)) throw new Error('dist/main.js is missing. Run `bun run build` first.')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-e2e-flutter-'))
    fake = makeFakeFlutter(path.join(tmp, 'flutter'), FLUTTER_SDKS)
    const project = await makeFlutterProject(fake)
    registry = await startFixtureServer({
      fixtures: flutterFixtures(),
      flutterReleases: FLUTTER_RELEASES,
      flutterChangelogs: FLUTTER_CHANGELOGS,
    })

    const bare = path.join(tmp, 'origin', 'owner', 'repo.git')
    fs.mkdirSync(bare, { recursive: true })
    github = new FakeGitHub(bare)
    github.git(['init', '--quiet', '--bare', '--initial-branch=main'])
    const emptyTree = github.git(['hash-object', '-t', 'tree', '/dev/null'])
    github.git(['update-ref', 'refs/heads/main', github.commitTree(github.writeTree(emptyTree, project), [], 'Initial commit')])
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
      PATH: `${fake.bin}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? tmp,
      PUB_CACHE: path.join(tmp, 'pub-cache'),
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SERVER_URL: `file://${path.join(tmp, 'origin')}`,
      GITHUB_API_URL: github.url,
      GITHUB_STEP_SUMMARY: summaryFile,
      RUNNER_TEMP: path.join(tmp, 'runner'),
      INPUT_TOKEN: TOKEN,
      INPUT_CONFIG: '.github/pubreform.yaml',
      PUBREFORM_UPSTREAM: registry.url,
      PUBREFORM_FLUTTER_RELEASES: registry.flutterReleasesUrl,
      PUBREFORM_FLUTTER_CHANGELOG: registry.flutterChangelogUrl,
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
    if (result.status !== 0) throw new Error(`pubreform failed:\n${result.output.split('\n').slice(-60).join('\n')}`)
    return result
  }

  const open = () => github.prs.filter((pr) => pr.state === 'open')
  const flutterPr = () => {
    const pr = open().find((p) => p.branch === BRANCH)
    if (!pr) throw new Error(`no open PR on ${BRANCH}`)
    return pr
  }
  const head = () => github.headOf(flutterPr())
  /** A link to a pull request in the job summary. */
  const prLink = (n: number) => `<a href="file://${path.join(tmp, 'origin')}/owner/repo/pull/${n}">#${n}</a>`
  const file = (name: string) => github.readFile(head(), name)
  const lockVersion = (name: string) =>
    new RegExp(`^  ${name}:\\n(?: {4}.*\\n)*? {4}version: "([^"]+)"`, 'm').exec(file('pubspec.lock'))?.[1]
  /** Calls of fvm with a version in .fvmrc, as `<version> <arguments>`. */
  const callsWith = (version: string) => fake.calls().filter((c) => c.startsWith(`${version} `))

  test('1. creates the pull request', async () => {
    const { summary } = await runOk()
    expect(open().map((pr) => [pr.branch, pr.title])).toEqual([[BRANCH, 'Update Flutter from 3.47.7 to 3.50.0']])
    // The SDK is installed by running flutter, not by fvm use or fvm install.
    expect(callsWith('3.50.0')[0]).toBe('3.50.0 flutter --version --machine')
    expect(fake.calls().some((c) => / (use|install)\b/.test(c))).toBe(false)

    // Only the values change: the flavors, the comments and the formatting are kept.
    // (git show drops the final newline.)
    expect(file('.fvmrc')).toBe('{\n  "flutter": "3.50.0",\n  "flavors": {\n    "next": "3.50.0"\n  }\n}')
    expect(file('.vscode/settings.json')).toBe(
      '{\n  // Written by fvm.\n  "dart.flutterSdkPath": ".fvm/versions/3.50.0",\n  "editor.formatOnSave": true,\n}',
    )
    const pubspec = file('pubspec.yaml')
    expect(pubspec).toContain('  sdk: ^3.10.0\n  flutter: 3.50.0 # the SDK in .fvmrc\n')
    // fx_user is pinned and moves within ^1.0.0; fx_range moves out of its range.
    expect(pubspec).toEndWith('  fx_user: 1.1.0\n  fx_range: ^1.1.0')
    expect([lockVersion('fx_user'), lockVersion('fx_range'), lockVersion('fx_pin'), lockVersion('fx_pin2')]).toEqual([
      '1.1.0',
      '1.1.0',
      '1.1.0',
      '1.1.0',
    ])
    expect(file('pubspec.lock')).not.toContain('127.0.0.1')
    expect(github.git(['rev-parse', `${head()}^`])).toBe(github.refSha('main')!)

    const pr = flutterPr()
    expect(pr.body).toStartWith(`Updates Flutter.

| | From | To |
|---|---|---|
| Flutter | 3.47.7 | 3.50.0 |
| Dart | 3.9.0 | 3.10.0 |

Updates the following packages together, because the new Flutter requires them.

| Package | From | To | Type |
|---|---|---|---|
| [fx_range](https://pub.dev/packages/fx_range) | 1.0.0 | 1.1.0 | direct |
| [fx_user](https://pub.dev/packages/fx_user) | 1.0.0 | 1.1.0 | direct |

### Flutter 3.47.7 → 3.50.0

[Release](https://github.com/flutter/flutter/releases/tag/3.50.0)

<details>
<summary>Changelog</summary>

### [3.50.0](https://github.com/flutter/flutter/releases/tag/3.50.0)
- The 3.50 release.

### [3.47.8](https://github.com/flutter/flutter/releases/tag/3.47.8)
- The 3.47.8 hotfix.

</details>
`)
    expect(parseMeta(pr.body)).toMatchObject({
      kind: 'flutter',
      flutter: ['3.47.7', '3.50.0'],
      packages: { fx_range: ['1.0.0', '1.1.0'], fx_user: ['1.0.0', '1.1.0'] },
      commit: head(),
    })
    expect(github.git(['log', '-1', '--format=%B', head()])).toBe(
      'Update Flutter from 3.47.7 to 3.50.0\n\n| | From | To |\n|---|---|---|\n| Flutter | 3.47.7 | 3.50.0 |\n| Dart | 3.9.0 | 3.10.0 |\n\n| Package | From | To | Type |\n|---|---|---|---|\n| fx_range | 1.0.0 | 1.1.0 | direct |\n| fx_user | 1.0.0 | 1.1.0 | direct |',
    )

    expect(summary).toContain('<h3>Flutter SDK</h3>')
    expect(summary).toContain(`<td>3.47.7</td><td>3.50.0</td><td>Pull request ${prLink(pr.number)}</td>`)
    expect(summary).toContain('<p>Waiting for the release age: Flutter 3.51.0 (published ')
    expect(summary).toContain(`<td>flutter</td><td>Flutter, <a href="https://pub.dev/packages/fx_range">fx_range</a>`)
  })

  test('2. a second run neither installs the new SDK nor changes the pull request (on-change)', async () => {
    const before = { head: head(), body: flutterPr().body, comments: flutterPr().comments.length }
    const calls = callsWith('3.50.0').length
    await runOk()
    expect({ head: head(), body: flutterPr().body, comments: flutterPr().comments.length }).toEqual(before)
    expect(callsWith('3.50.0').length).toBe(calls)
  })

  test('3. always: the update is applied on every run', async () => {
    const before = head()
    github.commitToBase({ '.github/pubreform.yaml': `${FLUTTER_CONFIG}flutter:\n  reapply: always\n` }, 'Reapply always')
    await runOk()
    // The config changed: regenerated, without a comment as the update is the same.
    expect(head()).not.toBe(before)
    expect(flutterPr().comments).toEqual([])

    const regenerated = head()
    const calls = callsWith('3.50.0').length
    await runOk()
    expect(callsWith('3.50.0').length).toBeGreaterThan(calls)
    expect(head()).toBe(regenerated)
  })

  test('4. increase and lockfile-only rewrite the environment differently', async () => {
    github.commitToBase({ 'pubspec.yaml': flutterPubspec('">=3.47.0 <3.48.0"') }, 'A range of Flutter versions')
    await runOk()
    expect(file('pubspec.yaml')).toContain('  sdk: ^3.10.0\n  flutter: ">=3.50.0 <3.51.0" # the SDK in .fvmrc\n')

    github.commitToBase(
      { '.github/pubreform.yaml': `${FLUTTER_CONFIG}flutter:\n  reapply: always\n  versioning: lockfile-only\n` },
      'lockfile-only',
    )
    await runOk()
    expect(file('pubspec.yaml')).toContain('  sdk: ^3.0.0\n  flutter: ">=3.47.0 <3.51.0" # the SDK in .fvmrc\n')
  })

  test('5. manual commits are notified once without installing the new SDK (on-change)', async () => {
    github.commitToBase({ '.github/pubreform.yaml': FLUTTER_CONFIG }, 'Back to the defaults')
    await runOk()
    const pr = flutterPr()
    const manual = github.addManualCommit(pr.number)
    const calls = callsWith('3.50.0').length
    await runOk()
    await runOk()
    expect(head()).toBe(manual)
    expect(pr.comments.filter((c) => c.body.includes(`<!-- pubreform:manual ${manual} -->`))).toHaveLength(1)
    expect(callsWith('3.50.0').length).toBe(calls)
  })

  test('6. a pull request closed by a person is not created again for the same version', async () => {
    const closed = flutterPr()
    github.closeAsUser(closed.number)
    const calls = callsWith('3.50.0').length
    const count = github.prs.length
    const { summary } = await runOk()
    expect(github.prs.length).toBe(count)
    expect(callsWith('3.50.0').length).toBe(calls)
    expect(summary).toContain(`<td>Closed in ${prLink(closed.number)}</td>`)

    registry.addFlutterRelease({ version: '3.50.1', dart: '3.10.1', daysAgo: 30 })
    fake.addSdk('3.50.1', { ...FLUTTER_SDKS['3.50.0']!, dart: '3.10.1' })
    await runOk()
    expect(flutterPr().number).not.toBe(closed.number)
    expect(flutterPr().title).toBe('Update Flutter from 3.47.7 to 3.50.1')
  })

  test('7. a new Flutter that does not resolve closes the pull request with the reason', async () => {
    const pr = flutterPr()
    registry.addFlutterRelease({ version: '3.50.2', dart: '3.10.2', daysAgo: 30 })
    fake.addSdk('3.50.2', { dart: '3.10.2', pins: { fx_pin: '9.9.9', fx_pin2: '1.1.0' } })
    const { summary } = await runOk()
    expect(pr.state).toBe('closed')
    const comment = pr.comments.at(-1)!.body
    expect(comment).toStartWith('Closing: Flutter 3.50.2 does not resolve with the dependencies of this project.\n\n<details>\n<summary>Reason</summary>')
    expect(comment).toContain('version solving failed.')
    expect(parseMeta(pr.body)!.closed).toBe(true)
    expect(open()).toEqual([])
    expect(summary).toContain('<td>3.47.7</td><td>3.50.2</td><td>Does not resolve</td>')
    expect(summary).toContain('<details><summary>Flutter 3.50.2</summary><pre>')
    expect(summary).toContain('fx_pin')
  })

  test('8. disabled: the release list is not fetched', async () => {
    github.commitToBase({ '.github/pubreform.yaml': `${FLUTTER_CONFIG}flutter:\n  enabled: false\n` }, 'Disable')
    const requests = registry.flutterReleaseRequests
    const { summary } = await runOk()
    expect(registry.flutterReleaseRequests).toBe(requests)
    expect(summary).not.toContain('Flutter SDK')
  })
})
