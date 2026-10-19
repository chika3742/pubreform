// Running the post_update commands as a separate user, and collecting the files that they change.
// The commands run code from the dependencies, so they get neither the tokens nor write access to
// anything that pubreform runs or trusts later (the SDK, the pub cache, the base clone and its .git).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import type { UnitResult } from './applier.ts'
import type { PostUpdate } from './config.ts'
import { Pub, pubCacheDir, pubCommand } from './pub.ts'

export const RUN_USER = 'pubreform-run'

/** Where the generation directories are made. Not RUNNER_TEMP: it is under the runner's home. */
const TMP = '/tmp'

/** Variables passed to the commands when pubreform has them, besides HOME and PUB_CACHE. */
const PASSED_ENV = ['PATH', 'LANG', 'LC_ALL', 'CI', 'FVM_CACHE_PATH', 'FLUTTER_ROOT']

/** The files that the update itself writes, from the result of the update. */
const UPDATE_FILES = new Set(['pubspec.yaml', 'pubspec.lock'])

const OUTPUT_TAIL_LINES = 100

/** A post_update command that exited with a non-zero code. */
export class PostUpdateError extends Error {
  override name = 'PostUpdateError'

  constructor(
    message: string,
    readonly run: string,
    readonly exitCode: number,
  ) {
    super(message)
  }

  /** What identifies the failure, without the output: tools that print timings change it on every run. */
  get key(): string {
    return `${this.run}\0${this.exitCode}`
  }
}

export type FileMode = '100644' | '100755' | '120000'

/** A change to the tree of the commit, besides pubspec.yaml and pubspec.lock. */
export type TreeEntry =
  | { path: string; mode: FileMode; content: string }
  /** Not valid UTF-8, or contains NUL: sent as a blob. */
  | { path: string; mode: FileMode; base64: string }
  | { path: string; deleted: true }

export interface StatusEntry {
  path: string
  deleted: boolean
}

/** Parses `git status --porcelain=v1 -z --no-renames`. */
export function parseStatus(output: string): StatusEntry[] {
  return output
    .split('\0')
    .filter((record) => record.length > 3)
    .map((record) => {
      const xy = record.slice(0, 2)
      return { path: record.slice(3), deleted: xy.includes('D') }
    })
}

/** Whether the path stays inside the work tree. */
export function isInside(p: string): boolean {
  if (p === '' || path.posix.isAbsolute(p)) return false
  const segments = p.split('/')
  return segments.every((s) => s !== '' && s !== '.' && s !== '..')
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function asText(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined
  try {
    return utf8.decode(data)
  } catch {
    return undefined
  }
}

/** Whether a directory between the root and the path is a symbolic link (or not a directory). */
function throughLink(root: string, p: string): boolean {
  const segments = p.split('/').slice(0, -1)
  let dir = root
  for (const s of segments) {
    dir = path.join(dir, s)
    let st: fs.Stats
    try {
      st = fs.lstatSync(dir)
    } catch {
      return true
    }
    if (!st.isDirectory()) return true
  }
  return false
}

/**
 * Turns the changed paths in `dir` into tree entries. The contents are untrusted: paths outside the tree are dropped,
 * and links are committed as links instead of being followed.
 */
export function treeEntries(dir: string, changes: StatusEntry[]): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const change of changes) {
    const p = change.path
    if (!isInside(p) || UPDATE_FILES.has(p)) continue
    if (change.deleted) {
      entries.push({ path: p, deleted: true })
      continue
    }
    if (throughLink(dir, p)) continue
    const file = path.join(dir, p)
    let st: fs.Stats
    try {
      st = fs.lstatSync(file)
    } catch {
      continue
    }
    let mode: FileMode
    let data: Buffer
    if (st.isSymbolicLink()) {
      mode = '120000'
      data = fs.readlinkSync(file, { encoding: 'buffer' })
    } else if (st.isFile()) {
      mode = st.mode & 0o100 ? '100755' : '100644'
      data = fs.readFileSync(file)
    } else {
      // A directory: a nested repository, or a directory that git lists as a whole.
      continue
    }
    const text = asText(data)
    entries.push(text === undefined ? { path: p, mode, base64: data.toString('base64') } : { path: p, mode, content: text })
  }
  return entries
}

