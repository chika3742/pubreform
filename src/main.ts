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
import {
  type FlutterRelease,
  type FlutterTarget,
  chooseTarget,
  fetchFlutterChangelog,
  fetchReleases,
  installFlutter,
  pinnedFlutter,
  planFlutter,
  prepareFlutterDir,
  rewriteEnvironment,
  rewriteFvmrc,
  rewriteVscodeSettings,
} from './flutter.ts'
import { Generator, buildImage, checkEnvironment, findSdk, removeImage } from './generate.ts'
import { GitHub } from './github.ts'
import { type Plan, type Unit, plan } from './planner.ts'
import { RegistryProxy } from './proxy.ts'
import { Pub, cachedPackageDir, cloneBase, pubCacheDir } from './pub.ts'
import { type Section, baseHash, directDeps, hasWorkspace, isFlutter, lockVersions } from './pubspec.ts'
import {
  type FlutterUnresolvable,
  type Op,
  type Outcome,
  type PlanFailures,
  type UnitError,
  advisoryStatus,
  decide,
  decideFlutter,
  execute,
  outcomeLabel,
} from './reconciler.ts'
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

/** The Flutter update of this run, for the job summary. Only when it is enabled. */
interface FlutterSummary {
  target?: FlutterTarget
  waiting?: { version: string; released: Date; shownFrom: Date }
  unresolvable?: FlutterUnresolvable
}

/** The status of the Flutter update, from the outcome of the flutter unit. */
function flutterStatus(outcomes: Outcome[], unresolvable: boolean, prLink: (n: number) => string): string {
  if (unresolvable) return 'Does not resolve'
  const o = outcomes.find((x) => x.kind === 'flutter' && x.action !== 'closed')
  if (o === undefined || o.action === 'error') return 'Error'
  const pr = o.pr === undefined ? '' : prLink(o.pr)
  if (o.action === 'notified') return `Not updated in ${pr} (manual commits)`
  if (o.action === 'skipped') return `Closed in ${pr}`
  return `Pull request ${pr}`
}

