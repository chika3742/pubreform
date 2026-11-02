import { describe, expect, test } from 'bun:test'
import {
  applyFlutter,
  currentFlutter,
  flutterConstraint,
  flutterTarget,
  ignoresFlutter,
  parseReleases,
  releasesUrl,
  rewriteEnvironmentFlutter,
  rewriteFvmrc,
  rewriteVscodeSettings,
} from '../src/flutter.ts'

const release = (version: string, channel = 'stable', dart?: string) => ({
  hash: 'h',
  channel,
  version,
  ...(dart ? { dart_sdk_version: dart } : {}),
  release_date: '2026-10-29T19:22:44.517205Z',
})

describe('parseReleases', () => {
  test('stable x.y.z releases only, the first of each version', () => {
    const releases = parseReleases({
      base_url: 'https://storage.googleapis.com/flutter_infra_release/releases',
      current_release: { stable: 'h' },
      releases: [
        release('3.47.9', 'stable', '3.13.7'),
        release('3.48.0-0.1.pre', 'beta', '3.14.0'),
        release('3.13.3', 'stable', '3.1.1'),
        release('3.13.3', 'stable', '3.1.2'),
        release('v1.12.13+hotfix.9'),
        release('v1.0.0'),
      ],
    })
    expect(releases).toEqual([
      { version: '3.47.9', dart: '3.13.7' },
      { version: '3.13.3', dart: '3.1.1' },
    ])
  })

  test('a release without dart_sdk_version', () => {
    expect(parseReleases({ releases: [release('3.47.9')] })).toEqual([{ version: '3.47.9' }])
  })

  test('another shape throws', () => {
    expect(() => parseReleases({})).toThrow('no releases')
    expect(() => parseReleases({ releases: [{ version: '3.47.9' }] })).toThrow('invalid Flutter release')
    expect(() => parseReleases(null)).toThrow()
  })
})

test('releasesUrl', () => {
  const base = 'https://storage.googleapis.com/flutter_infra_release/releases'
  expect(releasesUrl('linux', {})).toBe(`${base}/releases_linux.json`)
  expect(releasesUrl('darwin', {})).toBe(`${base}/releases_macos.json`)
  expect(releasesUrl('win32', {})).toBe(`${base}/releases_windows.json`)
  expect(() => releasesUrl('freebsd', {})).toThrow('freebsd')
  expect(releasesUrl('freebsd', { PUBREFORM_FLUTTER_RELEASES: 'http://127.0.0.1:1/r.json' })).toBe('http://127.0.0.1:1/r.json')
})

test('currentFlutter', () => {
  expect(currentFlutter('{\n  "flutter": "3.47.9"\n}\n')).toBe('3.47.9')
  expect(currentFlutter('{"flutter": "stable"}')).toBeUndefined()
  expect(currentFlutter('{"flutter": "3.47.9@beta"}')).toBeUndefined()
  expect(currentFlutter('{"flutter": "c197ca5199e9ee5661e865596c9c07294dfab51c"}')).toBeUndefined()
  expect(currentFlutter('{"flutter": "myfork/3.47.9"}')).toBeUndefined()
  expect(currentFlutter('{"flavors": {}}')).toBeUndefined()
  expect(currentFlutter('{ not json')).toBeUndefined()
  expect(currentFlutter('null')).toBeUndefined()
})

test('flutterTarget: the newest version by version order, not by date, unless ignored', () => {
  const releases = [{ version: '3.47.9' }, { version: '3.50.0' }, { version: '3.47.10' }]
  expect(flutterTarget('3.47.8', releases, [])).toBe('3.50.0')
  expect(flutterTarget('3.47.8', releases, [{ name: 'flutter', versions: '>=3.50.0' }])).toBe('3.47.10')
  expect(flutterTarget('3.47.8', releases, [{ name: 'other' }])).toBe('3.50.0')
  expect(flutterTarget('3.47.8', releases, [{ name: 'flutter' }])).toBeUndefined()
  expect(flutterTarget('3.50.0', releases, [])).toBeUndefined()
  expect(flutterTarget('3.51.0', releases, [])).toBeUndefined()
  expect(flutterTarget('3.47.8', [], [])).toBeUndefined()
})

test('ignoresFlutter', () => {
  expect(ignoresFlutter([{ name: 'flutter' }])).toBe(true)
  expect(ignoresFlutter([{ name: 'flutter', versions: '>=4.0.0' }])).toBe(false)
  expect(ignoresFlutter([{ name: 'http' }])).toBe(false)
})

