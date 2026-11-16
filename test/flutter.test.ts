import { describe, expect, test } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type FlutterRelease,
  chooseTarget,
  fetchFlutterChangelog,
  parseReleases,
  pinnedFlutter,
  planFlutter,
  rewriteEnvironment,
  rewriteFvmrc,
  rewriteSdkConstraint,
  rewriteVscodeSettings,
} from '../src/flutter.ts'
import type { DirectDep } from '../src/pubspec.ts'
import { fakeResolve } from './fake-pub.ts'

describe('pinnedFlutter', () => {
  test('a stable version', () => {
    expect(pinnedFlutter('{"flutter": "3.47.7", "flavors": {"dev": "stable"}}')).toBe('3.47.7')
  })
  test('anything else is not updated', () => {
    for (const fvmrc of [
      undefined,
      '',
      'not json',
      '{}',
      '{"flutter": 3}',
      '{"flutter": "stable"}',
      '{"flutter": "3.47.7@stable"}',
      '{"flutter": "myfork/3.47.7"}',
      '{"flutter": "3.51.0-0.1.pre"}',
      '{"flutter": "abcdef0"}',
    ]) {
      expect(pinnedFlutter(fvmrc)).toBeUndefined()
    }
  })
})

describe('parseReleases', () => {
  const release = (version: string, extra: Record<string, unknown> = {}) => ({
    channel: 'stable',
    version,
    release_date: '2026-10-08T17:00:00.000Z',
    dart_sdk_version: '3.13.5',
    ...extra,
  })
  test('stable releases with a version, a Dart version and a date', () => {
    expect(
      parseReleases({
        releases: [
          release('3.50.0', { dart_sdk_version: '3.14.0', release_date: '2026-11-11T18:00:00.000Z' }),
          release('3.52.0-0.1.pre', { channel: 'beta', dart_sdk_version: '3.15.0 (build 3.15.0-118.1.beta)' }),
          release('3.51.0', { channel: 'beta' }),
          release('v1.12.13+hotfix.9'),
          release('3.47.8', { dart_sdk_version: '3.13.6 (build 3.13.6-1.0.beta)' }),
          release('3.47.9', { release_date: 'not a date' }),
          release('3.47.6', { release_date: undefined }),
          release('3.47.7'),
          release('3.47.7', { dart_sdk_version: '3.13.4' }),
          'not an object',
        ],
      }),
    ).toEqual([
      { version: '3.50.0', dart: '3.14.0', released: new Date('2026-11-11T18:00:00.000Z') },
      { version: '3.47.7', dart: '3.13.5', released: new Date('2026-10-08T17:00:00.000Z') },
    ])
  })
  test('throws without a list of releases', () => {
    expect(() => parseReleases({})).toThrow('releases is not a list')
    expect(() => parseReleases([])).toThrow('releases is not a list')
  })
})

const day = (d: string) => new Date(`${d}T00:00:00Z`)
// The release list of 2026-11-15 (F basic design §3.2).
const RELEASES: FlutterRelease[] = [
  { version: '3.50.0', dart: '3.14.0', released: day('2026-11-11') },
  { version: '3.47.9', dart: '3.13.7', released: day('2026-10-29') },
  { version: '3.47.8', dart: '3.13.6', released: day('2026-10-23') },
  { version: '3.47.7', dart: '3.13.5', released: day('2026-10-08') },
  { version: '3.44.0', dart: '3.12.0', released: day('2026-08-01') },
]

describe('chooseTarget', () => {
  test('the newest release by the cutoff, and a newer one that waits', () => {
    expect(chooseTarget(RELEASES, '3.47.7', day('2026-11-06'))).toEqual({
      target: { from: '3.47.7', to: '3.47.9', dartFrom: '3.13.5', dartTo: '3.13.7', released: day('2026-10-29') },
      waiting: { version: '3.50.0', released: day('2026-11-11') },
    })
    expect(chooseTarget(RELEASES, '3.47.7', day('2026-11-13'))).toEqual({
      target: { from: '3.47.7', to: '3.50.0', dartFrom: '3.13.5', dartTo: '3.14.0', released: day('2026-11-11') },
    })
  })
  test('by version, not by date', () => {
    const releases = [...RELEASES, { version: '3.47.10', dart: '3.13.8', released: day('2026-11-12') }]
    expect(chooseTarget(releases, '3.47.7', day('2026-11-13')).target?.to).toBe('3.50.0')
  })
  test('nothing newer', () => {
    expect(chooseTarget(RELEASES, '3.50.0', day('2026-11-13'))).toEqual({})
  })
  test('only a release that waits', () => {
    expect(chooseTarget(RELEASES, '3.47.9', day('2026-11-06'))).toEqual({ waiting: { version: '3.50.0', released: day('2026-11-11') } })
  })
  test('no Dart version when the current version is not in the list', () => {
    const { target } = chooseTarget(RELEASES, '3.47.5', day('2026-11-13'))
    expect(target).toEqual({ from: '3.47.5', to: '3.50.0', dartTo: '3.14.0', released: day('2026-11-11') })
  })
})