async function writeSummary(opts: {
  window: Window
  config: Config
  plan?: Plan
  waiting: Waiting[]
  outcomes: Outcome[]
  fixes: Map<string, Fix>
  failures: PlanFailures
  flutter?: FlutterSummary
  prUrl: (n: number) => string
}) {
  const { window, config, outcomes } = opts
  const prLink = (n: number) => `<a href="${opts.prUrl(n)}">#${n}</a>`
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
        [...(o.kind === 'flutter' ? ['Flutter'] : []), ...o.packages.map(pkgLink)].join(', '),
        actions[o.action],
        o.pr === undefined ? '' : prLink(o.pr),
      ]),
    ])
  }
  const tz = config.schedule.timezone
  const flutter = opts.flutter
  if (flutter && (flutter.target || flutter.waiting || flutter.unresolvable)) {
    s.addHeading('Flutter SDK', 3)
    if (flutter.target) {
      s.addTable([
        ['Current', 'Target', 'Status'].map((data) => ({ data, header: true })),
        [flutter.target.from, flutter.target.to, flutterStatus(outcomes, flutter.unresolvable !== undefined, prLink)],
      ])
    }
    if (flutter.unresolvable) {
      s.addDetails(`Flutter ${flutter.unresolvable.version}`, `<pre>${escapeHtml(flutter.unresolvable.reason)}</pre>`)
    }
    if (flutter.waiting) {
      const w = flutter.waiting
      s.addRaw(
        `<p>Waiting for the release age: Flutter ${w.version} (published ${formatTime(w.released, tz)}, used from ${formatTime(w.shownFrom, tz)})</p>`,
        true,
      )
    }
  }
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
      s.addRaw(`<p>${outcomeLabel(o).join(', ') || 'pubreform'}${o.pr === undefined ? '' : ` (#${o.pr})`}</p>`, true)
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
  const vscodeSettings = await readOptional(path.join(dir, '.vscode', 'settings.json'))
  if (hasWorkspace(files.pubspec)) throw new Error('pub workspaces are not supported')
  const postUpdate = config.post_update.length > 0
  if (postUpdate) await checkEnvironment()
  const hashes = { baseHash: baseHash({ ...files, fvmrc }), configHash: configHash(config) }

  const window = computeWindow(config.schedule, config.min_release_age_days, new Date())
  core.info(`slot: ${window.slot.toISOString()}, cutoff: ${window.cutoff.toISOString()}`)

  // The Flutter update: only for a stable version in .fvmrc. Not getting the releases is a global error.
  const currentFlutter = config.flutter.enabled ? pinnedFlutter(fvmrc) : undefined
  let releases: FlutterRelease[] = []
  let flutterSummary: FlutterSummary | undefined
  if (currentFlutter !== undefined) {
    // For tests only: fetch from a fixture server.
    releases = await fetchReleases(process.env.PUBREFORM_FLUTTER_RELEASES || undefined)
    const { target, waiting } = chooseTarget(releases, currentFlutter, window.cutoff)
    core.info(`Flutter ${currentFlutter}: target ${target?.to ?? 'none'}${waiting ? `, waiting for ${waiting.version}` : ''}`)
    flutterSummary = {
      ...(target ? { target } : {}),
      ...(waiting
        ? { waiting: { ...waiting, shownFrom: firstSlotShowing(config.schedule, config.min_release_age_days, waiting.released) } }
        : {}),
    }
  }

  // Before applying: whether the Flutter update is applied depends on its pull request.
  const openPrs = await github.openPrs(base)
  const closedPrs = await github.closedPrs(base)

  const deps = directDeps(files.pubspec, files.lock)
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
  /** Operations on the flutter pull request decided without applying the update. */
  const flutterOps: Op[] = []
  try {
    // Every resolution sees the same versions, so the fixes are known before planning.
    fixes = await core.group('Security advisories', async () => {
      const found = await collectFixes({
        pubspec: files.pubspec,
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
    const pub = new Pub({ dir, flutter: isFlutter(files.pubspec), fvm: fvmrc !== undefined, hostedUrl: proxy.url })
    thePlan = await core.group('Plan', () =>
      plan({
        deps,
        basePubspec: files.pubspec,
        resolve: async (args, pubspec) => lockVersions((await pub.run(args, { pubspec, lock: files.lock })).lock),
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
    const target = flutterSummary?.target
    if (target) {
      const decided = decideFlutter(target, openPrs, closedPrs, hashes, config.flutter.reapply)
      if (decided !== 'apply') {
        core.info(`Flutter ${target.to}: not applied (${decided.op})`)
        flutterOps.push(decided)
      } else {
        await core.group(`Apply flutter: ${target.from} → ${target.to}`, async () => {
          const unit: Unit = { kind: 'flutter', members: [], targets: {} }
          try {
            const result = await applyFlutter(target)
            if ('unresolvable' in result) {
              core.info(`Flutter ${target.to} does not resolve:\n${result.unresolvable}`)
              flutterSummary!.unresolvable = { version: target.to, reason: result.unresolvable }
            } else {
              results.push(result)
            }
          } catch (e) {
            unitErrors.push({ unit, log: e instanceof Error ? e.message : String(e) })
          }
        })
      }
    }
  } finally {
    await proxy.stop()
  }

  /** Resolves and applies the Flutter update with the new SDK, in a copy of the base. */
  async function applyFlutter(target: FlutterTarget): Promise<UnitResult | { unresolvable: string }> {
    const from = target.from
    const flutterFiles = [{ path: '.fvmrc', content: rewriteFvmrc(fvmrc!, from, target.to) }]
    if (vscodeSettings !== undefined) {
      const content = rewriteVscodeSettings(vscodeSettings, from, target.to)
      if (content !== vscodeSettings) flutterFiles.push({ path: '.vscode/settings.json', content })
    }
    const pubspec = rewriteEnvironment(files.pubspec, { flutter: target.to, dart: target.dartTo }, config.flutter.versioning)
    const flutterDir = path.join(path.dirname(dir), 'flutter')
    await prepareFlutterDir(dir, flutterDir, flutterFiles[0]!.content)
    await installFlutter(flutterDir, target.to)
    const flutterPub = new Pub({ dir: flutterDir, flutter: isFlutter(files.pubspec), fvm: true, hostedUrl: proxy.url })
    const planned = await planFlutter({
      deps,
      pubspec,
      resolve: async (args, p) => lockVersions((await flutterPub.run(args, { pubspec: p, lock: files.lock })).lock),
    })
    if ('unresolvable' in planned) return planned
    const result = (await applyUnit(planned.unit, {
      base: { pubspec, lock: files.lock },
      deps,
      versioning: config.versioning,
      pub: (args, f) => flutterPub.run(args, f),
      fixes,
      cutoff: window.cutoff,
      flutter: { from, to: target.to, ...(target.dartFrom ? { dartFrom: target.dartFrom } : {}), dartTo: target.dartTo, files: flutterFiles },
    }))!
    // For tests only: fetch from a fixture server.
    const changelog = await fetchFlutterChangelog(releases, from, target.to, process.env.PUBREFORM_FLUTTER_CHANGELOG || undefined)
    return changelog === undefined ? result : { ...result, flutter: { ...result.flutter!, changelog } }
  }

  // The flutter pull request of an operation decided without applying is not matched again.
  const flutterPrs = new Set(flutterOps.flatMap((o) => ('pr' in o ? [o.pr] : [])))
  const ops = [
    ...decide(
      results,
      unitErrors,
      thePlan,
      openPrs.filter((p) => !flutterPrs.has(p)),
      closedPrs,
      hashes,
      flutterSummary?.unresolvable,
    ),
    ...flutterOps,
  ]
  const flutter = isFlutter(files.pubspec)
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
    flutter: flutterSummary,
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
