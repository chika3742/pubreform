// Fake GitHub REST API for the local E2E test.
// Implements only the API that pubreform uses. Commits and refs are written to a local bare repository with git,
// so that the Action can clone the base from it (GITHUB_SERVER_URL=file://…).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

export interface FakeComment {
  body: string
  user: { type: 'Bot' | 'User' }
}

export interface FakePr {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  base: string
  branch: string
  /** The head when the branch was deleted. Otherwise the branch ref is read. */
  lastSha: string
  merged_at: string | null
  labels: string[]
  comments: FakeComment[]
  updated: number
  /** `user.type` of the author: pubreform's pull requests are opened by a bot. */
  author: 'Bot' | 'User'
}

const BOT_ENV = {
  GIT_AUTHOR_NAME: 'pubreform-e2e[bot]',
  GIT_AUTHOR_EMAIL: 'bot@example.com',
  GIT_COMMITTER_NAME: 'pubreform-e2e[bot]',
  GIT_COMMITTER_EMAIL: 'bot@example.com',
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class FakeGitHub {
  readonly prs: FakePr[] = []
  readonly labels: string[] = []
  /** Requests received, as "METHOD /path". */
  readonly requests: string[] = []
  private failRefUpdates = 0
  /** Heads that the pull requests report, behind their refs, as GitHub does for a few seconds. */
  private staleHeads = new Map<number, string>()
  private clock = 0
  private server?: http.Server
  url = ''

  constructor(
    /** Bare repository. */
    readonly repoDir: string,
    readonly owner = 'owner',
    readonly repo = 'repo',
    readonly defaultBranch = 'main',
  ) {}

  // ---- git ----

  git(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string {
    return execFileSync('git', args, {
      cwd: this.repoDir,
      input: opts.input,
      env: { ...process.env, ...BOT_ENV, ...opts.env },
      encoding: 'utf8',
    }).trim()
  }

  refSha(branch: string): string | undefined {
    try {
      return this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
    } catch {
      return undefined
    }
  }

  /** Writes a tree from `baseTree` with the files replaced. */
  writeTree(baseTree: string, files: Record<string, string>): string {
    const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-github-index-')), 'index')
    const env = { GIT_INDEX_FILE: index }
    try {
      this.git(['read-tree', baseTree], { env })
      for (const [file, content] of Object.entries(files)) {
        const blob = this.git(['hash-object', '-w', '--stdin'], { input: content })
        this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env })
      }
      return this.git(['write-tree'], { env })
    } finally {
      fs.rmSync(path.dirname(index), { recursive: true, force: true })
    }
  }

  commitTree(tree: string, parents: string[], message: string, env?: Record<string, string>): string {
    return this.git(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], { input: message, env })
  }

  readFile(ref: string, file: string): string {
    return this.git(['show', `${ref}:${file}`])
  }

  // ---- Operations for the test ----

  pr(number: number): FakePr {
    const pr = this.prs.find((p) => p.number === number)
    if (!pr) throw new Error(`no PR #${number}`)
    return pr
  }

  headOf(pr: FakePr): string {
    return this.refSha(pr.branch) ?? pr.lastSha
  }

  /** Commits files to the default branch, as a person would push. */
  commitToBase(files: Record<string, string>, message: string): string {
    const parent = this.refSha(this.defaultBranch)!
    const tree = this.writeTree(`${parent}^{tree}`, files)
    const sha = this.commitTree(tree, [parent], message, { GIT_AUTHOR_NAME: 'Someone', GIT_COMMITTER_NAME: 'Someone' })
    this.git(['update-ref', `refs/heads/${this.defaultBranch}`, sha])
    return sha
  }

  /** Merges the pull request: the base moves to the branch head (it is always based on the base) and the PR closes. */
  merge(number: number) {
    const pr = this.pr(number)
    const head = this.headOf(pr)
    const merged = this.commitTree(`${head}^{tree}`, [this.refSha(this.defaultBranch)!], `Merge #${number}`)
    this.git(['update-ref', `refs/heads/${this.defaultBranch}`, merged])
    pr.state = 'closed'
    pr.merged_at = new Date().toISOString()
    pr.lastSha = head
    pr.updated = ++this.clock
  }

  checkRebaseBox(number: number) {
    const pr = this.pr(number)
    pr.body = pr.body.replace('- [ ] Rebase this PR', '- [x] Rebase this PR')
  }

  /** Adds a commit by a person to the branch of the pull request. */
  addManualCommit(number: number): string {
    const pr = this.pr(number)
    const head = this.headOf(pr)
    const tree = this.writeTree(`${head}^{tree}`, { 'NOTES.md': 'manual change\n' })
    const sha = this.commitTree(tree, [head], 'Manual change', { GIT_AUTHOR_NAME: 'Someone', GIT_COMMITTER_NAME: 'Someone' })
    this.git(['update-ref', `refs/heads/${pr.branch}`, sha])
    return sha
  }

  /** Opens a pull request as a person, from a new branch with one commit on the default branch. */
  openPrAsPerson(branch: string): FakePr {
    const parent = this.refSha(this.defaultBranch)!
    const tree = this.writeTree(`${parent}^{tree}`, { 'NOTES.md': 'a change by a person\n' })
    const sha = this.commitTree(tree, [parent], 'A change', { GIT_AUTHOR_NAME: 'Someone', GIT_COMMITTER_NAME: 'Someone' })
    this.git(['update-ref', `refs/heads/${branch}`, sha])
    const pr: FakePr = {
      number: this.prs.length + 1,
      title: 'A change by a person',
      body: '',
      state: 'open',
      base: this.defaultBranch,
      branch,
      lastSha: sha,
      merged_at: null,
      labels: [],
      comments: [],
      updated: ++this.clock,
      author: 'User',
    }
    this.prs.push(pr)
    return pr
  }

  /** Closes the pull request without merging, as a person (the body is not changed). */
  closeAsUser(number: number) {
    const pr = this.pr(number)
    pr.state = 'closed'
    pr.updated = ++this.clock
  }

  /** Makes the pull request keep reporting its current head after the ref moves, until `freshHeads`. */
  staleHead(number: number) {
    this.staleHeads.set(number, this.headOf(this.pr(number)))
  }

  freshHeads() {
    this.staleHeads.clear()
  }

  /** Makes the next `count` branch updates (PATCH /git/refs) fail. */
  failNextBranchUpdates(count = 1) {
    this.failRefUpdates = count
  }

  // ---- Server ----

  async start(): Promise<void> {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = decodeURIComponent(url.pathname)
      this.requests.push(`${req.method} ${pathname}`)
      try {
        const { status, body } = this.handle(req.method ?? 'GET', pathname, url.searchParams, text ? JSON.parse(text) : {})
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body === undefined ? '' : JSON.stringify(body))
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: (e as Error).message }))
      }
    })
    this.server = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }

  private prJson(pr: FakePr) {
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged_at: pr.merged_at,
      mergeable: true,
      mergeable_state: 'clean',
      head: { ref: pr.branch, sha: this.staleHeads.get(pr.number) ?? this.headOf(pr), repo: { full_name: `${this.owner}/${this.repo}` } },
      base: { ref: pr.base },
      labels: pr.labels.map((name) => ({ name })),
      user: { type: pr.author },
    }
  }

  private handle(method: string, fullPath: string, query: URLSearchParams, body: any): { status: number; body?: unknown } {
    const prefix = `/repos/${this.owner}/${this.repo}`
    if (!fullPath.startsWith(prefix)) throw new HttpError(404, `unknown path ${fullPath}`)
    const p = fullPath.slice(prefix.length)
    const ok = (b: unknown, status = 200) => ({ status, body: b })
    let m: RegExpExecArray | null

    if (p === '' && method === 'GET') return ok({ default_branch: this.defaultBranch })

    if (p === '/pulls' && method === 'GET') {
      const state = query.get('state') ?? 'open'
      const base = query.get('base')
      const head = query.get('head')
      let prs = this.prs.filter(
        (pr) =>
          (state === 'all' || pr.state === state) &&
          (!base || pr.base === base) &&
          (!head || head === `${this.owner}:${pr.branch}`),
      )
      if (query.get('sort') === 'updated') prs = [...prs].sort((a, b) => b.updated - a.updated)
      return ok(prs.slice(0, Number(query.get('per_page') ?? 30)).map((pr) => this.prJson(pr)))
    }
    if (p === '/pulls' && method === 'POST') {
      if (!this.refSha(body.head)) throw new HttpError(422, `no branch ${body.head}`)
      if (this.prs.some((pr) => pr.state === 'open' && pr.branch === body.head)) {
        throw new HttpError(422, `a pull request already exists for ${body.head}`)
      }
      const pr: FakePr = {
        number: this.prs.length + 1,
        title: body.title,
        body: body.body ?? '',
        state: 'open',
        base: body.base,
        branch: body.head,
        lastSha: this.refSha(body.head)!,
        merged_at: null,
        labels: [],
        comments: [],
        updated: ++this.clock,
        author: 'Bot',
      }
      this.prs.push(pr)
      return ok(this.prJson(pr), 201)
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(p))) {
      const pr = this.pr(Number(m[1]))
      if (method === 'PATCH') {
        for (const key of ['title', 'body', 'state'] as const) if (body[key] !== undefined) (pr as any)[key] = body[key]
        pr.updated = ++this.clock
      }
      return ok(this.prJson(pr))
    }

    if (p === '/git/trees' && method === 'POST') {
      const files = Object.fromEntries((body.tree as { path: string; content: string }[]).map((e) => [e.path, e.content]))
      return ok({ sha: this.writeTree(body.base_tree, files) }, 201)
    }
    if (p === '/git/commits' && method === 'POST') {
      return ok({ sha: this.commitTree(body.tree, body.parents, body.message) }, 201)
    }
    if (p === '/git/refs' && method === 'POST') {
      const branch = String(body.ref).replace(/^refs\/heads\//, '')
      if (this.refSha(branch)) throw new HttpError(422, 'Reference already exists')
      this.git(['update-ref', `refs/heads/${branch}`, body.sha])
      return ok({ ref: body.ref, object: { sha: body.sha } }, 201)
    }
    if ((m = /^\/git\/refs?\/heads\/(.+)$/.exec(p))) {
      const branch = m[1]!
      const sha = this.refSha(branch)
      if (!sha) throw new HttpError(404, 'Not Found')
      if (method === 'GET') return ok({ ref: `refs/heads/${branch}`, object: { sha } })
      if (method === 'PATCH') {
        if (this.failRefUpdates > 0) {
          this.failRefUpdates--
          throw new HttpError(500, 'injected failure of the branch update')
        }
        this.git(['update-ref', `refs/heads/${branch}`, body.sha])
        return ok({ ref: `refs/heads/${branch}`, object: { sha: body.sha } })
      }
      if (method === 'DELETE') {
        for (const pr of this.prs.filter((x) => x.branch === branch)) pr.lastSha = this.headOf(pr)
        this.git(['update-ref', '-d', `refs/heads/${branch}`])
        return { status: 204 }
      }
    }

    if (p === '/labels' && method === 'GET') return ok(this.labels.map((name) => ({ name })))
    if (p === '/labels' && method === 'POST') {
      if (this.labels.some((l) => l.toLowerCase() === String(body.name).toLowerCase())) {
        throw new HttpError(422, 'already_exists')
      }
      this.labels.push(body.name)
      return ok({ name: body.name }, 201)
    }
    if ((m = /^\/issues\/(\d+)\/labels$/.exec(p)) && method === 'POST') {
      const pr = this.pr(Number(m[1]))
      for (const label of body.labels as string[]) {
        // pubreform must create missing labels first.
        if (!this.labels.includes(label)) throw new HttpError(422, `label ${label} does not exist`)
        if (!pr.labels.includes(label)) pr.labels.push(label)
      }
      return ok(pr.labels.map((name) => ({ name })))
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(p))) {
      const pr = this.pr(Number(m[1]))
      if (method === 'GET') return ok(pr.comments.map((c, i) => ({ id: i + 1, ...c })))
      pr.comments.push({ body: body.body, user: { type: 'Bot' } })
      return ok({ id: pr.comments.length }, 201)
    }
    throw new HttpError(404, `not implemented: ${method} ${p}`)
  }
}
