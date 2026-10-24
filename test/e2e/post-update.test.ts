// Local E2E test of the post_update commands: like e2e.test.ts, with a project whose config has POST_UPDATE_CONFIG.
// Also needs docker (as on GitHub's Ubuntu runners), so it runs only where `docker version` succeeds:
//   bun run build && PUBREFORM_E2E=1 bun test test/e2e
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMeta } from '../../src/render.ts'
import { FakeGitHub } from './fake-github.ts'
import { type FixtureServer, startFixtureServer } from './fixtures.ts'
import { CONFIG, PROBE_RESULT, PROBE_SECRET, makeProject } from './make-project.ts'

const E2E = process.env.PUBREFORM_E2E === '1'
const DOCKER = E2E && spawnSync('docker', ['version']).status === 0
setDefaultTimeout(5 * 60 * 1000)

const MAIN = path.join(import.meta.dir, '../../dist/main.js')
const TOKEN = 'e2e-secret-token'

describe.skipIf(!DOCKER)('local E2E: post_update', () => {
  let tmp = ''
  let registry: FixtureServer
  let github: FakeGitHub
  /** The fake API as a container on the default network reaches it. */
  let probeUrl = ''

  beforeAll(async () => {
    if (!fs.existsSync(MAIN)) throw new Error('dist/main.js is missing. Run `bun run build` first.')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-e2e-post-update-'))
    fs.mkdirSync(path.join(tmp, 'home'))
    fs.writeFileSync(path.join(tmp, 'home', PROBE_SECRET), 'secret\n')
    const project = await makeProject({ postUpdate: true })
    registry = await startFixtureServer()

    const bare = path.join(tmp, 'origin', 'owner', 'repo.git')
    fs.mkdirSync(bare, { recursive: true })
    github = new FakeGitHub(bare)
    github.git(['init', '--quiet', '--bare', '--initial-branch=main'])
    const emptyTree = github.git(['hash-object', '-t', 'tree', '/dev/null'])
    const tree = github.writeTree(emptyTree, project)
    github.git(['update-ref', 'refs/heads/main', github.commitTree(tree, [], 'Initial commit')])
    await github.start('0.0.0.0')
    const gateway = spawnSync('docker', ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'])
    probeUrl = `http://${gateway.stdout.toString().trim()}:${new URL(github.url).port}`
  })

  afterAll(async () => {
    await github?.stop()
    await registry?.close()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function runAction(): Promise<{ status: number; output: string }> {
    fs.writeFileSync(path.join(tmp, 'summary.md'), '')
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: path.join(tmp, 'home'),
      PUB_CACHE: path.join(tmp, 'pub-cache'),
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SERVER_URL: `file://${path.join(tmp, 'origin')}`,
      GITHUB_API_URL: github.url,
      GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md'),
      RUNNER_TEMP: path.join(tmp, 'runner'),
      INPUT_TOKEN: TOKEN,
      INPUT_CONFIG: '.github/pubreform.yaml',
      PUBREFORM_UPSTREAM: registry.url,
      PROBE_URL: probeUrl,
      PROBE_HOME: path.join(tmp, 'home'),
    }
    const child = spawn('node', [MAIN], { env })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    const status = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))
    expect(output.replace(/^::add-mask::.*$/gm, '')).not.toContain(TOKEN)
    return { status, output }
  }

  const open = () => github.prs.filter((pr) => pr.state === 'open')
  const tree = (sha: string) =>
    github
      .git(['ls-tree', '-r', sha])
      .split('\n')
      .map((line) => {
        const [info, file] = line.split('\t')
        return [file!, info!.split(' ')[0]!] as const
      })
  const lines = (cmd: string, args: string[]) =>
    spawnSync(cmd, args)
      .stdout.toString()
      .split('\n')
      .filter((line) => line.trim() !== '')

  test('1. the files that the commands change are committed, and the commands reach nothing they must not', async () => {
    const { status, output } = await runAction()
    if (status !== 0) throw new Error(`pubreform failed:\n${output.split('\n').slice(-60).join('\n')}`)
    expect(open()).toHaveLength(5)
    expect(output).toContain('::group::Post update: dart run tool/gen.dart')

    for (const pr of open()) {
      const head = github.headOf(pr)
      const meta = parseMeta(pr.body)!
      // The generated file follows the versions of this pull request.
      const versions = github.readFile(head, 'lib/versions.g.dart')
      for (const [name, [, to]] of Object.entries(meta.packages)) expect(versions).toContain(`'${name}': '${to}',`)

      expect(github.readFile(head, 'probe.txt').split('\n')).toEqual(PROBE_RESULT)
      // The same request with the network works.
      expect(github.readFile(head, 'network-on.txt')).toBe('ok')

      const entries = new Map(tree(head))
      expect(entries.get('run.sh')).toBe('100755')
      expect(entries.get('passwd-link')).toBe('120000')
      expect(github.readFile(head, 'passwd-link')).toBe('/etc/passwd')
      expect(github.git(['cat-file', 'blob', `${head}:blob.bin`])).toBe('a\0b')
      expect(entries.has('obsolete.g.dart')).toBe(false)
      expect(entries.has('build/ignored.txt')).toBe(false)
      expect([...entries.keys()].some((f) => f.startsWith('.dart_tool/'))).toBe(false)
      // pubspec.yaml and pubspec.lock are the result of the update, not what the commands wrote.
      expect(github.readFile(head, 'pubspec.yaml')).not.toContain('changed by post_update')
      expect(github.readFile(head, 'pubspec.lock')).not.toContain('127.0.0.1')

      expect(pr.body).toContain('Files changed by the `post_update` commands: 7')
      // One commit on top of the base, with the message of the update.
      expect(github.git(['rev-parse', `${head}^`])).toBe(github.refSha('main')!)
    }
    // The command left `sleep` running: it stopped with the container. No container or image is left.
    expect(lines('ps', ['-eo', 'args=']).filter((args) => args.trim() === 'sleep 600')).toEqual([])
    expect(lines('docker', ['ps', '-a', '-q', '--filter', 'name=pubreform-'])).toEqual([])
    expect(lines('docker', ['images', '-q', 'pubreform-run'])).toEqual([])
  })

  test('2. nothing to regenerate: the commands do not run', async () => {
    const heads = open().map((pr) => github.headOf(pr))
    const { status, output } = await runAction()
    expect(status).toBe(0)
    expect(output).not.toContain('Post update:')
    expect(open().map((pr) => github.headOf(pr))).toEqual(heads)
  })

  test('3. a failing command is an error commented on each pull request, which is left as it is', async () => {
    const heads = open().map((pr) => github.headOf(pr))
    // The output differs on each run.
    const run = 'echo generation failed at $(date +%s%N) >&2; exit 3'
    github.commitToBase({ '.github/pubreform.yaml': `${CONFIG}post_update:\n  - run: ${run}\n` }, 'Break the generation')
    const { status } = await runAction()
    expect(status).not.toBe(0)
    expect(open().map((pr) => github.headOf(pr))).toEqual(heads)
    for (const pr of open()) {
      const comment = pr.comments.at(-1)!.body
      expect(comment).toStartWith('pubreform failed to update this PR.')
      expect(comment).toContain(`post_update command failed with exit code 3: ${run}`)
      expect(comment).toContain('generation failed at ')
    }

    // The same failure with other output is not commented again.
    const counts = open().map((pr) => pr.comments.length)
    expect((await runAction()).status).not.toBe(0)
    expect(open().map((pr) => pr.comments.length)).toEqual(counts)
  })
})
