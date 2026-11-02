// Fake fvm for the local E2E. Flutter SDKs are fake directories under FAKE_FLUTTER_SDKS (writeFakeFlutterSdk), which
// only pub reads: `fvm dart …` and `fvm flutter pub …` run the real `dart` on PATH with FLUTTER_ROOT set to the SDK of
// .fvmrc in the current directory, as the Flutter SDK's launcher does. Every call is appended to FAKE_FVM_LOG.
import fs from 'node:fs'
import path from 'node:path'

const SCRIPT = `#!/bin/sh
echo "$*" >> "$FAKE_FVM_LOG"
if [ "$1" = install ]; then
  if [ -d "$FAKE_FLUTTER_SDKS/$2" ]; then echo "Installed $2"; exit 0; fi
  # As fvm, with a timing that changes on every run.
  echo "Failed to install $2 ($(date +%s%N)s)" >&2
  exit 1
fi
version=$(sed -n 's/.*"flutter"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' .fvmrc | head -n 1)
root="$FAKE_FLUTTER_SDKS/$version"
if [ -z "$version" ] || [ ! -d "$root" ]; then echo "Flutter SDK $version is not installed" >&2; exit 1; fi
export FLUTTER_ROOT="$root"
tool=$1
shift
if [ "$tool" = flutter ] && [ "$1" = --version ]; then
  printf '{"frameworkVersion": "%s", "flutterRoot": "%s"}\\n' "$version" "$root"
  exit 0
fi
# The test projects depend on no Flutter SDK package, so flutter pub is dart pub.
exec dart "$@"
`

/** Writes the fake fvm as `<dir>/fvm`. */
export function installFakeFvm(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'fvm'), SCRIPT, { mode: 0o755 })
}