describe('rewriteFvmrc', () => {
  test('only the value of flutter changes', () => {
    const text = '{\n  "flutter": "3.47.7",\n  "flavors": { "dev": "3.47.7" },\n  "updateVscodeSettings": false\n}\n'
    expect(rewriteFvmrc(text, '3.47.7', '3.50.0')).toBe(
      '{\n  "flutter": "3.50.0",\n  "flavors": { "dev": "3.47.7" },\n  "updateVscodeSettings": false\n}\n',
    )
  })
  test('throws when another value would be rewritten', () => {
    expect(() => rewriteFvmrc('{"flavors": {"flutter": "3.47.7"}, "flutter": "3.47.7"}', '3.47.7', '3.50.0')).toThrow(
      'cannot rewrite the Flutter version in .fvmrc',
    )
  })
})

describe('rewriteVscodeSettings', () => {
  test('replaces the version at the end of every dart.flutterSdkPath, also in comments', () => {
    const text = `{
  // Pinned by fvm.
  "dart.flutterSdkPath": ".fvm/versions/3.47.7",
  // "dart.flutterSdkPath": "/home/me/fvm/versions/3.47.7",
  "dart.flutterSdkPath" : "C:\\\\fvm\\\\versions\\\\3.47.7",
  "other": ".fvm/versions/3.47.7",
}
`
    expect(rewriteVscodeSettings(text, '3.47.7', '3.50.0')).toBe(`{
  // Pinned by fvm.
  "dart.flutterSdkPath": ".fvm/versions/3.50.0",
  // "dart.flutterSdkPath": "/home/me/fvm/versions/3.50.0",
  "dart.flutterSdkPath" : "C:\\\\fvm\\\\versions\\\\3.50.0",
  "other": ".fvm/versions/3.47.7",
}
`)
  })
  test('a path without the version is not changed', () => {
    for (const text of [
      '{"dart.flutterSdkPath": ".fvm/flutter_sdk"}',
      '{"dart.flutterSdkPath": ".fvm/versions/3.47.70"}',
      '{"dart.flutterSdkPath": ".fvm/versions/13.47.7"}',
      '{"dart.flutterSdkPath": "3.47.7"}',
      '{"editor.tabSize": 2}',
    ]) {
      expect(rewriteVscodeSettings(text, '3.47.7', '3.50.0')).toBe(text)
    }
  })
})

describe('rewriteSdkConstraint', () => {
  const cases: [constraint: string, v: string, increase: string, lockfileOnly: string][] = [
    ['any', '3.50.0', 'any', 'any'],
    ['3.47.7', '3.50.0', '3.50.0', '3.50.0'],
    ['^3.47.7', '3.50.0', '^3.50.0', '^3.47.7'],
    ['^3.47.7', '4.1.0', '^4.1.0', '^4.1.0'],
    ['^0.1.0', '0.2.0', '^0.2.0', '^0.2.0'],
    ['>=3.47.7', '3.50.0', '>=3.50.0', '>=3.47.7'],
    ['>3.47.7', '3.50.0', '>=3.50.0', '>3.47.7'],
    ['>=3.50.0', '3.50.0', '>=3.50.0', '>=3.50.0'],
    // The base did not resolve: the bound follows the new version.
    ['>=3.51.0', '3.50.0', '>=3.50.0', '>=3.50.0'],
    ['>=3.47.0 <3.48.0', '3.50.0', '>=3.50.0 <3.51.0', '>=3.47.0 <3.51.0'],
    ['>=3.47.0 <3.48.0', '4.1.0', '>=4.1.0 <4.2.0', '>=3.47.0 <4.2.0'],
    ['>=3.47.0 <4.0.0', '3.50.0', '>=3.50.0 <4.0.0', '>=3.47.0 <4.0.0'],
    ['>=3.47.0 <4.0.0', '4.1.0', '>=4.1.0 <5.0.0', '>=3.47.0 <5.0.0'],
    ['>=3.47.0 <3.47.9', '3.50.0', '>=3.50.0 <3.50.1', '>=3.47.0 <3.50.1'],
    ['>=3.47.0 <=3.47.9', '3.50.0', '>=3.50.0 <=3.50.0', '>=3.47.0 <=3.50.0'],
    ['>=3.47.0 <3.48.0-0', '3.50.0', '>=3.50.0 <3.51.0', '>=3.47.0 <3.51.0'],
    // Unchanged constraints keep their spacing; changed ones are joined with one space.
    ['>= 3.47.0  <4.0.0', '3.50.0', '>=3.50.0 <4.0.0', '>= 3.47.0  <4.0.0'],
  ]
  for (const [constraint, v, increase, lockfileOnly] of cases) {
    test(`${constraint} for ${v}`, () => {
      expect(rewriteSdkConstraint(constraint, v, 'increase')).toBe(increase)
      expect(rewriteSdkConstraint(constraint, v, 'lockfile-only')).toBe(lockfileOnly)
    })
  }
  test('throws on what is not a constraint', () => {
    expect(() => rewriteSdkConstraint('~3.47.0', '3.50.0', 'increase')).toThrow()
  })
})

