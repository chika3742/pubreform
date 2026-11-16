// A fake fvm and fake Flutter SDKs for the local E2E of Flutter updates.
// pub is still the real `dart pub`: fvm runs it with FLUTTER_ROOT at the fake SDK of the version in .fvmrc.
// pub reads the Flutter version from bin/cache/flutter.version.json, and `sdk: flutter` packages from packages/.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type Fixtures, type FlutterFixtureRelease, startFixtureServer } from './fixtures.ts'

const run = promisify(execFile)

/** A fake SDK: the Dart it reports, and what its package fx_sdk_pkg pins. */
export interface FakeSdk {
  dart: string
  pins: Record<string, string>
}

export interface FakeFlutter {
  /** The directory with `fvm`, to put first on PATH. */
  bin: string
  /** The root of the fake SDK of a version. */
  root(version: string): string
  addSdk(version: string, sdk: FakeSdk): void
  /** `<version in .fvmrc> <arguments>` of each call. */
  calls(): string[]
}

/** Writes the fake fvm and SDKs under `dir`. */
export function makeFakeFlutter(dir: string, sdks: Record<string, FakeSdk>): FakeFlutter {
  const bin = path.join(dir, 'bin')
  const sdksDir = path.join(dir, 'sdks')
  const log = path.join(dir, 'fvm.log')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(log, '')
  const root = (version: string) => path.join(sdksDir, version)
  const addSdk = (version: string, sdk: FakeSdk) => {
    const r = root(version)
    fs.mkdirSync(path.join(r, 'bin', 'cache', 'dart-sdk'), { recursive: true })
    fs.writeFileSync(path.join(r, 'bin', 'cache', 'flutter.version.json'), JSON.stringify({ flutterVersion: version }))
    fs.writeFileSync(path.join(r, 'bin', 'cache', 'dart-sdk', 'version'), `${sdk.dart}\n`)
    const pkg = path.join(r, 'packages', 'fx_sdk_pkg')
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
    const deps = Object.entries(sdk.pins).map(([name, v]) => `  ${name}: ${v}\n`)
    fs.writeFileSync(
      path.join(pkg, 'pubspec.yaml'),
      `name: fx_sdk_pkg\nversion: 0.0.0\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n${deps.join('')}`,
    )
    fs.writeFileSync(path.join(pkg, 'lib', 'fx_sdk_pkg.dart'), `const flutter = '${version}';\n`)
  }
  for (const [version, sdk] of Object.entries(sdks)) addSdk(version, sdk)
  // As fvm: the version of .fvmrc in the current directory. `fvm flutter pub` and `fvm dart pub` run `dart pub`.
  fs.writeFileSync(
    path.join(bin, 'fvm'),
    `#!/bin/sh
version=$(sed -n 's/.*"flutter" *: *"\\([^"]*\\)".*/\\1/p' .fvmrc | head -n 1)
echo "$version $*" >> '${log}'
FLUTTER_ROOT='${sdksDir}'/$version
export FLUTTER_ROOT
if [ ! -f "$FLUTTER_ROOT/bin/cache/flutter.version.json" ]; then echo "Flutter $version is not installed" >&2; exit 1; fi
if [ "$1 $2 $3" = "flutter --version --machine" ]; then
  printf '{"frameworkVersion":"%s","dartSdkVersion":"%s","flutterRoot":"%s"}\\n' "$version" "$(cat "$FLUTTER_ROOT/bin/cache/dart-sdk/version")" "$FLUTTER_ROOT"
  exit 0
fi
shift
exec dart "$@"
`,
    { mode: 0o755 },
  )
  return {
    bin,
    root,
    addSdk,
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
  }
}

/** Packages of the Flutter E2E. Every package starts locked at 1.0.0. */
export function flutterFixtures(): Fixtures {
  const base = { version: '1.0.0', daysAgo: 60 }
  return {
    // Pinned by the SDK package: 1.0.0 by Flutter 3.47.7, 1.1.0 by 3.50.0.
    fx_pin: [base, { version: '1.1.0', daysAgo: 30 }],
    fx_pin2: [base, { version: '1.1.0', daysAgo: 30 }],
    // Pinned to 1.0.0 in the project; 1.1.0 needs the pin of the new Flutter.
    fx_user: [
      { ...base, dependencies: { fx_pin: '1.0.0' } },
      { version: '1.1.0', daysAgo: 30, dependencies: { fx_pin: '1.1.0' } },
    ],
    // ">=1.0.0 <1.1.0" in the project; 1.1.0 needs the pin of the new Flutter.
    fx_range: [
      { ...base, dependencies: { fx_pin2: '1.0.0' } },
      { version: '1.1.0', daysAgo: 30, dependencies: { fx_pin2: '1.1.0' } },
    ],
  }
}

