// Planning update units (detailed design §10).
import { type DirectDep, withConstraints } from './pubspec.ts'
import { allows, compareVersions, isStable, maxVersion } from './version.ts'

/** Resolves with pub and returns name -> version from the resulting lockfile. */
export type Resolve = (args: string[], pubspec: string) => Promise<Map<string, string>>

export type UnitKind = 'single' | 'minor' | 'group'

export interface Unit {
  kind: UnitKind
  /** minor: direct dependencies that change in U. single / group: S. */
  members: string[]
  /** single / group: the versions in R. */
  targets: Record<string, string>
}

export interface Unresolvable {
  name: string
  resolvable: string
  latest: string
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

  const U = await resolve(['upgrade'], basePubspec)
  const R = await resolve(['upgrade'], withConstraints(basePubspec, new Map(deps.map((d) => [d.name, `>=${d.current}`]))))

  const minor = deps.filter((d) => get(U, d.name, 'U') !== d.current).map((d) => d.name)
  const X = deps.filter((d) => compareVersions(get(R, d.name, 'R'), get(U, d.name, 'U')) > 0).map((d) => d.name)

  async function closure(start: Set<string>): Promise<Set<string>> {
    const S = new Set(start)
    for (;;) {
      const constraints = new Map<string, string>()
      for (const d of deps) constraints.set(d.name, S.has(d.name) ? R.get(d.name)! : `>=${d.current}`)
      const L = await resolve(['get'], withConstraints(basePubspec, constraints))
      const K = deps.filter((e) => !S.has(e.name) && !allows(e.constraint, get(L, e.name, 'S')))
      if (K.length === 0) return S
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
      if (m.parts.some((p) => p.size === m.set.size)) {
        next.push(m.set)
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
  if (minor.length > 0) units.push({ kind: 'minor', members: minor, targets: {} })
  const updateUnits = sets.map((s): Unit => {
    const members = [...s].sort()
    return {
      kind: members.length === 1 ? 'single' : 'group',
      members,
      targets: Object.fromEntries(members.map((m) => [m, R.get(m)!])),
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
        unresolvable.push({ name: d.name, resolvable, latest })
      }
    } catch (e) {
      log(`Failed to get the versions of ${d.name}: ${(e as Error).message}`)
    }
  }

  return { units, uncertain, unresolvable }
}
