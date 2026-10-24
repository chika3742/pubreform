// Versions and version constraints, as far as pubreform needs them.
// pub's caret differs from npm's (^0.0.1 = >=0.0.1 <0.1.0), so this does not use a semver library.

export interface Version {
  major: number
  minor: number
  patch: number
  pre: string[]
  build: string[]
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

export function parseVersion(s: string): Version {
  const m = VERSION.exec(s)
  if (!m) throw new Error(`invalid version "${s}"`)
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
  }
}

/** Whether a constraint pins one version (`1.2.3`). */
export function isPinned(constraint: string): boolean {
  return VERSION.test(constraint.trim())
}

export function isStable(v: string): boolean {
  return parseVersion(v).pre.length === 0
}

function compareIdentifiers(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    const x = a[i]!
    const y = b[i]!
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) - Number(y)
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Semver order. As in pub, a version with build metadata sorts after the same version without. */
export function compareVersions(a: string | Version, b: string | Version): number {
  const x = typeof a === 'string' ? parseVersion(a) : a
  const y = typeof b === 'string' ? parseVersion(b) : b
  if (x.major !== y.major) return Math.sign(x.major - y.major)
  if (x.minor !== y.minor) return Math.sign(x.minor - y.minor)
  if (x.patch !== y.patch) return Math.sign(x.patch - y.patch)
  if (x.pre.length === 0 && y.pre.length > 0) return 1
  if (x.pre.length > 0 && y.pre.length === 0) return -1
  const pre = compareIdentifiers(x.pre, y.pre)
  if (pre !== 0) return Math.sign(pre)
  if (x.build.length === 0 && y.build.length > 0) return -1
  if (x.build.length > 0 && y.build.length === 0) return 1
  return Math.sign(compareIdentifiers(x.build, y.build))
}

type Op = '>=' | '>' | '<=' | '<' | '='
interface Comparison {
  op: Op
  version: Version
}
/** Intersection of comparisons. Empty means `any`. */
export type Constraint = Comparison[]

const COMPARISON = /^(\^|>=|>|<=|<)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/

/**
 * Parses `any`, `^v`, `>=v`, `>v`, `<=v`, `<v`, `v`, and intersections of them.
 * As in pub, whitespace after an operator and between comparisons is optional (`>= 1.0.0`, `>=1.0.0<2.0.0`).
 */
export function parseConstraint(s: string): Constraint {
  let rest = s.trim()
  if (rest === 'any') return []
  const result: Constraint = []
  while (rest !== '') {
    const m = COMPARISON.exec(rest)
    if (!m) throw new Error(`invalid version constraint "${s}"`)
    rest = rest.slice(m[0].length).trimStart()
    const version = parseVersion(m[2]!)
    const op = m[1]
    if (op === '^') {
      const upper =
        version.major > 0
          ? { major: version.major + 1, minor: 0, patch: 0, pre: [], build: [] }
          : { major: 0, minor: version.minor + 1, patch: 0, pre: [], build: [] }
      result.push({ op: '>=', version }, { op: '<', version: upper })
    } else {
      result.push({ op: (op as Op | undefined) ?? '=', version })
    }
  }
  if (result.length === 0) throw new Error(`invalid version constraint "${s}"`)
  return result
}

export function allows(constraint: string | Constraint, version: string): boolean {
  const c = typeof constraint === 'string' ? parseConstraint(constraint) : constraint
  const v = parseVersion(version)
  return c.every(({ op, version: bound }) => {
    const r = compareVersions(v, bound)
    switch (op) {
      case '>=':
        return r >= 0
      case '>':
        return r > 0
      case '<=':
        return r <= 0
      case '<':
        return r < 0
      case '=':
        return r === 0
    }
  })
}

export function maxVersion(versions: Iterable<string>): string | undefined {
  let max: string | undefined
  for (const v of versions) if (max === undefined || compareVersions(v, max) > 0) max = v
  return max
}