/** The SDKs of the Flutter E2E. The Dart versions must not be newer than the Dart that runs pub. */
export const FLUTTER_SDKS: Record<string, FakeSdk> = {
  '3.47.7': { dart: '3.9.0', pins: { fx_pin: '1.0.0', fx_pin2: '1.0.0' } },
  '3.50.0': { dart: '3.10.0', pins: { fx_pin: '1.1.0', fx_pin2: '1.1.0' } },
}

export const FLUTTER_RELEASES: FlutterFixtureRelease[] = [
  { version: '3.47.7', dart: '3.9.0', daysAgo: 60 },
  { version: '3.47.8', dart: '3.9.1', daysAgo: 30 },
  { version: '3.50.0', dart: '3.10.0', daysAgo: 30 },
  // Waits for the release age (min_release_age_days: 3).
  { version: '3.51.0', dart: '3.11.0', daysAgo: 1 },
  { version: '3.52.0-0.1.pre', channel: 'beta', dart: '3.12.0 (build 3.12.0-1.0.beta)', daysAgo: 1 },
]

export const FLUTTER_CHANGELOGS: Record<string, string> = {
  'flutter-3.47-candidate.0': `## Flutter 3.47 Changes

### [3.47.8](https://github.com/flutter/flutter/releases/tag/3.47.8)
- The 3.47.8 hotfix.

### [3.47.7](https://github.com/flutter/flutter/releases/tag/3.47.7)
- The 3.47.7 hotfix.
`,
  'flutter-3.50-candidate.0': `## Flutter 3.50 Changes

### [3.50.0](https://github.com/flutter/flutter/releases/tag/3.50.0)
- The 3.50 release.

## Flutter 3.47 Changes

### [3.47.7](https://github.com/flutter/flutter/releases/tag/3.47.7)
- The 3.47.7 hotfix.
`,
}

export const FLUTTER_CONFIG = `# Generated by pubreform test/e2e/fake-flutter.ts.
schedule:
  cron: "* * * * *"
min_release_age_days: 3
`

export const FVMRC = `{
  "flutter": "3.47.7",
  "flavors": {
    "next": "3.50.0"
  }
}
`

export const VSCODE_SETTINGS = `{
  // Written by fvm.
  "dart.flutterSdkPath": ".fvm/versions/3.47.7",
  "editor.formatOnSave": true,
}
`

export function flutterPubspec(flutter = '3.47.7'): string {
  return `# Generated by pubreform test/e2e/fake-flutter.ts.
name: pubreform_flutter_e2e
publish_to: none
environment:
  sdk: ^3.0.0
  flutter: ${flutter} # the SDK in .fvmrc
dependencies:
  fx_sdk_pkg:
    sdk: flutter
  fx_user: 1.0.0
  fx_range: ">=1.0.0 <1.1.0"
`
}

/** The files of the project, with the lockfile resolved by the fake Flutter 3.47.7 against a fixture registry. */
export async function makeFlutterProject(fake: FakeFlutter, config = FLUTTER_CONFIG): Promise<Record<string, string>> {
  const registry = await startFixtureServer({ fixtures: flutterFixtures() })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pubreform-flutter-project-'))
  try {
    const env = {
      ...process.env,
      PATH: `${fake.bin}:${process.env.PATH}`,
      PUB_HOSTED_URL: registry.url,
      PUB_CACHE: path.join(tmp, 'pub-cache'),
    }
    const pubspec = flutterPubspec()
    fs.writeFileSync(path.join(tmp, 'pubspec.yaml'), pubspec)
    fs.writeFileSync(path.join(tmp, '.fvmrc'), FVMRC)
    await run('fvm', ['flutter', 'pub', 'get'], { cwd: tmp, env })
    const lock = fs.readFileSync(path.join(tmp, 'pubspec.lock'), 'utf8').replaceAll(`url: "${registry.url}"`, 'url: "https://pub.dev"')
    return {
      'pubspec.yaml': pubspec,
      'pubspec.lock': lock,
      '.fvmrc': FVMRC,
      '.vscode/settings.json': VSCODE_SETTINGS,
      '.github/pubreform.yaml': config,
    }
  } finally {
    await registry.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
