// Local E2E test: runs the built dist/main.js against a fixture registry,
// a fake GitHub API and a local bare repository, with real `dart pub`. Nothing outside this machine is used.
// Needs `dart` (Dart 3 stable) on PATH and a build (`bun run build`). Runs only with PUBREFORM_E2E=1:
//   bun run build && PUBREFORM_E2E=1 bun test test/e2e
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMeta } from '../../src/render.ts'
import { FakeGitHub, type FakePr } from './fake-github.ts'
import { type FixtureServer, startFixtureServer } from './fixtures.ts'
import { CONFIG, type ProjectFiles, makeProject } from './make-project.ts'

const E2E = process.env.PUBREFORM_E2E === '1'
setDefaultTimeout(5 * 60 * 1000)

const MAIN = path.join(import.meta.dir, '../../dist/main.js')
const TOKEN = 'e2e-secret-token'

describe.skipIf(!E2E)('local E2E', () => {
  let tmp = ''
  let registry: FixtureServer
  let github: FakeGitHub
  let project: ProjectFiles

  beforeAll(async () => {
    if (!fs.existsSync(MAIN)) throw new Error('dist/main.js is missing. Run `bun run build` first.')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-e2e-'))
    project = await makeProject()
    registry = await startFixtureServer()

    const bare = path.join(tmp, 'origin', 'owner', 'repo.git')
    fs.mkdirSync(bare, { recursive: true })
    github = new FakeGitHub(bare)
    github.git(['init', '--quiet', '--bare', '--initial-branch=main'])
    const emptyTree = github.git(['hash-object', '-t', 'tree', '/dev/null'])
    const tree = github.writeTree(emptyTree, { ...project, 'README.md': '# pubreform E2E\n' })
    github.git(['update-ref', 'refs/heads/main', github.commitTree(tree, [], 'Initial commit')])
    await github.start()
  })

  afterAll(async () => {
    await github?.stop()
    await registry?.close()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  /** Runs the Action asynchronously: the fake API and the registry serve from this process. */
  async function runAction(): Promise<{ status: number; output: string; summary: string }> {
    const summaryFile = path.join(tmp, 'summary.md')
    fs.writeFileSync(summaryFile, '')
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
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
    }
    const child = spawn('node', [MAIN], { env })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    const status = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))
    // Apart from registering it as a secret, the token never appears in the log.
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
  const MINOR = 'pubreform/minor-and-patch'
  const SINGLE = 'pubreform/single/fx_major'
  const GROUP = 'pubreform/group/fx_b'
  const snapshot = () => github.prs.map((pr) => ({ n: pr.number, head: github.headOf(pr), comments: pr.comments.length }))
  const commitMessage = (sha: string) => github.git(['log', '-1', '--format=%B', sha])
  const lockVersion = (ref: string, name: string) =>
    new RegExp(`^  ${name}:\\n(?: {4}.*\\n)*? {4}version: "([^"]+)"`, 'm').exec(github.readFile(ref, 'pubspec.lock'))?.[1]
  const comments = (pr: FakePr) => pr.comments.map((c) => c.body)

  test('1. creates the planned pull requests', async () => {
    const { summary } = await runOk()
    expect(open().map((pr) => [pr.branch, pr.title]).sort()).toEqual([
      [GROUP, 'Update fx_b to 2.0.0, fx_needs_b to 1.1.0'],
      [MINOR, 'Update minor and patch (2 packages)'],
      [SINGLE, 'Update fx_major from 1.0.0 to 2.0.0'],
    ])

    const minor = openOn(MINOR)
    expect(minor.body).toContain('| [fx_minor](https://pub.dev/packages/fx_minor) | 1.0.0 | 1.2.0 | dev |')
    expect(minor.body).toContain('| [fx_patch](https://pub.dev/packages/fx_patch) | 1.0.0 | 1.0.1 | direct |')
    expect(minor.body).toContain('[pub.dev](https://pub.dev/packages/fx_minor/versions/1.2.0) · [Source](https://example.com/fx_minor)')
    expect(minor.body).toContain('<summary>Changelog</summary>\n\n## 1.2.0\n\n- fx_minor 1.2.0.\n\n</details>')
    expect(minor.body).toContain('- [ ] Rebase this PR <!-- pubreform:rebase -->')
    const meta = parseMeta(minor.body)!
    expect(meta).toMatchObject({
      kind: 'minor',
      packages: { fx_minor: ['1.0.0', '1.2.0'], fx_patch: ['1.0.0', '1.0.1'] },
      commit: github.headOf(minor),
    })
    expect(commitMessage(github.headOf(minor))).toBe(
      'Update minor and patch (2 packages)\n\n| Package | From | To | Type |\n|---|---|---|---|\n| fx_minor | 1.0.0 | 1.2.0 | dev |\n| fx_patch | 1.0.0 | 1.0.1 | direct |',
    )
    // versioning: increase raises the lower bounds; the lockfile keeps pub.dev URLs.
    const minorPubspec = github.readFile(github.headOf(minor), 'pubspec.yaml')
    expect(minorPubspec).toContain('fx_minor: ^1.2.0')
    expect(minorPubspec).toContain('fx_patch: ^1.0.1')
    expect(github.readFile(github.headOf(minor), 'pubspec.lock')).not.toContain('127.0.0.1')

    const single = openOn(SINGLE)
    expect(commitMessage(github.headOf(single))).toBe('Update fx_major from 1.0.0 to 2.0.0')
    expect(github.readFile(github.headOf(single), 'pubspec.yaml')).toContain('fx_major: ^2.0.0')

    const group = openOn(GROUP)
    expect(parseMeta(group.body)!.packages).toEqual({ fx_b: ['1.0.0', '2.0.0'], fx_needs_b: ['1.0.0', '1.1.0'] })
    expect(lockVersion(github.headOf(group), 'fx_b')).toBe('2.0.0')
    expect(lockVersion(github.headOf(group), 'fx_needs_b')).toBe('1.1.0')

    // Each commit is a single commit on top of the base.
    for (const pr of open()) {
      expect(github.git(['rev-parse', `${github.headOf(pr)}^`])).toBe(github.refSha('main')!)
      expect(pr.labels).toEqual(['dependencies'])
    }
    expect(github.labels).toEqual(['dependencies'])
    // No pull requests for fresh, ignored or unresolvable updates.
    expect(github.prs.some((pr) => /fx_(fresh|ignored|sdk)/.test(pr.body))).toBe(false)
    expect(summary).toContain('Unresolvable updates')
    expect(summary).toContain('<td>fx_sdk</td><td>1.0.0</td><td>2.0.0</td>')
  })

  test('2. a second run changes nothing', async () => {
    const before = snapshot()
    const bodies = github.prs.map((pr) => pr.body)
    await runOk()
    expect(snapshot()).toEqual(before)
    expect(github.prs.map((pr) => pr.body)).toEqual(bodies)
  })

  test('3. a checked box regenerates the pull request and is unchecked', async () => {
    const single = openOn(SINGLE)
    const head = github.headOf(single)
    github.checkRebaseBox(single.number)
    github.staleHead(single.number)
    await runOk()
    expect(github.headOf(single)).not.toBe(head)
    expect(single.body).toContain('- [ ] Rebase this PR')
    expect(parseMeta(single.body)).toMatchObject({ commit: github.headOf(single), previous: head })
    expect(single.comments).toEqual([])

    // A run right after it, while the pull request still reports the previous head, changes nothing.
    const before = snapshot()
    await runOk()
    expect(snapshot()).toEqual(before)
    github.freshHeads()
  })

  test('4. a new release regenerates with a comment on the change', async () => {
    registry.addVersion('fx_major', { version: '2.1.0', daysAgo: 30 })
    await runOk()
    const single = openOn(SINGLE)
    expect(single.title).toBe('Update fx_major from 1.0.0 to 2.1.0')
    expect(comments(single)).toEqual([
      'The update in this PR has changed.\n\n| Package | Before | After |\n|---|---|---|\n| fx_major | 1.0.0 → 2.0.0 | 1.0.0 → 2.1.0 |',
    ])
  })

  test('5. a base update regenerates the other pull requests without comments', async () => {
    github.merge(openOn(MINOR).number)
    const before = snapshot()
    await runOk()
    for (const branch of [SINGLE, GROUP]) {
      const pr = openOn(branch)
      const old = before.find((b) => b.n === pr.number)!
      expect(github.headOf(pr)).not.toBe(old.head)
      expect(pr.comments.length).toBe(old.comments)
      expect(github.git(['rev-parse', `${github.headOf(pr)}^`])).toBe(github.refSha('main')!)
    }
    expect(open().some((pr) => pr.branch === MINOR)).toBe(false)
  })

  test('6. manual commits are notified once and not overwritten', async () => {
    const group = openOn(GROUP)
    const manual = github.addManualCommit(group.number)
    await runOk()
    expect(github.headOf(group)).toBe(manual)
    expect(comments(group).filter((c) => c.includes(`<!-- pubreform:manual ${manual} -->`))).toHaveLength(1)
    await runOk()
    expect(github.headOf(group)).toBe(manual)
    expect(comments(group).filter((c) => c.includes('pubreform:manual'))).toHaveLength(1)
  })

  test('7. ignoring a package closes its pull request', async () => {
    const single = openOn(SINGLE)
    github.commitToBase({ '.github/pubreform.yaml': `${CONFIG}  - name: fx_major\n` }, 'Ignore fx_major')
    await runOk()
    expect(single.state).toBe('closed')
    expect(single.merged_at).toBeNull()
    expect(comments(single).at(-1)).toBe('Closing: this update is no longer needed.')
    expect(github.refSha(SINGLE)).toBeUndefined()
    expect(parseMeta(single.body)!.closed).toBe(true)
    // The group with manual commits is still left alone.
    expect(comments(openOn(GROUP)).filter((c) => c.includes('pubreform:manual'))).toHaveLength(1)
  })

  test('8. restoring the config creates the pull request again', async () => {
    const closed = github.prs.find((pr) => pr.branch === SINGLE)!
    github.commitToBase({ '.github/pubreform.yaml': CONFIG }, 'Stop ignoring fx_major')
    await runOk()
    const single = openOn(SINGLE)
    expect(single.number).not.toBe(closed.number)
    expect(single.title).toBe('Update fx_major from 1.0.0 to 2.1.0')
  })

  test('9. a pull request closed by a person is not created again', async () => {
    const single = openOn(SINGLE)
    github.closeAsUser(single.number)
    const count = github.prs.length
    const { summary } = await runOk()
    expect(github.prs.length).toBe(count)
    expect(open().some((pr) => pr.branch === SINGLE)).toBe(false)
    expect(summary).toContain('skipped (closed without merging)')
  })

  test('10. a failed branch update is commented, fails the job, and recovers on the next run', async () => {
    const group = openOn(GROUP)
    const manual = github.headOf(group)
    github.checkRebaseBox(group.number)
    github.failNextBranchUpdates(1)
    const failed = await runAction()
    expect(failed.status).not.toBe(0)
    expect(github.headOf(group)).toBe(manual)
    expect(comments(group).at(-1)).toStartWith('pubreform failed to update this PR.')
    expect(comments(group).at(-1)).toContain('injected failure of the branch update')
    // The body was updated before the branch: the next run sees head == meta.previous.
    expect(parseMeta(group.body)!.previous).toBe(manual)

    await runOk()
    expect(github.headOf(group)).not.toBe(manual)
    expect(parseMeta(group.body)!.commit).toBe(github.headOf(group))
    expect(github.git(['rev-parse', `${github.headOf(group)}^`])).toBe(github.refSha('main')!)
  })
})