describe('rewriteFvmrc', () => {
  test('only the value changes', () => {
    const text = '{\n  "flutter": "3.47.8",\n  "updateVscodeSettings": true\n}\n'
    expect(rewriteFvmrc(text, '3.47.8', '3.47.9')).toBe('{\n  "flutter": "3.47.9",\n  "updateVscodeSettings": true\n}\n')
  })

  test('the same version in flavors stays', () => {
    const text = '{\n  "flutter": "3.47.8",\n  "flavors": { "prod": "3.47.8" }\n}'
    expect(rewriteFvmrc(text, '3.47.8', '3.47.9')).toBe('{\n  "flutter": "3.47.9",\n  "flavors": { "prod": "3.47.8" }\n}')
  })

  test('a flavor named flutter before the top-level key is not taken for it', () => {
    const text = '{"flavors": {"flutter": "3.47.8"}, "flutter": "3.47.8"}'
    expect(() => rewriteFvmrc(text, '3.47.8', '3.47.9')).toThrow('cannot rewrite')
  })

  test('another version throws', () => {
    expect(() => rewriteFvmrc('{"flutter": "3.47.7"}', '3.47.8', '3.47.9')).toThrow('cannot rewrite')
  })
})

describe('rewriteVscodeSettings', () => {
  test('the version segment of the path changes, and comments and the end of the file stay', () => {
    const text = '{\n  // The SDK of fvm.\n  "dart.flutterSdkPath": ".fvm/versions/3.47.8",\n  "editor.tabSize": 2 /* two */\n}'
    expect(rewriteVscodeSettings(text, '3.47.8', '3.47.9')).toBe(
      '{\n  // The SDK of fvm.\n  "dart.flutterSdkPath": ".fvm/versions/3.47.9",\n  "editor.tabSize": 2 /* two */\n}',
    )
  })

  test('a commented-out line, a nested key and a path without the version are not changed', () => {
    const commented = '{\n  // "dart.flutterSdkPath": ".fvm/versions/3.47.8",\n  "a": 1\n}\n'
    expect(rewriteVscodeSettings(commented, '3.47.8', '3.47.9')).toBeUndefined()
    const nested = '{"[dart]": {"dart.flutterSdkPath": ".fvm/versions/3.47.8"}}'
    expect(rewriteVscodeSettings(nested, '3.47.8', '3.47.9')).toBeUndefined()
    expect(rewriteVscodeSettings('{"dart.flutterSdkPath": ".fvm/flutter_sdk"}', '3.47.8', '3.47.9')).toBeUndefined()
    expect(rewriteVscodeSettings('{"dart.flutterSdkPath": ".fvm/versions/3.47.80"}', '3.47.8', '3.47.9')).toBeUndefined()
    expect(rewriteVscodeSettings('{"editor.tabSize": 2}', '3.47.8', '3.47.9')).toBeUndefined()
  })

  test('the key after other values, and a Windows path', () => {
    const text = '{"a": {"b": [1, "x"]}, "dart.flutterSdkPath": "C:\\\\fvm\\\\versions\\\\3.47.8"}'
    expect(rewriteVscodeSettings(text, '3.47.8', '3.47.9')).toBe('{"a": {"b": [1, "x"]}, "dart.flutterSdkPath": "C:\\\\fvm\\\\versions\\\\3.47.9"}')
    expect(rewriteVscodeSettings('{"dart.flutterSdkPath": "3.47.8"}', '3.47.8', '3.47.9')).toBe('{"dart.flutterSdkPath": "3.47.9"}')
  })

  test('a file that cannot be scanned is left as it is, and logged', () => {
    const logs: string[] = []
    expect(rewriteVscodeSettings('{"dart.flutterSdkPath": ".fvm/versions/3.47.8" /* open', '3.47.8', '3.47.9', (m) => logs.push(m))).toBeUndefined()
    expect(logs).toEqual(['.vscode/settings.json is not changed: unclosed comment'])
  })
})

