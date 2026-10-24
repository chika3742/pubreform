// GitHub E2E: runs pubreform twice against the real GitHub API and checks
// what only the real GitHub and its runners show, including the post_update commands (POST_UPDATE_CONFIG).
// Run by the workflow of chika3742/pubreform-e2e, in its checkout,
// after pubreform is built, with GH_TOKEN (the App token) and the environment of the runner:
//   bun pubreform-src/test/e2e/github-e2e.ts
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../../src/config.ts'
import { BRANCH_PREFIX, isRebaseChecked, markClosed, parseMeta } from '../../src/render.ts'
import { startFixtureServer } from './fixtures.ts'
import { POST_UPDATE_CONFIG, PROBE_RESULT, PROBE_SECRET, makeProject, writeProject } from './make-project.ts'

const API = process.env.GITHUB_API_URL || 'https://api.github.com'
const TOKEN = process.env.GH_TOKEN
const REPO = process.env.GITHUB_REPOSITORY
const SINGLE = `${BRANCH_PREFIX}single/fx_major`
const LABELS = parseConfig(POST_UPDATE_CONFIG).labels

const MAIN = path.join(import.meta.dir, '../../dist/main.js')

interface Pull {
  number: number
  title: string
  body: string | null
  head: { ref: string; sha: string }
  labels: { name: string }[]
  mergeable_state?: string | null
}

async function api<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | undefined> {
  const res = await fetch(`${API}/repos/${REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (allow404 && res.status === 404) return undefined
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`)
  return res.status === 204 ? undefined : ((await res.json()) as T)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(`check failed: ${message}`)
  console.log(`ok - ${message}`)
}

async function openPulls(): Promise<Pull[]> {
  const pulls: Pull[] = []
  for (let page = 1; ; page++) {
    const batch = (await api<Pull[]>('GET', `/pulls?state=open&per_page=100&page=${page}`))!
    pulls.push(...batch)
    if (batch.length < 100) break
  }
  return pulls.filter((p) => p.head.ref.startsWith(BRANCH_PREFIX))
}

async function cleanup() {
  for (const pr of await openPulls()) {
    // Closed as pubreform closes them, so that the next run creates the same pull requests again.
    await api('PATCH', `/pulls/${pr.number}`, { state: 'closed', body: markClosed(pr.body ?? '') })
    console.log(`closed #${pr.number} (${pr.head.ref})`)
  }
  const refs = (await api<{ ref: string }[]>('GET', `/git/matching-refs/heads/${BRANCH_PREFIX}`))!
  for (const { ref } of refs) {
    await api('DELETE', `/git/${ref}`, undefined, true)
    console.log(`deleted ${ref}`)
  }
  for (const label of LABELS) {
    await api('DELETE', `/labels/${encodeURIComponent(label)}`, undefined, true)
    console.log(`deleted label ${label}`)
  }
}

async function checkFirst() {
  // The step summary of the runner, which the 1st run is the first to write.
  const summary = fs.readFileSync(process.env.GITHUB_STEP_SUMMARY!, 'utf8')
  check(
    /<details><summary>fx_sdk<\/summary><pre>[^<]*requires SDK version \^99\.0\.0, version solving failed\.<\/pre>/.test(summary),
    'the job summary shows why fx_sdk cannot be updated',
  )
  const pulls = await openPulls()
  check(
    ['pubreform/group/fx_b', 'pubreform/minor-and-patch', SINGLE].every((b) => pulls.some((p) => p.head.ref === b)),
    `pull requests are created: ${pulls.map((p) => p.head.ref).join(', ')}`,
  )
  for (const label of LABELS) {
    check((await api('GET', `/labels/${encodeURIComponent(label)}`, undefined, true)) !== undefined, `label "${label}" exists`)
  }
  for (const pr of pulls) {
    const commit = (await api<{ commit: { verification: { verified: boolean; reason: string } } }>(
      'GET',
      `/commits/${pr.head.sha}`,
    ))!
    check(commit.commit.verification.verified, `#${pr.number}: commit is Verified (${commit.commit.verification.reason})`)
    check(parseMeta(pr.body ?? '')?.commit === pr.head.sha, `#${pr.number}: metadata has the head commit`)
    for (const label of LABELS) check(pr.labels.some((l) => l.name === label), `#${pr.number}: has label "${label}"`)
    // GitHub computes mergeability in the background.
    let state: string | null | undefined
    for (let i = 0; i < 10; i++) {
      state = (await api<Pull>('GET', `/pulls/${pr.number}`))!.mergeable_state
      if (state && state !== 'unknown') break
      await sleep(3000)
    }
    check(!!state && state !== 'unknown', `#${pr.number}: mergeable_state is "${state}"`)
    await checkGenerated(pr)
  }
}

async function readFile(sha: string, file: string): Promise<string | undefined> {
  const data = await api<{ content: string }>('GET', `/contents/${file}?ref=${sha}`, undefined, true)
  return data && Buffer.from(data.content, 'base64').toString('utf8')
}

