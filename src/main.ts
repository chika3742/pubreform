// Entry point: the overall flow and error collection.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { type UnitResult, applyUnit } from './applier.ts'
import { type Window, computeWindow, firstSlotShowing } from './clock.ts'
import { type Config, configHash, parseConfig } from './config.ts'
import { GitHub } from './github.ts'
import { type Plan, plan } from './planner.ts'
import { RegistryProxy } from './proxy.ts'
import { Pub, cachedPackageDir, cloneBase } from './pub.ts'
import { type Section, baseHash, directDeps, hasWorkspace, isFlutter, lockVersions } from './pubspec.ts'
import { type Outcome, type UnitError, decide, execute } from './reconciler.ts'
import { formatLog, readPackageInfo } from './render.ts'

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

async function readRequired(file: string, label: string): Promise<string> {
  const text = await readOptional(file)
  if (text === undefined) throw new Error(`${label} is not found on the default branch`)
  return text
}

/** A newer version of a direct dependency that the release age hides in this run. */
interface Waiting {
  name: string
  section: Section
  current: string
  version: string
  published: Date
  /** The first slot that shows the version. */
  shownFrom: Date
}

const typeOf = (section: Section) => (section === 'dev_dependencies' ? 'dev' : 'direct')

function formatTime(date: Date, timeZone: string): string {
  return `${date.toLocaleString('sv-SE', { timeZone })} (${timeZone})`
}