/** The environment of a command: only the listed variables that pubreform has, with HOME and PUB_CACHE set. */
export function commandEnv(
  source: Record<string, string | undefined>,
  opts: { home: string; pubCache: string; extra: string[] },
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...opts.extra, ...PASSED_ENV]) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  // The defaults win over the names in `env`.
  env.HOME = opts.home
  env.PUB_CACHE = opts.pubCache
  return env
}

/** The arguments of `sudo` that run a command as the separate user, without the network unless it is allowed. */
export function sudoArgs(command: PostUpdate, env: Record<string, string>): string[] {
  return [
    '-n',
    ...(command.network ? [] : ['unshare', '--net', '--']),
    'runuser',
    '-u',
    RUN_USER,
    '--',
    'env',
    '-i',
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    'sh',
    '-c',
    command.run,
  ]
}

/** Runs a trusted command quietly. Throws with its output when it fails. */
async function run(cmd: string, args: string[], opts: exec.ExecOptions = {}): Promise<exec.ExecOutput> {
  const result = await exec.getExecOutput(cmd, args, { silent: true, ignoreReturnCode: true, ...opts })
  if (result.exitCode !== 0) {
    throw new Error(`${[cmd, ...args].join(' ')} failed with exit code ${result.exitCode}\n${result.stderr.trimEnd()}`)
  }
  return result
}

/** sudo gets only PATH: nothing else of pubreform's environment needs to reach the commands. */
const sudoEnv = () => ({ PATH: process.env.PATH ?? '' })

const sudo = (args: string[]) => run('sudo', ['-n', ...args], { env: sudoEnv() })

const succeeds = (p: Promise<unknown>): Promise<boolean> =>
  p.then(
    () => true,
    () => false,
  )

/** Checks that the commands can run on this runner. Throws when they cannot. */
export async function checkEnvironment(): Promise<void> {
  const problem = 'post_update needs a Linux runner with password-less sudo, unshare and runuser'
  if (process.platform !== 'linux') throw new Error(`${problem}; this runner is ${process.platform}`)
  if (!(await succeeds(sudo(['true'])))) throw new Error(`${problem}; sudo -n true failed`)
  if (!(await succeeds(run('sh', ['-c', 'command -v unshare && command -v runuser'])))) {
    throw new Error(`${problem}; unshare or runuser is not found`)
  }
}

/** Finds a command on PATH, through links. */
function which(name: string, PATH = process.env.PATH ?? ''): string | undefined {
  for (const dir of PATH.split(':').filter(Boolean)) {
    const file = path.join(dir, name)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return fs.realpathSync(file)
    } catch {}
  }
  return undefined
}

export interface GeneratorOptions {
  /** The base clone, with the trusted .git. */
  baseDir: string
  commands: PostUpdate[]
  flutter: boolean
  fvm: boolean
  /** URL of the registry proxy, written to the lockfile so that `pub get --offline` uses the cached packages. */
  hostedUrl: string
}

export class Generator {
  private prepared?: Promise<void>

  constructor(private readonly options: GeneratorOptions) {}

  /** Creates the user, and lets it read (not write) the SDK and the pub cache. Once per run. */
  private prepare(): Promise<void> {
    this.prepared ??= (async () => {
      if (!(await succeeds(run('id', ['-u', RUN_USER])))) {
        await sudo(['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', RUN_USER])
      }
      const [tool] = pubCommand(this.options.flutter, this.options.fvm)
      const readable = new Set<string>([pubCacheDir()])
      const binary = which(tool!)
      // <sdk>/bin/<tool>
      if (binary) readable.add(path.dirname(path.dirname(binary)))
      for (const name of ['FVM_CACHE_PATH', 'FLUTTER_ROOT']) if (process.env[name]) readable.add(process.env[name]!)
      for (const p of readable) if (fs.existsSync(p)) await grantRead(p)
    })()
    return this.prepared
  }

