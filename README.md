# pubreform

A GitHub Action that opens pull requests to update the pub dependencies of a Dart or Flutter project.

## What it does

Each run compares the dependencies in `pubspec.yaml` with pub.dev and keeps these pull requests open:

| Pull request | Title | Contents |
|---|---|---|
| Minor and patch updates | `Update minor and patch (N packages)` | All updates that fit the current version constraints, in one pull request |
| Major update | `Update <package> from <old> to <new>` | One package that needs a new constraint |
| Packages updated together | `Update <a> to <new>, <b> to <new>` | Major updates that only resolve when made together |

- A pull request that updates only one package is titled like a major update
- The description links each package to pub.dev, its source, and its changelog
- When an update changes, for example because a newer version is released, the pull request is updated and a comment describes the change. When it is no longer needed, it is closed
- Locked versions with a security advisory are updated without waiting. See [Security advisories](#security-advisories)
- The job summary lists the newer versions that are still in the waiting period, with the time they will be used, and the dependencies that cannot be updated to the latest version because it does not resolve with the other dependencies

## Setup

You need `pubspec.yaml` and a committed `pubspec.lock` at the repository root.

**1. Create a GitHub App** with these repository permissions, and install it on the repository:

- Contents: Read and write
- Pull requests: Read and write

Add its client ID as the variable `PUBREFORM_CLIENT_ID`, and a private key as the secret `PUBREFORM_PRIVATE_KEY`. An App is needed because CI does not run on pull requests created with `GITHUB_TOKEN` until someone approves it. Commits are made through the GitHub API as the App, so they are shown as Verified.

**2. Add the config** as `.github/pubreform.yaml`:

```yaml
# $schema: https://raw.githubusercontent.com/chika3742/pubreform/v1/pubreform.schema.json
schedule:
  cron: "0 9 * * 1"
  timezone: Asia/Tokyo
min_release_age_days: 3
labels: [dependencies]
```

To regenerate code such as build_runner outputs in the pull requests, add [post-update commands](#post-update-commands).

**3. Add the workflow**, for example as `.github/workflows/pubreform.yml`:

```yaml
name: pubreform

on:
  schedule:
    - cron: "0 9 * * 1"
      timezone: Asia/Tokyo
  push:
    branches: [main]
    paths: [pubspec.yaml, pubspec.lock, .fvmrc, .github/pubreform.yaml]
  pull_request:
    types: [edited]
  workflow_dispatch:

jobs:
  pubreform:
    # On pull_request, run only for pubreform's pull requests, and not for its own edits.
    if: >-
      github.event_name != 'pull_request' ||
      (startsWith(github.head_ref, 'pubreform/') && github.event.sender.type != 'Bot')
    runs-on: ubuntu-latest
    concurrency: # Set at job level so a pending job isn't canceled when the job is skipped
      group: pubreform
      cancel-in-progress: false
    steps:
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.PUBREFORM_CLIENT_ID }}
          private-key: ${{ secrets.PUBREFORM_PRIVATE_KEY }}
      - uses: actions/checkout@v7
      - uses: chika3742/setup-fvm@v3 # For Dart only projects, use dart-lang/setup-dart@v1
      - uses: chika3742/pubreform@v1
        with:
          token: ${{ steps.app-token.outputs.token }}
```

The workflow decides when the action runs. This one runs it every Monday, after the dependency files or the config change, and when a pubreform pull request is edited (to pick up the checkbox below). The action does the same thing whichever event starts it.

## Configuration

| Key | Default | Description |
|---|---|---|
| `schedule.cron` | (required) | Cron expression with 5 fields. See [Waiting period](#waiting-period) |
| `schedule.timezone` | `UTC` | IANA time zone name for `schedule.cron` |
| `min_release_age_days` | `0` | Days a version must have been out before it is used |
| `labels` | `[]` | Labels added to the pull requests. Missing labels are created |
| `versioning` | `increase` | `increase` also raises the lower bounds in `pubspec.yaml` for minor and patch updates. `lockfile-only` changes only `pubspec.lock` for them |
| `ignore` | `[]` | Updates to skip. `{ name }` skips the package, `{ name, versions }` skips the versions in a constraint such as `">=3.0.0"` |
| `post_update` | `[]` | Commands to run before each pull request is committed, such as code generation. See [Post-update commands](#post-update-commands) |
| `post_update[].run` | (required) | The command, run with `sh -c` at the repository root |
| `post_update[].network` | `false` | Whether the command can use the network |
| `post_update[].env` | `[]` | Names of more environment variables to pass, with their values from the workflow. Names starting with `INPUT_` or `ACTIONS_` are not allowed. The values can reach the pull request, through files the command writes or through the output in an error comment, so take care with secrets |

The action has two inputs: `token` (required), and `config`, the path to the config file on the default branch (default `.github/pubreform.yaml`).

## Things to know

### Waiting period

`schedule.cron` is not when the action runs. It sets the time from which the waiting period is counted: a run uses only versions published at least `min_release_age_days` days before the latest time the cron fired. Running the action more often does not change the result until the cron fires again.

### Updating a pull request

Check "Rebase this PR" in the description to rebuild a pull request on the latest default branch. pubreform also does this by itself when the pull request conflicts, when `pubspec.yaml`, `pubspec.lock`, `.fvmrc` or the config change on the default branch, or when the update changes.

- If you push commits to a pubreform branch, pubreform stops updating that pull request and leaves a comment. Check the box to discard your commits
- A pull request you close without merging is not opened again for the same versions
- If an update fails, the error is posted to its pull request, and the job fails
- Branches are named `pubreform/...`. Transitive dependencies are updated in `pubspec.lock` as needed, but are not listed, except those that fix a security advisory

### Security advisories

pubreform reads the security advisories that pub.dev reports (from the GitHub Advisory Database) for every package locked in `pubspec.lock`, direct or transitive. When a locked version is affected, pubreform updates it to a version that is not:

- The pull request that fixes it is titled with `[Security] `, for example `[Security] Update archive from 3.3.7 to 3.3.8`, and its description starts with a table of the advisories. A fixed transitive dependency is listed in the table of packages as `transitive`
- The waiting period is skipped only for one version: the oldest stable version that is newer than the locked one and is not affected, retracted or covered by `ignore`. Its release date is shown in the table. The other versions, including the dependencies of that version, still wait. The affected versions of that package are not used
- A fix that fits the current constraints goes into the minor and patch pull request, even if no direct dependency changes. Otherwise it is a major update. A transitive dependency is fixed only when the packages that depend on it allow the fixed version
- To skip an advisory, list its ID (or one of its aliases, such as a CVE) in `ignored_advisories` in `pubspec.yaml`, as for `dart pub`. Versions that an `ignore` rule in the config covers are never used: the oldest fix that it does not cover is used instead. The feature itself cannot be turned off
- The job summary lists each affected package and whether a pull request fixes it
- If the advisories cannot be read from pub.dev, the run fails without changing anything

```yaml
# pubspec.yaml
ignored_advisories:
  - GHSA-xxxx-xxxx-xxxx
```

Advisories are published at any time, not on the schedule. To get the fix soon, run the workflow every day and keep `schedule.cron` weekly: on days without new advisories, nothing changes.

```yaml
on:
  schedule:
    - cron: "0 9 * * *"   # the workflow: every day
```

```yaml
# .github/pubreform.yaml
schedule:
  cron: "0 9 * * 1"       # new releases: once a week
```

### Post-update commands

When pubreform creates or rebuilds a pull request, it can first run commands on the updated project, and commit the files they change (except files ignored by `.gitignore`) together with `pubspec.yaml` and `pubspec.lock`:

```yaml
post_update:
  - run: dart run build_runner build
  - run: ./tool/generate_api.sh
    network: true
    env: [API_SPEC_URL]
```

- Linux runners only, such as `ubuntu-latest`, where the runner user can use `docker` and `/bin` links to `/usr/bin` (merged `/usr`). Nothing is pulled: pubreform builds a small image from the runner's own files
- The commands run code from your dependencies, so pubreform runs each one in a new container that has only a copy of the repository without `.git` (writable), and the runner's `/usr`, the SDK and the pub cache (read-only). It cannot see the tokens, the runner's processes or the other files of the runner, gets only a few environment variables (`PATH`, `HOME`, `PUB_CACHE`, `LANG`, `LC_ALL`, `CI`, `FLUTTER_ROOT`, and those in `env`), and has no network unless `network: true`. Dependencies are already fetched, so `dart run` works without the network. Do not run `dart pub get` in the commands: it fails, even with `network: true`, because the pub cache is read-only. Tools installed under your home directory are not available
- In Flutter projects (and projects with `.fvmrc`), `dart` is the Dart bundled with the Flutter SDK, so `dart run build_runner build` works, but `flutter` commands such as `flutter gen-l10n` do not: the `flutter` command writes to the SDK, which is read-only
- Bring the generated code on the default branch up to date first. Otherwise, the changes that are already due on the default branch show up in every pull request
- The commands run only when a pull request is created or rebuilt, once per pull request. Changing `post_update` rebuilds every pull request
- If a command fails, the pull request is not created, or is left as it is with the error posted to it, and the job fails

## Limitations

- Only the repository root. Pub workspaces are not supported yet
- Only packages hosted on pub.dev
- No pre-release versions
- `dependency_overrides` and the SDK constraints are not changed

## License

[MIT](LICENSE)
