// GitHub E2E (detailed design §17.2): runs pubreform twice against the real GitHub API and checks
// what only the real GitHub shows. Run by the workflow of chika3742/pubreform-e2e, in its checkout,
// after pubreform is built, with GH_TOKEN (the App token) and the environment of the runner:
//   bun pubreform-src/test/e2e/github-e2e.ts
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { parseConfig } from '../../src/config.ts'
import { BRANCH_PREFIX, isRebaseChecked, markClosed, parseMeta } from '../../src/render.ts'
import { startFixtureServer } from './fixtures.ts'
import { CONFIG, makeProject, writeProject } from './make-project.ts'

const API = process.env.GITHUB_API_URL || 'https://api.github.com'
const TOKEN = process.env.GH_TOKEN
const REPO = process.env.GITHUB_REPOSITORY
const SINGLE = `${BRANCH_PREFIX}single/fx_major`
const LABELS = parseConfig(CONFIG).labels
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
  }
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
  writeProject('.', await makeProject())
  if (git('add', 'pubspec.yaml', 'pubspec.lock', '.github/pubreform.yaml') !== 0) throw new Error('git add failed')
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
    env: { ...process.env, INPUT_TOKEN: TOKEN, INPUT_CONFIG: '.github/pubreform.yaml', PUBREFORM_UPSTREAM: upstream },
  })
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve))
  if (status !== 0) throw new Error(`pubreform exited with ${status}`)
}

if (!TOKEN || !REPO) throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required')
let step = ''
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
