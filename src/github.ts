// GitHub API operations (detailed design §13).
import { getOctokit } from '@actions/github'
import type { PubFiles } from './pub.ts'
import { BRANCH_PREFIX, parseMeta } from './render.ts'
import type { PrState } from './reconciler.ts'

type Octokit = ReturnType<typeof getOctokit>

export interface Comment {
  body: string
  isBot: boolean
}

const LABEL_COLOR = 'ededed'

function status(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null && 'status' in e ? (e as { status: number }).status : undefined
}

export class GitHub {
  private readonly octokit: Octokit
  private labelsReady?: Promise<string[]>

  constructor(
    token: string,
    readonly owner: string,
    readonly repo: string,
    octokit?: Octokit,
  ) {
    this.octokit = octokit ?? getOctokit(token)
  }

  private get r() {
    return { owner: this.owner, repo: this.repo }
  }

  async defaultBranch(): Promise<string> {
    const { data } = await this.octokit.rest.repos.get(this.r)
    return data.default_branch
  }

  private toState(pr: {
    number: number
    title: string
    body: string | null
    head: { ref: string; sha: string }
  }): PrState {
    const body = pr.body ?? ''
    return { number: pr.number, branch: pr.head.ref, headSha: pr.head.sha, title: pr.title, body, meta: parseMeta(body) }
  }

  private isOurs(pr: { head: { ref: string; repo: { full_name: string } | null } }): boolean {
    return pr.head.ref.startsWith(BRANCH_PREFIX) && pr.head.repo?.full_name === `${this.owner}/${this.repo}`
  }

  /** Open pull requests of pubreform, with mergeability. */
  async openPrs(base: string): Promise<PrState[]> {
    const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      ...this.r,
      state: 'open',
      base,
      per_page: 100,
    })
    const result: PrState[] = []
    for (const pr of prs.filter((p) => this.isOurs(p))) {
      const { data } = await this.octokit.rest.pulls.get({ ...this.r, pull_number: pr.number })
      result.push({ ...this.toState(data), mergeable: data.mergeable, mergeableState: data.mergeable_state })
    }
    return result
  }

  /** The latest 100 closed pull requests of pubreform that were not merged. */
  async closedPrs(base: string): Promise<PrState[]> {
    const { data } = await this.octokit.rest.pulls.list({
      ...this.r,
      state: 'closed',
      base,
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    })
    return data.filter((p) => p.merged_at === null && this.isOurs(p)).map((p) => this.toState(p))
  }

  /** Creates a commit with the two files on top of the base commit. */
  async createCommit(opts: { baseSha: string; baseTree: string; files: PubFiles; message: string }): Promise<string> {
    const { data: tree } = await this.octokit.rest.git.createTree({
      ...this.r,
      base_tree: opts.baseTree,
      tree: [
        { path: 'pubspec.yaml', mode: '100644', type: 'blob', content: opts.files.pubspec },
        { path: 'pubspec.lock', mode: '100644', type: 'blob', content: opts.files.lock },
      ],
    })
    const { data: commit } = await this.octokit.rest.git.createCommit({
      ...this.r,
      message: opts.message,
      tree: tree.sha,
      parents: [opts.baseSha],
    })
    return commit.sha
  }

  /** Creates the branch. If it exists and no open pull request uses it, moves it to `sha`. */
  async createBranch(branch: string, sha: string): Promise<void> {
    try {
      await this.octokit.rest.git.createRef({ ...this.r, ref: `refs/heads/${branch}`, sha })
    } catch (e) {
      if (status(e) !== 422) throw e
      const { data: prs } = await this.octokit.rest.pulls.list({
        ...this.r,
        state: 'open',
        head: `${this.owner}:${branch}`,
        per_page: 1,
      })
      if (prs.length > 0) throw new Error(`branch ${branch} already exists and is used by #${prs[0]!.number}`)
      await this.octokit.rest.git.updateRef({ ...this.r, ref: `heads/${branch}`, sha, force: true })
    }
  }

  /** Moves the branch to `sha` if its head is still `expected`. */
  async updateBranch(branch: string, expected: string, sha: string): Promise<void> {
    const { data } = await this.octokit.rest.git.getRef({ ...this.r, ref: `heads/${branch}` })
    if (data.object.sha !== expected) {
      throw new Error(`branch ${branch} has moved: expected ${expected}, found ${data.object.sha}`)
    }
    await this.octokit.rest.git.updateRef({ ...this.r, ref: `heads/${branch}`, sha, force: true })
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.octokit.rest.git.deleteRef({ ...this.r, ref: `heads/${branch}` })
  }

  async createPr(opts: { base: string; branch: string; title: string; body: string }): Promise<number> {
    const { data } = await this.octokit.rest.pulls.create({
      ...this.r,
      base: opts.base,
      head: opts.branch,
      title: opts.title,
      body: opts.body,
    })
    return data.number
  }

  async updatePr(number: number, opts: { title: string; body: string }): Promise<void> {
    await this.octokit.rest.pulls.update({ ...this.r, pull_number: number, ...opts })
  }

  /** Closes the pull request and replaces its body in one request. */
  async closePr(number: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.update({ ...this.r, pull_number: number, state: 'closed', body })
  }

  /**
   * Creates the labels that do not exist yet, once per run. Returns the labels that can be added;
   * labels that could not be created are reported through `onError` and left out.
   */
  ensureLabels(labels: string[], onError: (label: string, e: unknown) => void): Promise<string[]> {
    this.labelsReady ??= (async () => {
      const existing = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
        ...this.r,
        per_page: 100,
      })
      // Label names are case-insensitive on GitHub.
      const names = new Set(existing.map((l) => l.name.toLowerCase()))
      const ready: string[] = []
      for (const label of labels) {
        if (names.has(label.toLowerCase())) {
          ready.push(label)
          continue
        }
        try {
          await this.octokit.rest.issues.createLabel({ ...this.r, name: label, color: LABEL_COLOR })
          ready.push(label)
        } catch (e) {
          onError(label, e)
        }
      }
      return ready
    })()
    return this.labelsReady
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return
    await this.octokit.rest.issues.addLabels({ ...this.r, issue_number: number, labels })
  }

  async comments(number: number): Promise<Comment[]> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      ...this.r,
      issue_number: number,
      per_page: 100,
    })
    return comments.map((c) => ({ body: c.body ?? '', isBot: c.user?.type === 'Bot' }))
  }

  async comment(number: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ ...this.r, issue_number: number, body })
  }
}
