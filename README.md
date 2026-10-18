# pubreform

A GitHub Action that keeps the pub dependencies of a Dart or Flutter project up to date with pull requests.

- One pull request per update, with links to the source and the changelog
- Minor and patch updates that resolve together are grouped into one pull request
- Major updates get their own pull requests
- Updates that only resolve when several packages are updated together are grouped together
- Versions that no other package's latest stable version can resolve are skipped
- Versions are used only after they have been published for a given number of days
- Pull requests are regenerated when needed, and changes are reported as comments

## Requirements

- `pubspec.yaml` and `pubspec.lock` at the repository root, with `pubspec.lock` committed
- A GitHub App installed on the repository, with these repository permissions:
  - Contents: Read and write
  - Pull requests: Read and write
- The Dart or Flutter SDK set up in the workflow. For Flutter, use [chika3742/setup-fvm](https://github.com/chika3742/setup-fvm) with `.fvmrc`

A GitHub App token is needed because pull requests created with `GITHUB_TOKEN` do not run CI until someone approves the workflow runs. Commits are created through the GitHub API, so they are shown as Verified.

## Usage

Add `.github/pubreform.yaml`:

```yaml
# $schema: https://raw.githubusercontent.com/chika3742/pubreform/v1/pubreform.schema.json
schedule:
  cron: "0 9 * * 1"
  timezone: Asia/Tokyo
min_release_age_days: 3
labels: [dependencies]
```

Add a workflow:

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

concurrency:
  group: pubreform
  cancel-in-progress: false

jobs:
  pubreform:
    # On pull_request, run only for pubreform's pull requests, and not for its own edits.
    if: >-
      github.event_name != 'pull_request' ||
      (startsWith(github.head_ref, 'pubreform/') && github.event.sender.type != 'Bot')
    runs-on: ubuntu-latest
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

The action behaves the same whatever event starts it, so the triggers above are only an example.

### Inputs

| Input | Default | Description |
|---|---|---|
| `token` | (required) | GitHub App installation token |
| `config` | `.github/pubreform.yaml` | Path to the config file, read from the default branch |

### Configuration

| Key | Default | Description |
|---|---|---|
| `schedule.cron` | (required) | Cron expression with 5 fields |
| `schedule.timezone` | `UTC` | IANA time zone name for `schedule.cron` |
| `min_release_age_days` | `0` | Only versions published at least this many days before the schedule time are used |
| `labels` | `[]` | Labels added to pull requests. Missing labels are created |
| `versioning` | `increase` | `increase` raises lower bounds in `pubspec.yaml` for minor and patch updates. `lockfile-only` changes only `pubspec.lock` for them |
| `ignore` | `[]` | Updates to skip: `{ name }` skips every update of the package, `{ name, versions }` skips the versions in a pub version constraint such as `">=3.0.0"` |

The first line of the config file above enables completion and validation in IntelliJ IDEA and VS Code (YAML extension) through [the JSON schema](pubreform.schema.json).

## How it works

### Schedule

`schedule.cron` sets when the range of target versions moves forward, not when the action runs. Each run uses the latest time the cron fired (the slot) and considers only versions published at least `min_release_age_days` before it. Every run until the next slot gives the same result, so the action can run at any time and as often as needed.

### Pull requests

| Kind | Branch | Title |
|---|---|---|
| A single package | `pubreform/single/<package>` | `Update <package> from <old> to <new>` |
| Minor and patch updates | `pubreform/minor-and-patch` | `Update <N> packages` |
| Packages that must be updated together | `pubreform/group/<package>` | `Update <N> packages` |

A group that updates only one package is titled like a single package update. Transitive dependencies are updated in `pubspec.lock` as needed but are not listed.

A pull request is regenerated on top of the latest default branch when:

- the "Rebase this PR" checkbox in its description is checked
- it conflicts with the default branch
- the update changes (for example, a newer version is released); a comment describes the change
- `pubspec.yaml`, `pubspec.lock` or `.fvmrc` changes on the default branch
- the config changes

A pull request that has commits not created by pubreform is not regenerated automatically; check the checkbox to discard them. A pull request closed without merging is not created again for the same update. When an update is no longer needed, its pull request is closed with a comment.

If an update fails, the error log is posted to its pull request, and the job fails.

## Limitations

- Only the repository root is supported. Pub workspaces are not supported yet
- Only dependencies hosted on pub.dev are updated
- Pre-release versions are not targeted
- `dependency_overrides` and the SDK constraints are not changed

## License

[MIT](LICENSE)
