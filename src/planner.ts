// Planning update units.
import type { Fix } from './advisories.ts'
import { type DirectDep, type Section, withConstraints } from './pubspec.ts'
import { allows, compareVersions, isPinned, isStable, maxVersion } from './version.ts'

/** Resolves with pub and returns name -> version from the resulting lockfile. */
export type Resolve = (args: string[], pubspec: string) => Promise<Map<string, string>>

export type UnitKind = 'single' | 'minor' | 'group'

export interface Unit {
  kind: UnitKind
  /** minor: direct dependencies that change in U (may be empty when only fixed transitive ones change). single / group: S. */
  members: string[]
  /** single / group: the versions in R of the members, and in S's resolution of the pinned dependencies outside S that it moves. minor: the versions in U of the pinned members. */
  targets: Record<string, string>
}

export interface Unresolvable {
  name: string
  section: Section
  current: string
  resolvable: string
  latest: string
  /** Why the latest version does not resolve. */
  reason: string
}

export interface Plan {
  units: Unit[]
  /** Packages whose planning failed. */
  uncertain: Set<string>
  unresolvable: Unresolvable[]
}

export interface PlanInput {
  deps: DirectDep[]
  basePubspec: string
  resolve: Resolve
  /** Versions shown by the registry proxy. */
  visibleVersions: (name: string) => Promise<string[]>
  /** Locked packages that security advisories affect. */
  fixes: Map<string, Fix>
  log?: (message: string) => void
}

/** Errors in U or R are global errors and are thrown. */
export async function plan(input: PlanInput): Promise<Plan> {
  const { deps, basePubspec, resolve } = input
  const log = input.log ?? (() => {})
  const get = (versions: Map<string, string>, name: string, label: string) => {
    const v = versions.get(name)
    if (v === undefined) throw new Error(`${name} is missing from the lockfile of ${label}`)
    return v
  }

  // Classification reads a pinned version as ^c(d), so that its minor and patch updates go into the minor unit.
  const pins = new Map(deps.filter((d) => isPinned(d.constraint)).map((d) => [d.name, `^${d.current}`]))
  const range = (d: DirectDep) => pins.get(d.name) ?? d.constraint
  const U = await resolve(['upgrade'], pins.size > 0 ? withConstraints(basePubspec, pins) : basePubspec)
  const R = await resolve(['upgrade'], withConstraints(basePubspec, new Map(deps.map((d) => [d.name, `>=${d.current}`]))))

  const minor = deps.filter((d) => get(U, d.name, 'U') !== d.current).map((d) => d.name)
  // Transitive dependencies that U moves off the versions that the advisories affect.
  const direct = new Set(deps.map((d) => d.name))
  const fixedTransitive = [...input.fixes.values()].filter((f) => {
    const u = U.get(f.name)
    return !direct.has(f.name) && u !== undefined && u !== f.locked && !f.affected.has(u)
  })
  const X = deps.filter((d) => compareVersions(get(R, d.name, 'R'), get(U, d.name, 'U')) > 0).map((d) => d.name)

  // The last resolution of the closure that settled each set.
  const lockOf = new Map<Set<string>, Map<string, string>>()
  async function closure(start: Set<string>): Promise<Set<string>> {
    const S = new Set(start)
    for (;;) {
      const constraints = new Map<string, string>()
      for (const d of deps) constraints.set(d.name, S.has(d.name) ? R.get(d.name)! : `>=${d.current}`)
      const L = await resolve(['get'], withConstraints(basePubspec, constraints))
      const K = deps.filter((e) => !S.has(e.name) && !allows(range(e), get(L, e.name, 'S')))
      if (K.length === 0) {
        lockOf.set(S, L)
        return S
      }
      for (const e of K) S.add(e.name)
    }
  }

  const uncertain = new Set<string>()
  let sets: Set<string>[] = []
  for (const d of X) {
    try {
      sets.push(await closure(new Set([d])))
    } catch (e) {
      uncertain.add(d)
      log(`Failed to plan ${d}: ${(e as Error).message}`)
    }
  }

  // Merge overlapping sets and compute the closure of each merged set again, until none overlap.
  for (;;) {
    const merged: { set: Set<string>; parts: Set<string>[] }[] = []
    for (const s of sets) {
      const overlapping = merged.filter((m) => [...s].some((x) => m.set.has(x)))
      const target = { set: new Set(s), parts: [s] }
      for (const m of overlapping) {
        for (const x of m.set) target.set.add(x)
        target.parts.push(...m.parts)
      }
      for (const m of overlapping) merged.splice(merged.indexOf(m), 1)
      merged.push(target)
    }
    if (merged.length === sets.length) break
    const next: Set<string>[] = []
    for (const m of merged) {
      // A merged set equal to one of its parts is already closed.
      const closed = m.parts.find((p) => p.size === m.set.size)
      if (closed) {
        next.push(closed)
        continue
      }
      try {
        next.push(await closure(m.set))
      } catch (e) {
        for (const x of m.set) uncertain.add(x)
        log(`Failed to plan ${[...m.set].sort().join(', ')}: ${(e as Error).message}`)
      }
    }
    sets = next
  }

  const units: Unit[] = []
  if (minor.length > 0 || fixedTransitive.length > 0) {
    const targets = Object.fromEntries(minor.filter((m) => pins.has(m)).map((m) => [m, U.get(m)!]))
    units.push({ kind: 'minor', members: minor, targets })
  }
  const updateUnits = sets.map((s): Unit => {
    const members = [...s].sort()
    const L = lockOf.get(s)!
    // pub add can move a caret dependency within its range, but not a pinned one, so it is passed too.
    const moved = deps.filter((e) => !s.has(e.name) && pins.has(e.name) && L.get(e.name) !== e.current)
    return {
      kind: members.length === 1 ? 'single' : 'group',
      members,
      targets: Object.fromEntries([...members.map((m) => [m, R.get(m)!]), ...moved.map((e) => [e.name, L.get(e.name)!])]),
    }
  })
  updateUnits.sort((a, b) => (a.members[0]! < b.members[0]! ? -1 : 1))
  units.push(...updateUnits)

  const unresolvable: Unresolvable[] = []
  for (const d of deps) {
    try {
      const latest = maxVersion((await input.visibleVersions(d.name)).filter(isStable))
      const resolvable = R.get(d.name)!
      if (latest !== undefined && compareVersions(latest, resolvable) > 0) {
        const reason = await whyUnresolvable(input, d.name, latest)
        unresolvable.push({ name: d.name, section: d.section, current: d.current, resolvable, latest, reason })
      }
    } catch (e) {
      log(`Failed to get the versions of ${d.name}: ${(e as Error).message}`)
    }
  }

  return { units, uncertain, unresolvable }
}

/** Resolves with `name` at `latest` and the other direct dependencies loosened, and returns pub's explanation. */
async function whyUnresolvable(input: PlanInput, name: string, latest: string): Promise<string> {
  const constraints = new Map(input.deps.map((d) => [d.name, d.name === name ? latest : `>=${d.current}`]))
  try {
    await input.resolve(['get'], withConstraints(input.basePubspec, constraints))
    return 'Resolves with other versions of the other dependencies, but pub upgrade chooses a combination without the latest version.'
  } catch (e) {
    return solveFailure((e as Error).message)
  }
}

/** pub's explanation in an error from `resolve`: the lines after the command, up to `version solving failed.`. */
export function solveFailure(message: string): string {
  const lines = message.split('\n').slice(1)
  const end = lines.findIndex((l) => l.includes('version solving failed.'))
  return (end === -1 ? lines : lines.slice(0, end + 1)).join('\n').trim()
}
