// Local E2E test of a pub workspace: like e2e.test.ts, with the project of makeWorkspace().
//   bun run build && PUBREFORM_E2E=1 bun test test/e2e
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FakeGitHub } from './fake-github.ts'
import { type FixtureServer, startFixtureServer } from './fixtures.ts'
import { makeWorkspace } from './make-project.ts'

const E2E = process.env.PUBREFORM_E2E === '1'
setDefaultTimeout(5 * 60 * 1000)

const MAIN = path.join(import.meta.dir, '../../dist/main.js')

describe.skipIf(!E2E)('local E2E: workspace', () => {
  let tmp = ''
  let registry: FixtureServer
  let github: FakeGitHub

  beforeAll(async () => {
    if (!fs.existsSync(MAIN)) throw new Error('dist/main.js is missing. Run `bun run build` first.')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-e2e-workspace-'))
    const project = await makeWorkspace()
    registry = await startFixtureServer()

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

  async function runOk(): Promise<string> {
    fs.writeFileSync(path.join(tmp, 'summary.md'), '')
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmp,
      PUB_CACHE: path.join(tmp, 'pub-cache'),
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SERVER_URL: `file://${path.join(tmp, 'origin')}`,
      GITHUB_API_URL: github.url,
      GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md'),
      RUNNER_TEMP: path.join(tmp, 'runner'),
      INPUT_TOKEN: 'e2e-secret-token',
      INPUT_CONFIG: '.github/pubreform.yaml',
      PUBREFORM_UPSTREAM: registry.url,
    }
    const child = spawn('node', [MAIN], { env })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    const status = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))
    if (status !== 0) throw new Error(`pubreform failed:\n${output.split('\n').slice(-40).join('\n')}`)
    return output
  }

  const open = () => github.prs.filter((pr) => pr.state === 'open')
  const openOn = (branch: string) => open().find((p) => p.branch === branch)!
  const lockVersion = (ref: string, name: string) =>
    new RegExp(`^  ${name}:\\n(?: {4}.*\\n)*? {4}version: "([^"]+)"`, 'm').exec(github.readFile(ref, 'pubspec.lock'))?.[1]

  test('1. one set of pull requests, with the constraints of every member', async () => {
    await runOk()
    expect(open().map((pr) => pr.branch).sort()).toEqual(['pubreform/minor-and-patch', 'pubreform/single/fx_major'])

    const single = openOn('pubreform/single/fx_major')
    const head = github.headOf(single)
    expect(single.title).toBe('Update fx_major from 1.0.0 to 2.0.0')
    // Declared in dependencies of a and dev_dependencies of b.
    expect(single.body).toContain('| [fx_major](https://pub.dev/packages/fx_major) | 1.0.0 | 2.0.0 | direct |')
    expect(lockVersion(head, 'fx_major')).toBe('2.0.0')
    expect(github.readFile(head, 'pkgs/a/pubspec.yaml')).toContain('  # Declared in both members.\n  fx_major: ^2.0.0')
    expect(github.readFile(head, 'pkgs/b/pubspec.yaml')).toContain('dev_dependencies:\n  fx_major:\n    version: ^2.0.0\n')

    const minor = openOn('pubreform/minor-and-patch')
    const minorHead = github.headOf(minor)
    expect(minor.body).toContain('| [fx_patch](https://pub.dev/packages/fx_patch) | 1.0.0 | 1.0.1 | direct |')
    // fx_minor is overridden in b.
    expect(minor.body).not.toContain('fx_minor')
    expect(lockVersion(minorHead, 'fx_patch')).toBe('1.0.1')
    expect(github.readFile(minorHead, 'pkgs/a/pubspec.yaml')).toContain('  fx_patch: ^1.0.1\n')
    // --tighten would make this ^0.0.0.
    expect(github.readFile(minorHead, 'pkgs/b/pubspec.yaml')).toContain('  a: any\n')
  })

  test('2. nothing changes on the next run', async () => {
    const heads = open().map((pr) => github.headOf(pr))
    const comments = open().map((pr) => pr.comments.length)
    await runOk()
    expect(open().map((pr) => github.headOf(pr))).toEqual(heads)
    expect(open().map((pr) => pr.comments.length)).toEqual(comments)
  })
})
