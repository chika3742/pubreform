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
  const PINNED = 'pubreform/single/fx_pinned'
  const NEEDS_PINNED = 'pubreform/single/fx_needs_pinned'
  const snapshot = () => github.prs.map((pr) => ({ n: pr.number, head: github.headOf(pr), comments: pr.comments.length }))
  const commitMessage = (sha: string) => github.git(['log', '-1', '--format=%B', sha])
  const lockVersion = (ref: string, name: string) =>
    new RegExp(`^  ${name}:\\n(?: {4}.*\\n)*? {4}version: "([^"]+)"`, 'm').exec(github.readFile(ref, 'pubspec.lock'))?.[1]
  const comments = (pr: FakePr) => pr.comments.map((c) => c.body)

  test('1. creates the planned pull requests', async () => {
    const { summary } = await runOk()
    expect(open().map((pr) => [pr.branch, pr.title]).sort()).toEqual([
      [GROUP, 'Update fx_b to 2.0.0, fx_needs_b to 1.1.0'],
      [MINOR, 'Update minor and patch (4 packages)'],
      [SINGLE, 'Update fx_major from 1.0.0 to 2.0.0'],
      [NEEDS_PINNED, 'Update fx_needs_pinned from 1.0.0 to 2.0.0'],
      [PINNED, 'Update fx_pinned from 1.0.0 to 2.0.0'],
    ])

    const minor = openOn(MINOR)
    expect(minor.body).toContain('| [fx_minor](https://pub.dev/packages/fx_minor) | 1.0.0 | 1.2.0 | dev |')
    expect(minor.body).toContain('| [fx_patch](https://pub.dev/packages/fx_patch) | 1.0.0 | 1.0.1 | direct |')
    expect(minor.body).toContain('| [fx_pinned](https://pub.dev/packages/fx_pinned) | 1.0.0 | 1.1.0 | direct |')
    expect(minor.body).toContain('| [fx_pinned_dep](https://pub.dev/packages/fx_pinned_dep) | 1.0.0 | 1.0.1 | direct |')
    expect(minor.body).toContain('[pub.dev](https://pub.dev/packages/fx_minor/versions/1.2.0) · [Source](https://example.com/fx_minor)')
    expect(minor.body).toContain('<summary>Changelog</summary>\n\n## 1.2.0\n\n- fx_minor 1.2.0.\n\n</details>')
    expect(minor.body).toContain('- [ ] Rebase this PR <!-- pubreform:rebase -->')
    const meta = parseMeta(minor.body)!
    expect(meta).toMatchObject({
      kind: 'minor',
      packages: { fx_minor: ['1.0.0', '1.2.0'], fx_patch: ['1.0.0', '1.0.1'], fx_pinned: ['1.0.0', '1.1.0'], fx_pinned_dep: ['1.0.0', '1.0.1'] },
      commit: github.headOf(minor),
    })
    expect(commitMessage(github.headOf(minor))).toBe(
      'Update minor and patch (4 packages)\n\n| Package | From | To | Type |\n|---|---|---|---|\n| fx_minor | 1.0.0 | 1.2.0 | dev |\n| fx_patch | 1.0.0 | 1.0.1 | direct |\n| fx_pinned | 1.0.0 | 1.1.0 | direct |\n| fx_pinned_dep | 1.0.0 | 1.0.1 | direct |',
    )
    // versioning: increase raises the lower bounds; the lockfile keeps pub.dev URLs.
    const minorPubspec = github.readFile(github.headOf(minor), 'pubspec.yaml')
    expect(minorPubspec).toContain('fx_minor: ^1.2.0')
    expect(minorPubspec).toContain('fx_patch: ^1.0.1')
    // A pinned version stays pinned.
    expect(minorPubspec).toContain('fx_pinned: 1.1.0')
    expect(github.readFile(github.headOf(minor), 'pubspec.lock')).not.toContain('127.0.0.1')

    const single = openOn(SINGLE)
    expect(commitMessage(github.headOf(single))).toBe('Update fx_major from 1.0.0 to 2.0.0')
    expect(github.readFile(github.headOf(single), 'pubspec.yaml')).toContain('fx_major: ^2.0.0')
    expect(github.readFile(github.headOf(openOn(PINNED)), 'pubspec.yaml')).toContain('fx_pinned: 2.0.0')
    // The pinned dependency that it moves is raised in place, and listed in the table only.
    const needsPinned = openOn(NEEDS_PINNED)
    expect(github.readFile(github.headOf(needsPinned), 'pubspec.yaml')).toContain('fx_pinned_dep: 1.0.1')
    expect(lockVersion(github.headOf(needsPinned), 'fx_pinned_dep')).toBe('1.0.1')
    expect(needsPinned.body).toContain('| [fx_pinned_dep](https://pub.dev/packages/fx_pinned_dep) | 1.0.0 | 1.0.1 | direct |')

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
    expect(summary).toContain('Cannot update to the latest version')
    expect(summary).toContain('<td><a href="https://pub.dev/packages/fx_sdk">fx_sdk</a></td><td>direct</td><td>1.0.0</td><td>1.0.0</td><td>2.0.0</td>')
    // fx_fresh 1.1.0 was published a day ago, and min_release_age_days is 3.
    expect(summary).toContain('Waiting for the release age')
    expect(summary).toContain('<td><a href="https://pub.dev/packages/fx_fresh">fx_fresh</a></td><td>direct</td><td>1.0.0</td><td>1.1.0</td>')
    expect(summary).not.toContain('<td><a href="https://pub.dev/packages/fx_ignored">fx_ignored</a></td>')
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
    for (const branch of [SINGLE, GROUP, PINNED]) {
      const pr = openOn(branch)
      const old = before.find((b) => b.n === pr.number)!
      expect(github.headOf(pr)).not.toBe(old.head)
      expect(pr.comments.length).toBe(old.comments)
      expect(github.git(['rev-parse', `${github.headOf(pr)}^`])).toBe(github.refSha('main')!)
    }
    expect(open().some((pr) => pr.branch === MINOR)).toBe(false)
    // Only the version that it updates from changed.
    expect(openOn(PINNED).title).toBe('Update fx_pinned from 1.1.0 to 2.0.0')
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

  test('11. a pull request that a person opened from a pubreform/ branch is left alone', async () => {
    const pr = github.openPrAsPerson('pubreform/fix-something')
    const head = github.headOf(pr)
    await runOk()
    expect(pr.state).toBe('open')
    expect(github.refSha(pr.branch)).toBe(head)
    expect(pr.comments).toEqual([])
  })

  const advisory = (id: string, name: string, versions: string[]) => ({
    id,
    summary: `Fixture advisory of ${name}`,
    aliases: [],
    database_specific: { severity: 'HIGH', pub_display_url: `https://github.com/advisories/${id}` },
    affected: [{ package: { name, ecosystem: 'Pub' }, versions }],
  })
  const LATE = 'pubreform/single/fx_late'

  test('12. security advisories: the fixed versions are used before the release age has passed', async () => {
    registry.addVersion('fx_vuln', { version: '1.1.0', daysAgo: 30 })
    registry.addVersion('fx_vuln', { version: '1.0.1', daysAgo: 1 })
    registry.addVersion('fx_child', { version: '1.0.1', daysAgo: 1 })
    registry.addVersion('fx_late', { version: '2.0.0', daysAgo: 30 })
    registry.addAdvisory('fx_vuln', advisory('GHSA-e2e0-vuln-0001', 'fx_vuln', ['1.0.0', '1.1.0']))
    registry.addAdvisory('fx_child', advisory('GHSA-e2e0-chld-0001', 'fx_child', ['1.0.0']))
    const { summary } = await runOk()

    const minor = openOn(MINOR)
    expect(minor.title).toBe('[Security] Update minor and patch (2 packages)')
    expect(minor.body).toStartWith('Fixes the following security advisories.\n\n| Package | Advisory | Severity | From | To |\n')
    expect(minor.body).toMatch(
      /\| \[fx_child\]\(https:\/\/pub\.dev\/packages\/fx_child\) \| \[GHSA-e2e0-chld-0001\]\(https:\/\/github\.com\/advisories\/GHSA-e2e0-chld-0001\) Fixture advisory of fx_child \| high \| 1\.0\.0 \| 1\.0\.1 \(released \d{4}-\d{2}-\d{2}\) \|/,
    )
    expect(minor.body).toMatch(/\| \[fx_vuln\]\(https:\/\/pub\.dev\/packages\/fx_vuln\) \| .* \| high \| 1\.0\.0 \| 1\.0\.1 \(released \d{4}-\d{2}-\d{2}\) \|/)
    expect(minor.body).toContain('Versions with a release date are used before `min_release_age_days` has passed, to fix the advisory.')
    expect(minor.body).toContain('| [fx_child](https://pub.dev/packages/fx_child) | 1.0.0 | 1.0.1 | transitive |')
    expect(minor.body).toContain('| [fx_vuln](https://pub.dev/packages/fx_vuln) | 1.0.0 | 1.0.1 | direct |')
    expect(minor.body).toContain('### fx_child 1.0.0 → 1.0.1')
    expect(parseMeta(minor.body)).toMatchObject({
      kind: 'minor',
      packages: { fx_child: ['1.0.0', '1.0.1'], fx_vuln: ['1.0.0', '1.0.1'] },
      advisories: ['GHSA-e2e0-chld-0001', 'GHSA-e2e0-vuln-0001'],
    })
    expect(commitMessage(github.headOf(minor))).toBe(
      '[Security] Update minor and patch (2 packages)\n\n| Package | From | To | Type |\n|---|---|---|---|\n| fx_child | 1.0.0 | 1.0.1 | transitive |\n| fx_vuln | 1.0.0 | 1.0.1 | direct |',
    )
    // The affected 1.1.0 is not chosen, though it is newer and past the release age.
    expect(lockVersion(github.headOf(minor), 'fx_vuln')).toBe('1.0.1')
    expect(lockVersion(github.headOf(minor), 'fx_child')).toBe('1.0.1')

    const late = openOn(LATE)
    expect(late.title).toBe('Update fx_late from 1.0.0 to 2.0.0')
    expect(late.body).not.toContain('security advisories')
    expect(parseMeta(late.body)!.advisories).toBeUndefined()

    expect(summary).toContain('Security advisories')
    expect(summary).toContain(`<td><a href="https://pub.dev/packages/fx_child">fx_child</a></td><td>1.0.0</td><td>GHSA-e2e0-chld-0001</td><td>Fixed in #${minor.number}</td>`)
    expect(summary).toContain(`<td><a href="https://pub.dev/packages/fx_vuln">fx_vuln</a></td><td>1.0.0</td><td>GHSA-e2e0-vuln-0001</td><td>Fixed in #${minor.number}</td>`)
    // Neither the shown fixed version nor the hidden affected one is waiting for the release age.
    expect(summary).not.toContain('<td><a href="https://pub.dev/packages/fx_vuln">fx_vuln</a></td><td>direct</td>')
  })

  test('13. an advisory on the version that a pull request updates from refreshes it without a new commit', async () => {
    const late = openOn(LATE)
    const before = snapshot()
    registry.addAdvisory('fx_late', advisory('GHSA-e2e0-late-0001', 'fx_late', ['1.0.0']))
    const { summary, output } = await runOk()
    expect(late.title).toBe('[Security] Update fx_late from 1.0.0 to 2.0.0')
    expect(late.body).toStartWith('Fixes the following security advisories.')
    expect(late.body).toContain('| high | 1.0.0 | 2.0.0 |')
    expect(late.body).not.toContain('Versions with a release date')
    expect(parseMeta(late.body)).toMatchObject({ advisories: ['GHSA-e2e0-late-0001'], commit: before.find((b) => b.n === late.number)!.head })
    expect(output).toContain(`Refresh #${late.number} (${LATE}): security advisories changed`)
    // No new commit and no comment anywhere.
    expect(snapshot()).toEqual(before)
    expect(summary).toContain(`<td><a href="https://pub.dev/packages/fx_late">fx_late</a></td><td>1.0.0</td><td>GHSA-e2e0-late-0001</td><td>Fixed in #${late.number}</td>`)
  })
})