async function writeSummary(opts: {
  window: Window
  config: Config
  plan?: Plan
  waiting: Waiting[]
  outcomes: Outcome[]
  prUrl: (n: number) => string
}) {
  const { window, config, outcomes } = opts
  const s = core.summary.addHeading('pubreform', 2)
  s.addList([
    `slot: ${formatTime(window.slot, config.schedule.timezone)}`,
    `cutoff: ${formatTime(window.cutoff, config.schedule.timezone)}`,
  ])
  const actions: Record<Outcome['action'], string> = {
    created: 'created',
    regenerated: 'regenerated',
    unchanged: 'unchanged',
    closed: 'closed',
    skipped: 'skipped (closed without merging)',
    notified: 'not updated (manual commits)',
    error: 'error',
  }
  if (outcomes.length > 0) {
    s.addHeading('Pull requests', 3)
    s.addTable([
      [
        { data: 'Kind', header: true },
        { data: 'Packages', header: true },
        { data: 'Action', header: true },
        { data: 'Pull request', header: true },
      ],
      ...outcomes.map((o) => [
        o.kind ?? '',
        o.packages.join(', '),
        actions[o.action],
        o.pr === undefined ? '' : `<a href="${opts.prUrl(o.pr)}">#${o.pr}</a>`,
      ]),
    ])
  }
  const tz = config.schedule.timezone
  if (opts.waiting.length > 0) {
    s.addHeading('Waiting for the release age', 3)
    s.addTable([
      ['Package', 'Type', 'Current', 'Version', 'Published', 'Used from'].map((data) => ({ data, header: true })),
      ...opts.waiting.map((w) => [
        w.name,
        typeOf(w.section),
        w.current,
        w.version,
        formatTime(w.published, tz),
        formatTime(w.shownFrom, tz),
      ]),
    ])
  }
  if (opts.plan && opts.plan.unresolvable.length > 0) {
    s.addHeading('Cannot update to the latest version', 3)
    s.addRaw('<p>No version of the other dependencies resolves with the latest version.</p>', true)
    s.addTable([
      ['Package', 'Type', 'Current', 'Resolvable', 'Latest'].map((data) => ({ data, header: true })),
      ...opts.plan.unresolvable.map((u) => [u.name, typeOf(u.section), u.current, u.resolvable, u.latest]),
    ])
  }
  if (opts.plan && opts.plan.uncertain.size > 0) {
    s.addHeading('Packages that failed to plan', 3)
    s.addList([...opts.plan.uncertain].sort())
  }
  const errors = outcomes.filter((o) => o.error !== undefined)
  if (errors.length > 0) {
    s.addHeading('Errors', 3)
    for (const o of errors) {
      s.addRaw(`<p>${o.packages.join(', ') || 'pubreform'}${o.pr === undefined ? '' : ` (#${o.pr})`}</p>`, true)
      s.addCodeBlock(o.error!)
    }
  }
  await s.write()
}

export async function run(): Promise<void> {
  const token = core.getInput('token', { required: true })
  core.setSecret(token)
  const configPath = core.getInput('config') || '.github/pubreform.yaml'
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('GITHUB_REPOSITORY is not set')
  const [owner, repo] = repository.split('/') as [string, string]
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const secrets = [token]
  const format = (log: string) => formatLog(log, secrets)

  const github = new GitHub(token, owner, repo)
  const base = await github.defaultBranch()

  const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'pubreform', 'base')
  const baseSha = await core.group('Clone the default branch', () =>
    cloneBase({ serverUrl, repository, branch: base, token, dir }),
  )
  const baseTree = (
    await exec.getExecOutput('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, silent: true })
  ).stdout.trim()

  const config = parseConfig(await readRequired(path.join(dir, configPath), configPath))
  const files = {
    pubspec: await readRequired(path.join(dir, 'pubspec.yaml'), 'pubspec.yaml'),
    lock: await readRequired(path.join(dir, 'pubspec.lock'), 'pubspec.lock'),
  }
  const fvmrc = await readOptional(path.join(dir, '.fvmrc'))
  if (hasWorkspace(files.pubspec)) throw new Error('pub workspaces are not supported')
  const hashes = { baseHash: baseHash({ ...files, fvmrc }), configHash: configHash(config) }

  const window = computeWindow(config.schedule, config.min_release_age_days, new Date())
  core.info(`slot: ${window.slot.toISOString()}, cutoff: ${window.cutoff.toISOString()}`)

  const deps = directDeps(files.pubspec, files.lock)
  const proxy = new RegistryProxy({
    cutoff: window.cutoff,
    locked: lockVersions(files.lock),
    ignore: config.ignore,
    // For tests only: fetch from a fixture registry instead of pub.dev.
    upstream: process.env.PUBREFORM_UPSTREAM || undefined,
  })
  await proxy.start()
  let thePlan: Plan
  const results: UnitResult[] = []
  const unitErrors: UnitError[] = []
  const waiting: Waiting[] = []
  try {
    const pub = new Pub({ dir, flutter: isFlutter(files.pubspec), fvm: fvmrc !== undefined, hostedUrl: proxy.url })
    thePlan = await core.group('Plan', () =>
      plan({
        deps,
        basePubspec: files.pubspec,
        resolve: async (args, pubspec) => lockVersions((await pub.run(args, { pubspec, lock: files.lock })).lock),
        visibleVersions: (name) => proxy.visibleVersions(name),
        log: (m) => core.warning(m),
      }),
    )
    for (const d of deps) {
      const w = await proxy.waitingVersion(d.name)
      if (w === undefined) continue
      const shownFrom = firstSlotShowing(config.schedule, config.min_release_age_days, w.published)
      waiting.push({ name: d.name, section: d.section, current: d.current, ...w, shownFrom })
    }
    for (const unit of thePlan.units) {
      await core.group(`Apply ${unit.kind}: ${unit.members.join(', ')}`, async () => {
        try {
          const result = await applyUnit(unit, {
            base: files,
            deps,
            versioning: config.versioning,
            pub: (args, f) => pub.run(args, f),
          })
          if (result) results.push(result)
          else core.info('No direct dependency changes; skipped.')
        } catch (e) {
          unitErrors.push({ unit, log: e instanceof Error ? e.message : String(e) })
        }
      })
    }
  } finally {
    await proxy.stop()
  }

  const openPrs = await github.openPrs(base)
  const closedPrs = await github.closedPrs(base)
  const ops = decide(results, unitErrors, thePlan, openPrs, closedPrs, hashes)
  const outcomes = await execute(ops, {
    github,
    base,
    baseSha,
    baseTree,
    hashes,
    labels: config.labels,
    packageInfo: (name, version) => readPackageInfo(cachedPackageDir(proxy.url, name, version)),
    formatLog: format,
    log: (m) => core.error(m),
  })

  await writeSummary({
    window,
    config,
    plan: thePlan,
    waiting,
    outcomes,
    prUrl: (n) => `${serverUrl}/${repository}/pull/${n}`,
  })
  const errors = outcomes.filter((o) => o.error !== undefined).length
  if (errors > 0) core.setFailed(`${errors} error(s) occurred. See the job summary.`)
}

try {
  await run()
} catch (e) {
  core.setFailed(e instanceof Error ? e.message : String(e))
}