describe('rewriteEnvironment', () => {
  const v = { flutter: '3.50.0', dart: '3.14.0' }
  // The examples of F basic design §4.2.
  test('a pinned flutter', () => {
    const pubspec = 'name: app\nenvironment:\n  sdk: ^3.13.5\n  flutter: 3.47.7\n'
    expect(rewriteEnvironment(pubspec, v, 'increase')).toBe('name: app\nenvironment:\n  sdk: ^3.14.0\n  flutter: 3.50.0\n')
    expect(rewriteEnvironment(pubspec, v, 'lockfile-only')).toBe('name: app\nenvironment:\n  sdk: ^3.13.5\n  flutter: 3.50.0\n')
  })
  test('a range, with the quotes and the comments kept', () => {
    const pubspec = `name: app # the app
environment:
  sdk: '^3.9.0' # language version
  flutter: ">=3.47.0 <3.48.0"   # tested range
dependencies:
  http: ^1.0.0
`
    expect(rewriteEnvironment(pubspec, v, 'increase')).toBe(`name: app # the app
environment:
  sdk: '^3.14.0' # language version
  flutter: ">=3.50.0 <3.51.0"   # tested range
dependencies:
  http: ^1.0.0
`)
    expect(rewriteEnvironment(pubspec, v, 'lockfile-only')).toBe(`name: app # the app
environment:
  sdk: '^3.9.0' # language version
  flutter: ">=3.47.0 <3.51.0"   # tested range
dependencies:
  http: ^1.0.0
`)
  })
  test('missing keys are not added, and values that are not constraints are kept', () => {
    expect(rewriteEnvironment('name: app\n', v, 'increase')).toBe('name: app\n')
    expect(rewriteEnvironment('name: app\nenvironment:\n  sdk: ^3.0.0\n', v, 'increase')).toBe(
      'name: app\nenvironment:\n  sdk: ^3.14.0\n',
    )
    for (const pubspec of [
      'environment:\n  sdk:\n  flutter: 3.47.7x\n',
      'environment:\n  sdk: >-\n    ^3.0.0\n',
      'environment:\n  flutter: 3\n',
      'environment: 3\n',
    ]) {
      expect(rewriteEnvironment(pubspec, v, 'increase')).toBe(pubspec)
    }
  })
})

describe('planFlutter', () => {
  const dep = (name: string, constraint: string, section: DirectDep['section'] = 'dev_dependencies'): DirectDep => ({
    name,
    section,
    constraint,
    current: '1.31.1',
  })
  // With the new SDK, flutter_test pins test_api 0.7.14; test 1.31.1 needs 0.7.12, and 1.32.0 needs 0.7.14.
  const universe = {
    test: { '1.31.1': { test_api: '0.7.12' }, '1.32.0': { test_api: '0.7.14' } },
    test_api: { '0.7.12': {}, '0.7.14': {} },
    http: { '1.5.0': {}, '1.6.0': {} },
  }
  const pubspecWith = (test: string) =>
    `name: app\ndependencies:\n  http: ^1.5.0\n  test_api: 0.7.14\ndev_dependencies:\n  test: ${test}\n`
  const locked = new Map([
    ['test', '1.31.1'],
    ['test_api', '0.7.12'],
    ['http', '1.5.0'],
  ])
  const deps = (test: string) => [{ ...dep('http', '^1.5.0', 'dependencies'), current: '1.5.0' }, dep('test', test)]

  // The three cases of F detailed design §17.
  test('the current constraints resolve: nothing to raise', async () => {
    const calls: string[][] = []
    const resolve = fakeResolve(universe, locked, calls)
    expect(await planFlutter({ deps: deps('^1.31.1'), pubspec: pubspecWith('^1.31.1'), resolve })).toEqual({
      unit: { kind: 'flutter', members: [], targets: {} },
    })
    expect(calls).toEqual([['get']])
  })
  test('a pinned dependency moves within its range', async () => {
    const resolve = fakeResolve(universe, locked)
    expect(await planFlutter({ deps: deps('1.31.1'), pubspec: pubspecWith('1.31.1'), resolve })).toEqual({
      unit: { kind: 'flutter', members: [], targets: { test: '1.32.0' } },
    })
  })
  test('a dependency moves out of its range', async () => {
    const resolve = fakeResolve(universe, locked)
    const pubspec = pubspecWith('">=1.31.1 <1.32.0"')
    expect(await planFlutter({ deps: deps('>=1.31.1 <1.32.0'), pubspec, resolve })).toEqual({
      unit: { kind: 'flutter', members: ['test'], targets: { test: '1.32.0' } },
    })
  })
  test('does not resolve with the direct dependencies loosened', async () => {
    const resolve = fakeResolve({ ...universe, test: { '1.31.1': { test_api: '0.7.12' } } }, locked)
    expect(await planFlutter({ deps: deps('1.31.1'), pubspec: pubspecWith('1.31.1'), resolve })).toEqual({
      unresolvable: 'version solving failed.',
    })
  })
  test('failures other than version solving are thrown', async () => {
    const network = async () => {
      throw new Error('fvm flutter pub get failed\nGot socket error')
    }
    await expect(planFlutter({ deps: deps('1.31.1'), pubspec: pubspecWith('1.31.1'), resolve: network })).rejects.toThrow('Got socket error')
    let first = true
    const thenNetwork = async (args: string[], pubspec: string) => {
      if (first) {
        first = false
        return fakeResolve(universe, locked)(args, pubspec.replace('test: 1.31.1', 'test: 9.9.9'))
      }
      throw new Error('fvm flutter pub get failed\nGot socket error')
    }
    await expect(planFlutter({ deps: deps('1.31.1'), pubspec: pubspecWith('1.31.1'), resolve: thenNetwork })).rejects.toThrow(
      'Got socket error',
    )
  })
})

