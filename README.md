# pubreform

A GitHub Action that opens pull requests to update the pub dependencies of a Dart or Flutter project.

pub itself chooses the versions, so each pull request contains only versions that resolve together. New releases are used only after they have been out for a few days.

## What you get

Each run compares the dependencies in `pubspec.yaml` with pub.dev and keeps these pull requests open:

| Pull request | Title | Contents |
|---|---|---|
| Minor and patch updates | `Update minor and patch (N packages)` | All updates that fit the current version constraints, in one pull request |
| Major update | `Update <package> from <old> to <new>` | One package that needs a new constraint |
| Packages updated together | `Update <a> to <new>, <b> to <new>` | Major updates that only resolve when made together |

- A pull request that updates only one package is titled like a major update
- The description links each package to pub.dev, its source, and its changelog
- When an update changes, for example because a newer version is released, the pull request is updated and a comment describes the change. When it is no longer needed, it is closed
- Updates that do not resolve with the other dependencies are skipped and listed in the job summary

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

The `# $schema:` line enables completion and validation in IntelliJ IDEA and in VS Code with the YAML extension.

The action has two inputs: `token` (required), and `config`, the path to the config file on the default branch (default `.github/pubreform.yaml`).

## Things to know

### Waiting period

`schedule.cron` is not when the action runs. It sets the time from which the waiting period is counted: a run uses only versions published at least `min_release_age_days` days before the latest time the cron fired. Running the action more often does not change the result until the cron fires again.

### Updating a pull request

Check "Rebase this PR" in the description to rebuild a pull request on the latest default branch. pubreform also does this by itself when the pull request conflicts, when `pubspec.yaml`, `pubspec.lock`, `.fvmrc` or the config change on the default branch, or when the update changes.

- If you push commits to a pubreform branch, pubreform stops updating that pull request and leaves a comment. Check the box to discard your commits
- A pull request you close without merging is not opened again for the same versions
- If an update fails, the error is posted to its pull request, and the job fails
- Branches are named `pubreform/...`. Transitive dependencies are updated in `pubspec.lock` as needed, but are not listed

## Limitations

- Only the repository root. Pub workspaces are not supported yet
- Only packages hosted on pub.dev
- No pre-release versions
- `dependency_overrides` and the SDK constraints are not changed
- Security advisories do not shorten the waiting period

## License

[MIT](LICENSE)
