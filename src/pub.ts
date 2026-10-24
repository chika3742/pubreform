// Running pub in the working directory.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { PUB_DEV, type Pubspecs } from './pubspec.ts'

export interface PubFiles {
  pubspecs: Pubspecs
  lock: string
}

export interface PubOptions {
  /** Working directory with the base checkout. */
  dir: string
  flutter: boolean
  /** Whether to run through fvm (the base has .fvmrc). */
  fvm: boolean
  /** URL of the registry proxy. */
  hostedUrl: string
  env?: Record<string, string>
}

export class PubError extends Error {
  override name = 'PubError'
}

const NO_EXAMPLE = new Set(['get', 'upgrade'])

export function pubCommand(flutter: boolean, fvm: boolean): string[] {
  const tool = flutter ? 'flutter' : 'dart'
  return fvm ? ['fvm', tool, 'pub'] : [tool, 'pub']
}

/** The lockfile line that pub writes for pub.dev, and the one it writes for `url`. */
function urlLine(url: string): string {
  return `url: "${url}"`
}

export class Pub {
  constructor(private readonly options: PubOptions) {}

  /**
   * Writes the files, runs `pub <args>` through the proxy, and returns the resulting files.
   * An empty `lock` means no lockfile. The lockfile URLs are rewritten to the proxy while pub runs, so that pub keeps the locked versions.
   */
  async run(args: string[], files: PubFiles): Promise<PubFiles> {
    const { dir, hostedUrl } = this.options
    const lockPath = path.join(dir, 'pubspec.lock')
    for (const [p, text] of Object.entries(files.pubspecs)) await fs.writeFile(path.join(dir, p), text)
    if (files.lock === '') {
      await fs.rm(lockPath, { force: true })
    } else {
      await fs.writeFile(lockPath, files.lock.replaceAll(urlLine(PUB_DEV), urlLine(hostedUrl)))
    }

    const [cmd, ...cmdArgs] = pubCommand(this.options.flutter, this.options.fvm)
    const fullArgs = [...cmdArgs, ...args]
    if (args[0] && NO_EXAMPLE.has(args[0])) fullArgs.push('--no-example')
    const result = await exec.getExecOutput(cmd!, fullArgs, {
      cwd: dir,
      env: { ...(process.env as Record<string, string>), ...this.options.env, PUB_HOSTED_URL: hostedUrl },
      ignoreReturnCode: true,
    })
    if (result.exitCode !== 0) {
      throw new PubError(
        `${[cmd, ...fullArgs].join(' ')} failed with exit code ${result.exitCode}\n${result.stderr.trimEnd()}`,
      )
    }

    const pubspecs: Pubspecs = {}
    for (const p of Object.keys(files.pubspecs)) pubspecs[p] = await fs.readFile(path.join(dir, p), 'utf8')
    return {
      pubspecs,
      lock: (await fs.readFile(lockPath, 'utf8')).replaceAll(urlLine(hostedUrl), urlLine(PUB_DEV)),
    }
  }
}

/** The pubspec.yaml paths of the workspace members, from the root of `dir`, with the root's. */
export async function workspacePubspecs(dir: string, fvm: boolean): Promise<string[]> {
  // dart, not flutter: the root pubspec.yaml does not tell whether a member uses Flutter.
  const [cmd, ...args] = pubCommand(false, fvm)
  const { stdout } = await exec.getExecOutput(cmd!, [...args, 'workspace', 'list', '--json'], { cwd: dir })
  // fvm may print before the JSON.
  const packages = (JSON.parse(stdout.slice(stdout.indexOf('{'))) as { packages?: { path?: unknown }[] }).packages
  if (!Array.isArray(packages)) throw new Error(`unexpected output of pub workspace list: ${stdout}`)
  const root = await fs.realpath(dir)
  const result: string[] = []
  for (const p of packages) {
    if (typeof p.path !== 'string') throw new Error(`unexpected output of pub workspace list: ${stdout}`)
    const relative = path.relative(root, await fs.realpath(p.path))
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`workspace member outside the repository: ${p.path}`)
    }
    result.push(path.posix.join(...relative.split(path.sep), 'pubspec.yaml'))
  }
  return result
}

/** The pub cache that pub uses, also when PUB_CACHE is not set. */
export function pubCacheDir(env = process.env): string {
  return env.PUB_CACHE || path.join(os.homedir(), '.pub-cache')
}

/** Where pub extracts a package fetched through the proxy. */
export function cachedPackageDir(hostedUrl: string, name: string, version: string, env = process.env): string {
  const cache = pubCacheDir(env)
  const host = new URL(hostedUrl)
  // pub escapes ':' in the host directory name as %58.
  const hostDir = host.port ? `${host.hostname === '127.0.0.1' ? 'localhost' : host.hostname}%58${host.port}` : host.hostname
  return path.join(cache, 'hosted', hostDir, `${name}-${version}`)
}

/** Shallow-clones the base branch without putting the token in the URL. */
export async function cloneBase(opts: {
  serverUrl: string
  repository: string
  branch: string
  token: string
  dir: string
}): Promise<string> {
  await fs.rm(opts.dir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(opts.dir), { recursive: true })
  const auth = Buffer.from(`x-access-token:${opts.token}`).toString('base64')
  // The command line is logged, so mask the encoded token as well.
  core.setSecret(auth)
  await exec.exec('git', [
    '-c',
    `http.extraheader=AUTHORIZATION: basic ${auth}`,
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--branch',
    opts.branch,
    `${opts.serverUrl}/${opts.repository}.git`,
    opts.dir,
  ])
  const { stdout } = await exec.getExecOutput('git', ['rev-parse', 'HEAD'], { cwd: opts.dir, silent: true })
  return stdout.trim()
}