describe('flutterConstraint', () => {
  test.each([
    ['any', undefined],
    ['not a constraint', undefined],
    ['<4.0.0', undefined],
    ['<=3.47.9', undefined],
    ['^3.47.9', undefined],
    ['>=3.50.0', undefined],
    ['^3.0.0', '^3.47.9'],
    ['^2.10.0', '^3.47.9'],
    ['3.47.8', '3.47.9'],
    ['>=3.0.0', '>=3.47.9'],
    ['>3.0.0', '>=3.47.9'],
    ['>= 3.0.0', '>=3.47.9'],
    ['>=3.0.0 <4.0.0', '>=3.47.9 <4.0.0'],
    ['<4.0.0 >=3.0.0', '>=3.47.9 <4.0.0'],
    ['>=3.0.0 <=3.47.9', '>=3.47.9 <=3.47.9'],
    ['>=3.0.0 < 4.0.0', '>=3.47.9 < 4.0.0'],
    ['>=3.0.0 <3.47.9', undefined],
    ['>=3.0.0 <3.10.0', undefined],
    ['^3.0.0 <3.50.0', undefined],
    ['>=3.0.0 >=3.1.0', undefined],
  ])('%s', (constraint, expected) => {
    expect(flutterConstraint(constraint, '3.47.9')).toBe(expected)
  })
})

describe('rewriteEnvironmentFlutter', () => {
  test('the quotes and comments stay', () => {
    const pubspec = 'name: app\nenvironment:\n  sdk: ^3.9.0 # Dart\n  flutter: ">=3.32.0" # Flutter\ndependencies: {}\n'
    expect(rewriteEnvironmentFlutter(pubspec, '3.47.9')).toBe(
      'name: app\nenvironment:\n  sdk: ^3.9.0 # Dart\n  flutter: ">=3.47.9" # Flutter\ndependencies: {}\n',
    )
    expect(rewriteEnvironmentFlutter("environment:\n  flutter: '^3.32.0'\n", '3.47.9')).toBe("environment:\n  flutter: '^3.47.9'\n")
    expect(rewriteEnvironmentFlutter('environment:\n  flutter: ^3.32.0\n', '3.47.9')).toBe('environment:\n  flutter: ^3.47.9\n')
    expect(rewriteEnvironmentFlutter('environment:\n  flutter: 3.32.0\n', '3.47.9')).toBe('environment:\n  flutter: 3.47.9\n')
  })

  test('no environment, no flutter, or a value that stays', () => {
    for (const pubspec of [
      'name: app\n',
      'environment:\n  sdk: ^3.9.0\n',
      'environment:\n  flutter: any\n',
      'environment:\n  flutter:\n    - ^3.0.0\n',
      'environment:\n  flutter: ">=3.0.0 <3.10.0"\n',
    ]) {
      expect(rewriteEnvironmentFlutter(pubspec, '3.47.9')).toBe(pubspec)
    }
  })
})

describe('applyFlutter', () => {
  const pubspec = 'name: app\nenvironment:\n  flutter: ^3.47.8\ndependencies:\n  flutter:\n    sdk: flutter\n'
  const releases = [
    { version: '3.47.8', dart: '3.13.7' },
    { version: '3.47.9', dart: '3.13.7' },
  ]

  test('the files are rewritten; the lockfile is the base one', () => {
    const result = applyFlutter({
      from: '3.47.8',
      to: '3.47.9',
      releases,
      pubspec,
      lock: 'lock',
      fvmrc: '{\n  "flutter": "3.47.8"\n}\n',
      vscodeSettings: '{\n  "dart.flutterSdkPath": ".fvm/versions/3.47.8"\n}\n',
    })
    expect(result.unit).toEqual({ kind: 'flutter', members: ['flutter'], targets: { flutter: '3.47.9' } })
    expect(result.files).toEqual({ pubspec: pubspec.replace('^3.47.8', '^3.47.9'), lock: 'lock' })
    expect(result.flutter).toEqual({
      from: '3.47.8',
      to: '3.47.9',
      fromDart: '3.13.7',
      toDart: '3.13.7',
      tool: 'flutter',
      files: {
        '.fvmrc': '{\n  "flutter": "3.47.9"\n}\n',
        '.vscode/settings.json': '{\n  "dart.flutterSdkPath": ".fvm/versions/3.47.9"\n}\n',
      },
    })
  })

  test('without .vscode/settings.json, and in a Dart project without the Dart versions', () => {
    const result = applyFlutter({ from: '3.47.8', to: '3.47.9', releases: [], pubspec: 'name: app\n', lock: '', fvmrc: '{"flutter": "3.47.8"}' })
    expect(result.flutter).toEqual({ from: '3.47.8', to: '3.47.9', tool: 'dart', files: { '.fvmrc': '{"flutter": "3.47.9"}' } })
    expect(result.files.pubspec).toBe('name: app\n')
  })
})