describe('fetchFlutterChangelog', () => {
  const CHANGELOG_347 = `## Flutter 3.50 Changes

## Flutter 3.47 Changes

### [3.47.9](https://github.com/flutter/flutter/releases/tag/3.47.9)
- Fixes https://github.com/flutter/flutter/issues/100 by @someone.

### [3.47.8](https://github.com/flutter/flutter/releases/tag/3.47.8)
- [flutter/176000](https://github.com/flutter/flutter/pull/176000) A fix.

### [3.47.7](https://github.com/flutter/flutter/releases/tag/3.47.7)
- Already in the base.
`
  const CHANGELOG_350 = `## Flutter 3.50 Changes

### [3.50.0](https://github.com/flutter/flutter/releases/tag/3.50.0)
- The 3.50 release. Fixes #200.

## Flutter 3.47 Changes

### [3.47.8](https://github.com/flutter/flutter/releases/tag/3.47.8)
- Not taken from this branch.
`
  async function serve(files: Record<string, string>) {
    const requests: string[] = []
    const server = http.createServer((req, res) => {
      requests.push(req.url!)
      const body = files[req.url!]
      res.writeHead(body === undefined ? 404 : 200).end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) }
  }

  test('the sections of each minor from its release branch, newest minor first', async () => {
    const server = await serve({
      '/flutter-3.47-candidate.0/CHANGELOG.md': CHANGELOG_347,
      '/flutter-3.50-candidate.0/CHANGELOG.md': CHANGELOG_350,
    })
    try {
      const text = await fetchFlutterChangelog(RELEASES, '3.47.7', '3.50.0', server.url)
      expect(text).toBe(`### [3.50.0](https://github.com/flutter/flutter/releases/tag/3.50.0)
- The 3.50 release. Fixes [#200](https://redirect.github.com/flutter/flutter/issues/200).

### [3.47.9](https://github.com/flutter/flutter/releases/tag/3.47.9)
- Fixes https://redirect.github.com/flutter/flutter/issues/100 by @\u200bsomeone.

### [3.47.8](https://github.com/flutter/flutter/releases/tag/3.47.8)
- [flutter/176000](https://redirect.github.com/flutter/flutter/pull/176000) A fix.`)
      expect(server.requests.sort()).toEqual(['/flutter-3.47-candidate.0/CHANGELOG.md', '/flutter-3.50-candidate.0/CHANGELOG.md'])
    } finally {
      await server.close()
    }
  })
  test('a branch that cannot be fetched is left out; none at all is undefined', async () => {
    const server = await serve({ '/flutter-3.47-candidate.0/CHANGELOG.md': CHANGELOG_347 })
    try {
      expect(await fetchFlutterChangelog(RELEASES, '3.47.8', '3.50.0', server.url)).toBe(
        '### [3.47.9](https://github.com/flutter/flutter/releases/tag/3.47.9)\n- Fixes https://redirect.github.com/flutter/flutter/issues/100 by @\u200bsomeone.',
      )
      expect(await fetchFlutterChangelog(RELEASES, '3.47.9', '3.50.0', server.url)).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})
