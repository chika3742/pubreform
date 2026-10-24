// Running the post_update commands in a Docker container, and collecting the files that they change.
// The commands run code from the dependencies, so the container gets neither the tokens nor write access to
// anything that pubreform runs or trusts later (the SDK, the pub cache, the base clone and its .git).
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import type { UnitResult } from './applier.ts'
import type { PostUpdate } from './config.ts'
import { Pub } from './pub.ts'

/** Where the generation directories are made. */
const TMP = '/tmp'

/** HOME in the container: writable, and removed with the container. */
const CONTAINER_HOME = '/tmp'

/** Variables passed to the commands when pubreform has them, besides the defaults. */
const PASSED_ENV = ['LANG', 'LC_ALL', 'CI']

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

/** A change to the tree of the commit, besides the files that the update itself writes. */
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
 * and links are committed as links instead of being followed. `updated` are the files that the update itself writes,
 * which come from the result of the update instead.
 */
export function treeEntries(dir: string, changes: StatusEntry[], updated: Set<string>): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const change of changes) {
    const p = change.path
    if (!isInside(p) || updated.has(p)) continue
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

/** Where the commands find the SDK. */
export interface Sdk {
  /** Mounted read-only at the same path. */
  root: string
  /** For a Flutter SDK: its bundled Dart comes first on PATH, and FLUTTER_ROOT is set. */
  flutter: boolean
}

/**
 * The variables of a command, besides HOME (see dockerArgs): the defaults, the listed variables that pubreform has,
 * and the names in `env`.
 */
export function commandEnv(
  source: Record<string, string | undefined>,
  opts: { sdk: Sdk; pubCache: string; extra: string[] },
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...opts.extra, ...PASSED_ENV]) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  // The defaults win over the names in `env`.
  const PATH = source.PATH ?? ''
  if (opts.sdk.flutter) {
    // The flutter launcher writes to the SDK, which is read-only; the bundled Dart does not.
    env.PATH = [path.join(opts.sdk.root, 'bin', 'cache', 'dart-sdk', 'bin'), PATH].filter(Boolean).join(':')
    env.FLUTTER_ROOT = opts.sdk.root
  } else {
    env.PATH = PATH
    delete env.FLUTTER_ROOT
  }
  delete env.HOME
  env.PUB_CACHE = opts.pubCache
  return env
}

export interface ContainerOptions {
  name: string
  image: string
  uid: number
  gid: number
  sdk: string
  pubCache: string
  /** The generation directory, also the working directory. */
  dir: string
  /** Names of the variables, whose values the docker process has in its environment. Not HOME. */
  envNames: string[]
}