/** Checks the files that the post_update commands changed in the commit of the pull request. */
async function checkGenerated(pr: Pull) {
  const sha = pr.head.sha
  const probe = (await readFile(sha, 'probe.txt'))?.trimEnd()
  console.log(`#${pr.number}: probe.txt\n${probe}`)
  check(probe === PROBE_RESULT.join('\n'), `#${pr.number}: the commands reach neither the tokens, the network nor the credentials`)
  check((await readFile(sha, 'network-on.txt')) === 'ok\n', `#${pr.number}: a command with network: true reaches GitHub`)
  const versions = (await readFile(sha, 'lib/versions.g.dart')) ?? ''
  const meta = parseMeta(pr.body ?? '')!
  check(
    Object.entries(meta.packages).every(([name, [, to]]) => versions.includes(`'${name}': '${to}',`)),
    `#${pr.number}: lib/versions.g.dart has the versions of the pull request`,
  )
  const { tree } = (await api<{ tree: { path: string; mode: string }[] }>('GET', `/git/trees/${sha}?recursive=1`))!
  const mode = (file: string) => tree.find((e) => e.path === file)?.mode
  check(mode('run.sh') === '100755', `#${pr.number}: run.sh is executable`)
  check(mode('passwd-link') === '120000', `#${pr.number}: passwd-link is a link`)
  check(mode('blob.bin') === '100644', `#${pr.number}: blob.bin (binary) is committed`)
  check(mode('obsolete.g.dart') === undefined, `#${pr.number}: obsolete.g.dart is deleted`)
  check(!tree.some((e) => e.path.startsWith('build/')), `#${pr.number}: ignored files are not committed`)
  check((pr.body ?? '').includes('Files changed by the `post_update` commands: 7'), `#${pr.number}: the body counts the files`)
}

async function single(): Promise<Pull> {
  const pr = (await openPulls()).find((p) => p.head.ref === SINGLE)
  if (!pr) throw new Error(`no open pull request on ${SINGLE}`)
  return pr
}

/** Checks the box of the single pull request and returns its head. */
async function checkBox(): Promise<string> {
  const pr = await single()
  const body = (pr.body ?? '').replace('- [ ] Rebase this PR', '- [x] Rebase this PR')
  check(isRebaseChecked(body), `#${pr.number}: the box is checked`)
  await api('PATCH', `/pulls/${pr.number}`, { body })
  return pr.head.sha
}

async function checkSecond(previous: string) {
  // Read at once: whether the ref returns the new commit right after the update.
  const ref = (await api<{ object: { sha: string } }>('GET', `/git/ref/heads/${SINGLE}`))!
  let pr = await single()
  const meta = parseMeta(pr.body ?? '')
  check(meta?.commit !== undefined && meta.commit !== previous, `#${pr.number}: metadata has a new commit`)
  check(ref.object.sha === meta!.commit, `${SINGLE}: the ref has the new commit at once`)
  console.log(`head of #${pr.number} at once: ${pr.head.sha === previous ? 'not updated yet' : 'updated'}`)
  // GitHub updates the head of a pull request in the background after the ref moves.
  for (let i = 0; i < 10 && pr.head.sha === previous; i++) {
    await sleep(3000)
    pr = await single()
  }
  check(pr.head.sha === meta!.commit, `#${pr.number}: head moved from ${previous} to ${pr.head.sha}`)
  check(!isRebaseChecked(pr.body ?? ''), `#${pr.number}: the box is unchecked`)
  check(meta!.previous === previous, `#${pr.number}: metadata records the previous head`)
}

function git(...args: string[]): number {
  const { status } = spawnSync('git', args, { stdio: 'inherit' })
  return status ?? -1
}

/** Writes the test project, and pushes it to main when it changed. */
async function updateProject() {
  const project = await makeProject({ postUpdate: true })
  writeProject('.', project)
  if (git('add', ...Object.keys(project)) !== 0) throw new Error('git add failed')
  if (git('diff', '--cached', '--quiet') === 0) {
    console.log('The test project is up to date.')
    return
  }
  const author = ['-c', 'user.name=pubreform-e2e', '-c', 'user.email=pubreform-e2e@users.noreply.github.com']
  if (git(...author, 'commit', '-m', 'Update the test project') !== 0) throw new Error('git commit failed')
  if (git('push', 'origin', 'HEAD:main') !== 0) throw new Error('git push failed')
}

/** Runs the built action as the runner would, with its inputs in the environment. */
async function runPubreform(upstream: string) {
  // Not spawnSync: the fixture registry runs in this process.
  const child = spawn('node', [MAIN], {
    stdio: 'inherit',
    env: {
      ...process.env,
      INPUT_TOKEN: TOKEN,
      INPUT_CONFIG: '.github/pubreform.yaml',
      PUBREFORM_UPSTREAM: upstream,
      PROBE_HOME: os.homedir(),
    },
  })
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve))
  if (status !== 0) throw new Error(`pubreform exited with ${status}`)
}

if (!TOKEN || !REPO) throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required')
// The probe looks for ACTIONS_RUNTIME_TOKEN, which a run step may not have at all.
console.log(`ACTIONS_RUNTIME_TOKEN is ${process.env.ACTIONS_RUNTIME_TOKEN ? 'set' : 'not set'} in this step`)
let step = ''
// A file in the runner's home that the post_update commands must not see.
fs.writeFileSync(path.join(os.homedir(), PROBE_SECRET), 'secret\n')
const registry = await startFixtureServer()
try {
  let previous = ''
  const steps: [string, () => Promise<unknown>][] = [
    ['Update the test project', updateProject],
    ['Clean up the previous run', cleanup],
    ['Run pubreform (1st)', () => runPubreform(registry.url)],
    ['Check the 1st run', checkFirst],
    ['Check the box', async () => (previous = await checkBox())],
    ['Run pubreform (2nd)', () => runPubreform(registry.url)],
    ['Check the 2nd run', () => checkSecond(previous)],
  ]
  for (const [name, run] of steps) {
    step = name
    console.log(`\n==> ${name}`)
    await run()
  }
} catch (e) {
  console.log(`::error title=${step}::${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
} finally {
  await registry.close()
}