  /** Runs the commands on the result of the update, and returns the files that they changed. */
  async generate(result: UnitResult): Promise<TreeEntry[]> {
    await this.prepare()
    const { baseDir } = this.options
    const dir = await fsp.mkdtemp(path.join(TMP, 'pubreform-gen-'))
    const home = await fsp.mkdtemp(path.join(TMP, 'pubreform-home-'))
    try {
      // The tracked files of the base, without .git: git would run the hooks and the config that the commands wrote.
      const gitDir = path.join(baseDir, '.git')
      await run('git', ['--git-dir', gitDir, '--work-tree', baseDir, 'checkout-index', '--all', `--prefix=${dir}/`])
      // As the runner's user, through the stopped proxy's URL: every package is in the cache.
      const pub = new Pub({ dir, flutter: this.options.flutter, fvm: this.options.fvm, hostedUrl: this.options.hostedUrl })
      await pub.run(['get', '--offline'], result.files)

      await sudo(['chown', '-R', `${RUN_USER}:`, dir, home])
      try {
        for (const command of this.options.commands) await this.runCommand(command, dir, home)
      } finally {
        // Processes left in the background must not touch the files from here on, or the next unit.
        await exec.exec('sudo', ['-n', 'pkill', '-KILL', '-u', RUN_USER], {
          env: sudoEnv(),
          silent: true,
          ignoreReturnCode: true,
        })
        await sudo(['chown', '-R', `${process.getuid!()}:${process.getgid!()}`, dir])
      }
      return treeEntries(dir, await changedFiles(baseDir, dir))
    } finally {
      await sudo(['rm', '-rf', dir, home])
    }
  }

  private async runCommand(command: PostUpdate, dir: string, home: string) {
    const env = commandEnv(process.env, { home, pubCache: pubCacheDir(), extra: command.env })
    const lines: string[] = []
    let partial = ''
    const collect = (data: Buffer) => {
      process.stdout.write(data)
      const parts = (partial + data.toString('utf8')).split('\n')
      partial = parts.pop()!
      lines.push(...parts)
      if (lines.length > OUTPUT_TAIL_LINES) lines.splice(0, lines.length - OUTPUT_TAIL_LINES)
    }
    // The command line is not logged: it has the values of the variables.
    const exitCode = await core.group(`Post update: ${command.run}`, () =>
      exec.exec('sudo', sudoArgs(command, env), {
        cwd: dir,
        env: sudoEnv(),
        silent: true,
        ignoreReturnCode: true,
        listeners: { stdout: collect, stderr: collect },
      }),
    )
    if (partial) lines.push(partial)
    if (exitCode !== 0) {
      throw new PostUpdateError(
        `post_update command failed with exit code ${exitCode}: ${command.run}\n${lines.slice(-OUTPUT_TAIL_LINES).join('\n')}`,
        command.run,
        exitCode,
      )
    }
  }
}

/** Lets the user read and traverse `p`, and traverse the directories above it. Never gives write access. */
async function grantRead(p: string) {
  const canRead = (target: string, test: string) => succeeds(sudo(['runuser', '-u', RUN_USER, '--', 'test', test, target]))
  if ((await canRead(p, '-r')) && (await canRead(p, '-x'))) return
  const ancestors: string[] = []
  for (let dir = path.dirname(p); dir !== path.dirname(dir); dir = path.dirname(dir)) ancestors.unshift(dir)
  for (const dir of ancestors) {
    if (!(await canRead(dir, '-x'))) await sudo(['setfacl', '-m', `u:${RUN_USER}:x`, dir])
  }
  await sudo(['setfacl', '-R', '-m', `u:${RUN_USER}:rX`, p])
}

/**
 * The files changed in `dir`, by the trusted .git of the base, with a copy of its index.
 * Untracked files are included and .gitignore is followed. The config is the base's, so no filter that the work tree
 * asks for in .gitattributes runs unless the base already configures it.
 */
async function changedFiles(baseDir: string, dir: string): Promise<StatusEntry[]> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pubreform-index-'))
  try {
    const index = path.join(tmp, 'index')
    await fsp.copyFile(path.join(baseDir, '.git', 'index'), index)
    const { stdout } = await exec.getExecOutput(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'status.relativePaths=false',
        '--git-dir',
        path.join(baseDir, '.git'),
        '--work-tree',
        dir,
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--no-renames',
        '--ignore-submodules=all',
      ],
      { cwd: dir, env: { ...(process.env as Record<string, string>), GIT_INDEX_FILE: index }, silent: true },
    )
    return parseStatus(stdout)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
}
