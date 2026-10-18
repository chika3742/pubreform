// Steps of the GitHub E2E that talk to the real GitHub API (detailed design §17.2).
// Run from the workflow of chika3742/pubreform-e2e, with GH_TOKEN (the App token) and GITHUB_REPOSITORY:
//   bun test/e2e/github-e2e.ts cleanup        step 6: close leftover PRs (marked as closed by pubreform), delete their branches and labels
//   bun test/e2e/github-e2e.ts check-first    step 7: commits are Verified, mergeable_state is computed, labels are created and added
//   bun test/e2e/github-e2e.ts check-box      step 8: checks the box of the single PR; prints its head to GITHUB_OUTPUT as `head`
//   bun test/e2e/github-e2e.ts check-second <head>   step 8: the head of that PR has changed and the box is unchecked
import fs from 'node:fs'
import { parseConfig } from '../../src/config.ts'
import { BRANCH_PREFIX, isRebaseChecked, markClosed, parseMeta } from '../../src/render.ts'
import { CONFIG } from './make-project.ts'

const API = process.env.GITHUB_API_URL || 'https://api.github.com'
const TOKEN = process.env.GH_TOKEN
const REPO = process.env.GITHUB_REPOSITORY
const SINGLE = `${BRANCH_PREFIX}single/fx_major`
const LABELS = parseConfig(CONFIG).labels

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

async function checkBox() {
  const pr = await single()
  const body = (pr.body ?? '').replace('- [ ] Rebase this PR', '- [x] Rebase this PR')
  check(isRebaseChecked(body), `#${pr.number}: the box is checked`)
  await api('PATCH', `/pulls/${pr.number}`, { body })
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `head=${pr.head.sha}\n`)
  console.log(`head=${pr.head.sha}`)
}

async function checkSecond(previous: string | undefined) {
  if (!previous) throw new Error('usage: check-second <previous head>')
  // GitHub updates the head of a pull request in the background after the ref moves.
  let pr = await single()
  for (let i = 0; i < 10 && pr.head.sha === previous; i++) {
    await sleep(3000)
    pr = await single()
  }
  const ref = (await api<{ object: { sha: string } }>('GET', `/git/ref/heads/${SINGLE}`))!
  check(pr.head.sha !== previous, `#${pr.number}: head moved from ${previous} to ${pr.head.sha}`)
  check(ref.object.sha === pr.head.sha, `${SINGLE}: the ref has the new head`)
  check(!isRebaseChecked(pr.body ?? ''), `#${pr.number}: the box is unchecked`)
  check(parseMeta(pr.body ?? '')?.previous === previous, `#${pr.number}: metadata records the previous head`)
}

if (!TOKEN || !REPO) throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required')
const [command, arg] = process.argv.slice(2)
switch (command) {
  case 'cleanup':
    await cleanup()
    break
  case 'check-first':
    await checkFirst()
    break
  case 'check-box':
    await checkBox()
    break
  case 'check-second':
    await checkSecond(arg)
    break
  default:
    throw new Error(`unknown command: ${command}`)
}
