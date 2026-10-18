// A small brute-force solver standing in for pub in planner tests.
import { parse } from 'yaml'
import { allows, compareVersions } from '../src/version.ts'

/** package -> version -> requirements (package -> constraint). */
export type Universe = Record<string, Record<string, Record<string, string>>>

export function fakeResolve(universe: Universe, locked: Map<string, string>, calls: string[][] = []) {
  return async (args: string[], pubspec: string): Promise<Map<string, string>> => {
    calls.push(args)
    const doc = parse(pubspec)
    const constraints = new Map<string, string>()
    for (const section of ['dependencies', 'dev_dependencies']) {
      for (const [name, c] of Object.entries(doc[section] ?? {})) {
        constraints.set(name, c === null ? 'any' : typeof c === 'string' ? c : (c as { version: string }).version)
      }
    }
    const names = [...constraints.keys()]
    const candidates = names.map((name) => {
      const versions = Object.keys(universe[name] ?? {})
        .filter((v) => allows(constraints.get(name)!, v))
        .sort((a, b) => compareVersions(b, a))
      const lockedVersion = locked.get(name)
      if (args[0] === 'get' && lockedVersion && versions.includes(lockedVersion)) {
        return [lockedVersion, ...versions.filter((v) => v !== lockedVersion)]
      }
      return versions
    })
    const chosen = new Map<string, string>()
    const valid = () =>
      [...chosen].every(([name, v]) =>
        Object.entries(universe[name]![v]!).every(([dep, c]) => chosen.has(dep) && allows(c, chosen.get(dep)!)),
      )
    const search = (i: number): boolean => {
      if (i === names.length) return valid()
      for (const v of candidates[i]!) {
        chosen.set(names[i]!, v)
        if (search(i + 1)) return true
      }
      chosen.delete(names[i]!)
      return false
    }
    if (!search(0)) throw new Error('version solving failed')
    return chosen
  }
}