/** The arguments of `docker run` for a command. Values of variables are not on the command line. */
export function dockerArgs(command: PostUpdate, opts: ContainerOptions): string[] {
  const mount = (p: string, mode?: 'ro') => ['-v', `${p}:${p}${mode ? `:${mode}` : ''}`]
  return [
    'run',
    '--rm',
    '--name',
    opts.name,
    '--user',
    `${opts.uid}:${opts.gid}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...(command.network ? [] : ['--network', 'none']),
    ...mount('/usr', 'ro'),
    ...mount(opts.sdk, 'ro'),
    ...mount(opts.pubCache, 'ro'),
    ...mount(opts.dir),
    '-w',
    opts.dir,
    // HOME is fixed and not secret. The docker process keeps the runner's HOME, which the docker CLI reads.
    '-e',
    `HOME=${CONTAINER_HOME}`,
    ...opts.envNames.flatMap((name) => ['-e', name]),
    opts.image,
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

const random = () => randomBytes(6).toString('hex')

/** Checks that the commands can run on this runner. Throws when they cannot. */
export async function checkEnvironment(): Promise<void> {
  const problem = 'post_update needs a Linux runner where the runner user can use docker'
  if (process.platform !== 'linux') throw new Error(`${problem}; this runner is ${process.platform}`)
  try {
    await run('docker', ['version'])
  } catch (e) {
    throw new Error(`${problem}; docker version failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Files of the runner's /etc in the image. None of them is secret. */
const ETC_FILES = [
  'passwd',
  'group',
  'nsswitch.conf',
  'ld.so.cache',
  'ld.so.conf',
  'ld.so.conf.d',
  'alternatives',
  // Not all of ssl: ssl/private holds private keys, readable only by root.
  'ssl/certs',
  'ssl/openssl.cnf',
  'ca-certificates.conf',
]

/**
 * Builds the image of the containers from the runner's files, without pulling anything:
 * a skeleton, the links of /bin and the like, and a few files of /etc. The runner's /usr is mounted when running.
 */
export async function buildImage(): Promise<string> {
  const image = `pubreform-run:${random()}`
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pubreform-image-'))
  try {
    for (const dir of ['etc', 'usr', 'tmp', 'proc', 'sys', 'dev']) await fsp.mkdir(path.join(root, dir))
    await fsp.chmod(path.join(root, 'tmp'), 0o1777)
    for (const link of ['bin', 'sbin', 'lib', 'lib64']) {
      const st = await fsp.lstat(path.join('/', link)).catch(() => undefined)
      if (st?.isSymbolicLink()) await fsp.symlink(await fsp.readlink(path.join('/', link)), path.join(root, link))
    }
    for (const file of ETC_FILES) {
      const source = path.join('/etc', file)
      if (fs.existsSync(source)) {
        const target = path.join(root, 'etc', file)
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.cp(source, target, { recursive: true, verbatimSymlinks: true })
      }
    }
    await run('sh', ['-c', 'tar --owner=0 --group=0 -C "$1" -c . | docker import - "$2"', 'sh', root, image])
    return image
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
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

/**
 * The SDK that the project uses. A Flutter project, or any project with .fvmrc (fvm installs Flutter SDKs), uses
 * the root that `flutter --version --machine` reports, run as the runner's user in `cwd`. Otherwise, the SDK of
 * `dart` on PATH (`<sdk>/bin/dart`).
 */
export async function findSdk(opts: { flutter: boolean; fvm: boolean; cwd: string }): Promise<Sdk> {
  if (opts.flutter || opts.fvm) {
    const [cmd, ...args] = [...(opts.fvm ? ['fvm'] : []), 'flutter', '--version', '--machine']
    const { stdout } = await run(cmd!, args, { cwd: opts.cwd })
    const root = (JSON.parse(stdout.slice(stdout.indexOf('{'))) as { flutterRoot?: unknown }).flutterRoot
    if (typeof root !== 'string' || root === '') throw new Error(`cannot find the Flutter SDK: ${stdout.trim()}`)
    return { root, flutter: true }
  }
  const dart = which('dart')
  if (!dart) throw new Error('cannot find the Dart SDK: dart is not on PATH')
  return { root: path.dirname(path.dirname(dart)), flutter: false }
}

export async function removeImage(image: string): Promise<void> {
  await run('docker', ['rmi', image])
}

export interface GeneratorOptions {
  /** The base clone, with the trusted .git. */
  baseDir: string
  commands: PostUpdate[]
  flutter: boolean
  fvm: boolean
  /** URL of the registry proxy, written to the lockfile so that `pub get --offline` uses the cached packages. */
  hostedUrl: string
  /** From buildImage. */
  image: string
  sdk: Sdk
  pubCache: string
}

export class Generator {
  constructor(private readonly options: GeneratorOptions) {}

  /** Runs the commands on the result of the update, and returns the files that they changed. */
  async generate(result: UnitResult): Promise<TreeEntry[]> {
    const { baseDir } = this.options
    const dir = await fsp.mkdtemp(path.join(TMP, 'pubreform-gen-'))
    try {
      // The tracked files of the base, without .git: git would run the hooks and the config that the commands wrote.
      const gitDir = path.join(baseDir, '.git')
      await run('git', ['--git-dir', gitDir, '--work-tree', baseDir, 'checkout-index', '--all', `--prefix=${dir}/`])
      // As the runner's user, outside the container, through the stopped proxy's URL: every package is in the cache.
      const pub = new Pub({ dir, flutter: this.options.flutter, fvm: this.options.fvm, hostedUrl: this.options.hostedUrl })
      await pub.run(['get', '--offline'], result.files)
      for (const command of this.options.commands) await this.runCommand(command, dir)
      const updated = new Set([...Object.keys(result.files.pubspecs), 'pubspec.lock'])
      return treeEntries(dir, await changedFiles(baseDir, dir), updated)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }

  private async runCommand(command: PostUpdate, dir: string) {
    const { image, sdk, pubCache } = this.options
    const env = commandEnv(process.env, { sdk, pubCache, extra: command.env })
    const name = `pubreform-${random()}`
    const args = dockerArgs(command, {
      name,
      image,
      uid: process.getuid!(),
      gid: process.getgid!(),
      sdk: sdk.root,
      pubCache,
      dir,
      envNames: Object.keys(env),
    })
    const lines: string[] = []
    let partial = ''
    const collect = (data: Buffer) => {
      process.stdout.write(data)
      const parts = (partial + data.toString('utf8')).split('\n')
      partial = parts.pop()!
      lines.push(...parts)
      if (lines.length > OUTPUT_TAIL_LINES) lines.splice(0, lines.length - OUTPUT_TAIL_LINES)
    }
    let exitCode: number
    try {
      exitCode = await core.group(`Post update: ${command.run}`, () =>
        exec.exec('docker', args, {
          // The runner's environment, for the docker CLI (HOME, DOCKER_*), with the values for the container.
          // Only the names given with -e reach the container.
          env: { ...(process.env as Record<string, string>), ...env },
          silent: true,
          ignoreReturnCode: true,
          listeners: { stdout: collect, stderr: collect },
        }),
      )
    } finally {
      // In case --rm did not happen.
      await exec.exec('docker', ['rm', '-f', name], { silent: true, ignoreReturnCode: true })
    }
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
