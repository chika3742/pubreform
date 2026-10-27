// Entry point: the overall flow and error collection.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { type Fix, collectFixes, fetchAdvisories } from './advisories.ts'
import { type UnitResult, applyUnit } from './applier.ts'
import { type Window, computeWindow, firstSlotShowing } from './clock.ts'
import { type Config, configHash, parseConfig } from './config.ts'
import { Generator, buildImage, checkEnvironment, findSdk, removeImage } from './generate.ts'
import { GitHub } from './github.ts'
import { type Plan, plan } from './planner.ts'
import { RegistryProxy } from './proxy.ts'
import { Pub, cachedPackageDir, cloneBase, pubCacheDir, workspacePubspecs } from './pub.ts'
import { ROOT_PUBSPEC, type Pubspecs, type Section, baseHash, directDeps, hasWorkspace, isFlutter, lockVersions } from './pubspec.ts'
import { type Outcome, type PlanFailures, type UnitError, advisoryStatus, decide, execute } from './reconciler.ts'
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

const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const pkgLink = (name: string) => `<a href="https://pub.dev/packages/${name}">${name}</a>`

function formatTime(date: Date, timeZone: string): string {
  return `${date.toLocaleString('sv-SE', { timeZone })} (${timeZone})`
}

async function writeSummary(opts: {
  window: Window
  config: Config
  plan?: Plan
  waiting: Waiting[]
  outcomes: Outcome[]
  fixes: Map<string, Fix>
  failures: PlanFailures
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
    refreshed: 'refreshed',
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
        o.packages.map(pkgLink).join(', '),
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
        pkgLink(w.name),
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
    s.addRaw('<p>pub upgrade does not choose the latest version. The reason for each package is below the table.</p>', true)
    s.addTable([
      ['Package', 'Type', 'Current', 'Resolvable', 'Latest'].map((data) => ({ data, header: true })),
      ...opts.plan.unresolvable.map((u) => [pkgLink(u.name), typeOf(u.section), u.current, u.resolvable, u.latest]),
    ])
    for (const u of opts.plan.unresolvable) s.addDetails(u.name, `<pre>${escapeHtml(u.reason)}</pre>`)
  }
  if (opts.fixes.size > 0) {
    s.addHeading('Security advisories', 3)
    s.addTable([
      ['Package', 'Locked', 'Advisories', 'Status'].map((data) => ({ data, header: true })),
      ...[...opts.fixes.values()].map((f) => [
        pkgLink(f.name),
        f.locked,
        f.advisories.map((a) => a.id).join(', '),
        advisoryStatus(f, outcomes, opts.failures),
      ]),
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
  const root = await readRequired(path.join(dir, ROOT_PUBSPEC), ROOT_PUBSPEC)
  const fvmrc = await readOptional(path.join(dir, '.fvmrc'))
  const pubspecs: Pubspecs = { [ROOT_PUBSPEC]: root }
  if (hasWorkspace(root)) {
    for (const p of await core.group('Workspace members', () => workspacePubspecs(dir, fvmrc !== undefined))) {
      pubspecs[p] = await readRequired(path.join(dir, p), p)
    }
  }
  const files = { pubspecs, lock: await readRequired(path.join(dir, 'pubspec.lock'), 'pubspec.lock') }
  const postUpdate = config.post_update.length > 0
  if (postUpdate) await checkEnvironment()
  const hashes = { baseHash: baseHash({ ...files, fvmrc }), configHash: configHash(config) }

  const window = computeWindow(config.schedule, config.min_release_age_days, new Date())
  core.info(`slot: ${window.slot.toISOString()}, cutoff: ${window.cutoff.toISOString()}`)

  const deps = directDeps(files.pubspecs, files.lock)
  const proxy = new RegistryProxy({
    cutoff: window.cutoff,
    locked: lockVersions(files.lock),
    ignore: config.ignore,
    // For tests only: fetch from a fixture registry instead of pub.dev.
    upstream: process.env.PUBREFORM_UPSTREAM || undefined,
  })
  await proxy.start()
  let fixes: Map<string, Fix>
  let thePlan: Plan
  const results: UnitResult[] = []
  const unitErrors: UnitError[] = []
  const waiting: Waiting[] = []
  try {
    // Every resolution sees the same versions, so the fixes are known before planning.
    fixes = await core.group('Security advisories', async () => {
      const found = await collectFixes({
        pubspec: root,
        lock: files.lock,
        listing: (name) => proxy.upstreamListing(name),
        advisories: (name) => fetchAdvisories(proxy.upstreamUrl, name),
        ignore: config.ignore,
      })
      for (const f of found.values()) {
        core.info(`${f.name} ${f.locked}: ${f.advisories.map((a) => a.id).join(', ')}; fixed in ${f.fix?.version ?? 'none'}`)
      }
      return found
    })
    proxy.setFixes(fixes)
    const pub = new Pub({ dir, flutter: isFlutter(files.pubspecs), fvm: fvmrc !== undefined, hostedUrl: proxy.url })
    thePlan = await core.group('Plan', () =>
      plan({
        deps,
        basePubspecs: files.pubspecs,
        resolve: async (args, pubspecs) => lockVersions((await pub.run(args, { pubspecs, lock: files.lock })).lock),
        visibleVersions: (name) => proxy.visibleVersions(name),
        fixes,
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
            fixes,
            cutoff: window.cutoff,
          })
          if (result) results.push(result)
          else core.info('No direct dependency or fixed transitive dependency changes; skipped.')
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
  const flutter = isFlutter(files.pubspecs)
  const fvm = fvmrc !== undefined
  // Failing to prepare post_update is a global error: nothing is changed.
  const image = postUpdate ? await core.group('Build the image for post_update', buildImage) : undefined
  let outcomes: Outcome[]
  try {
    const generator = image
      ? new Generator({
          baseDir: dir,
          commands: config.post_update,
          flutter,
          fvm,
          hostedUrl: proxy.url,
          image,
          sdk: await findSdk({ flutter, fvm, cwd: dir }),
          pubCache: pubCacheDir(),
        })
      : undefined
    // The post_update commands have their own groups, and groups are not nested.
    const inGroup = <T>(f: () => Promise<T>) => (generator ? f() : core.group('Pull requests', f))
    outcomes = await inGroup(() =>
      execute(ops, {
        github,
        base,
        baseSha,
        baseTree,
        hashes,
        labels: config.labels,
        packageInfo: (name, version) => readPackageInfo(cachedPackageDir(proxy.url, name, version)),
        formatLog: format,
        log: (m) => core.error(m),
        info: (m) => core.info(m),
        timeZone: config.schedule.timezone,
        generate: generator && ((result) => generator.generate(result)),
      }),
    )
  } finally {
    if (image) await removeImage(image)
  }

  await writeSummary({
    window,
    config,
    plan: thePlan,
    waiting,
    outcomes,
    fixes,
    failures: {
      direct: new Set(deps.map((d) => d.name)),
      uncertain: thePlan.uncertain,
      failed: new Set(unitErrors.flatMap((e) => e.unit.members)),
      minorFailed: unitErrors.some((e) => e.unit.kind === 'minor'),
    },
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
