// The single in-memory store. Repos, issues, labels, pulls, comments and git
// objects all live here; REST, GraphQL, MCP and the git smart-HTTP handlers
// read and write the same Repo objects, so every surface always agrees.
//
// Determinism: no Date.now(), no Math.random(). Every created/updated
// timestamp comes from a monotonic counter off SCENARIO_EPOCH_SEC, so a
// deterministic request sequence produces identical bytes every run.
import { VIEWER } from './scenario.ts';
import {
  buildTreeObjects, hashObject, parseCommit, parseTree, serializeCommit,
  type CommitInfo, type ObjectType,
} from './git/objects.ts';

export const SCENARIO_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';
export const COMMIT_AUTHOR_NAME = 'Conformance';
export const COMMIT_AUTHOR_EMAIL = 'conformance@make.fun';

export interface GitObject {
  type: ObjectType;
  bytes: Buffer;
  commit?: CommitInfo;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  createdSeq: number;
  commentIds: number[];
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  createdSeq: number;
  commentIds: number[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  /** Bumped on every git-object or ref change; the git pack/ls-refs caches key on it. */
  version: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  issueCounter: number;
  labels: Set<string>;
  pulls: Map<number, Pull>;
  prCounter: number;
  comments: Map<number, Comment>;
  commentCounter: number;
  commitCounter: number;
  treeFilesCache: Map<string, Map<string, { oid: string; mode: string }>>;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  sha: string;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Opaque, stable, decodeable global ids. Never equal to String(databaseId) or String(number). */
export function encodeGlobalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  repoSeq = 0;
  idCounter = 0;
  tsCounter = 0;

  nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  /** Monotonic ISO timestamp; strictly increasing per call, deterministic. */
  nextTimestamp(): string {
    const ts = SCENARIO_EPOCH_SEC + this.tsCounter;
    this.tsCounter += 1;
    return new Date(ts * 1000).toISOString();
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  isViewer(owner: string): boolean {
    return owner === VIEWER.login;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextId(), owner, name, fullName: key,
      description: description ?? '', private: isPrivate ?? false, defaultBranch: 'main',
      seq: this.repoSeq++, version: 0, refs: new Map(), objects: new Map(),
      issues: new Map(), issueCounter: 0, labels: new Set(),
      pulls: new Map(), prCounter: 0, comments: new Map(), commentCounter: 0,
      commitCounter: 0, treeFilesCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // ---- git objects ----
  putObject(repo: Repo, type: ObjectType, bytes: Buffer): string {
    const oid = hashObject(type, bytes);
    if (!repo.objects.has(oid)) {
      const obj: GitObject = { type, bytes };
      if (type === 'commit') obj.commit = parseCommit(bytes);
      repo.objects.set(oid, obj);
      repo.version += 1;
    }
    return oid;
  }

  /** Store an object whose oid is already known (e.g. from parsePack, which
   * verified the SHA-1): skips the re-hash. */
  putObjectByOid(repo: Repo, oid: string, type: ObjectType, bytes: Buffer): void {
    if (repo.objects.has(oid)) return;
    const obj: GitObject = { type, bytes };
    if (type === 'commit') obj.commit = parseCommit(bytes);
    repo.objects.set(oid, obj);
    repo.version += 1;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  /** Resolve a ref name, branch name, 'HEAD' or full sha to an oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  /** Flat path -> blob map for a tree oid (memoised; objects are immutable). */
  treeFiles(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const cached = repo.treeFilesCache.get(treeOid);
    if (cached) return cached;
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.bytes)) {
        if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
        else out.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, '');
    repo.treeFilesCache.set(treeOid, out);
    return out;
  }

  /** Files at a commit oid. */
  commitFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const obj = repo.objects.get(commitOid);
    if (!obj || !obj.commit) return new Map();
    return this.treeFiles(repo, obj.commit.tree);
  }

  /** Build tree objects from a flat files map; stores them; returns root tree oid. */
  buildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    const { rootOid, objects } = buildTreeObjects(files);
    for (const [oid, bytes] of objects) this.putObject(repo, 'tree', bytes);
    return rootOid;
  }

  /** Create a commit object; stores it; returns the oid. */
  createCommit(repo: Repo, opts: { tree: string; parents: string[]; message: string; authorTs?: number }): string {
    const ts = opts.authorTs ?? SCENARIO_EPOCH_SEC + repo.commitCounter;
    repo.commitCounter += 1;
    const info: CommitInfo = {
      tree: opts.tree, parents: opts.parents,
      authorName: COMMIT_AUTHOR_NAME, authorEmail: COMMIT_AUTHOR_EMAIL, authorTs: ts, authorTz: '+0000',
      committerName: COMMIT_AUTHOR_NAME, committerEmail: COMMIT_AUTHOR_EMAIL, committerTs: ts, committerTz: '+0000',
      message: opts.message,
    };
    return this.putObject(repo, 'commit', serializeCommit(info));
  }

  /** First-parent walk from a tip, newest first. */
  listCommits(repo: Repo, startOid: string, limit: number): CommitInfo[] {
    const out: CommitInfo[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = startOid;
    while (cur && out.length < limit && !seen.has(cur)) {
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || !obj.commit) break;
      out.push(obj.commit);
      cur = obj.commit.parents[0];
    }
    return out;
  }

  /** Commit oids on the first-parent chain from a tip. */
  commitChain(repo: Repo, startOid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = startOid;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || !obj.commit) break;
      out.push(cur);
      cur = obj.commit.parents[0];
    }
    return out;
  }

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  // ---- issues ----
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = ++repo.issueCounter;
    const now = this.nextTimestamp();
    const issue: Issue = {
      id: this.nextId(), number, title, body: body ?? '', state: 'open',
      labels: [...labels], user: VIEWER.login, createdAt: now, updatedAt: now,
      closedAt: null, createdSeq: number, commentIds: [],
    };
    for (const l of labels) repo.labels.add(l);
    repo.issues.set(number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(repo: Repo, opts: { state?: string; labels?: string[]; sort?: string; direction?: string }): Issue[] {
    let list = [...repo.issues.values()];
    if (opts.state && opts.state !== 'all') list = list.filter((i) => i.state === opts.state);
    if (opts.labels && opts.labels.length > 0) {
      list = list.filter((i) => opts.labels!.every((l) => i.labels.includes(l)));
    }
    const dir = opts.direction === 'asc' ? 1 : -1;
    if (opts.sort === 'created') list.sort((a, b) => dir * (a.createdSeq - b.createdSeq));
    else list.sort((a, b) => dir * (a.createdSeq - b.createdSeq));
    return list;
  }

  // ---- comments (shared by issues and pulls) ----
  addComment(repo: Repo, body: string): Comment {
    const id = ++repo.commentCounter;
    const comment: Comment = {
      id, body: body ?? '', user: VIEWER.login,
      createdAt: this.nextTimestamp(), createdSeq: id,
    };
    repo.comments.set(id, comment);
    return comment;
  }

  // ---- pulls ----
  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string; status: number } {
    const baseSha = this.resolveRef(repo, base);
    if (!baseSha) return { error: `base branch ${base} not found`, status: 422 };
    const headSha = this.resolveRef(repo, head);
    if (!headSha) return { error: `head branch ${head} not found`, status: 422 };
    const number = ++repo.prCounter;
    const now = this.nextTimestamp();
    const pr: Pull = {
      id: this.nextId(), number, title, body: body ?? '', state: 'open', merged: false,
      mergedAt: null, mergeCommitSha: null, mergeable: true,
      headRef: head, baseRef: base, headSha, baseSha, user: VIEWER.login,
      createdAt: now, updatedAt: now, closedAt: null, createdSeq: number, commentIds: [],
    };
    pr.mergeable = !this.isMergeConflict(repo, pr);
    repo.pulls.set(number, pr);
    return pr;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state?: string): Pull[] {
    let list = [...repo.pulls.values()];
    if (state && state !== 'all') list = list.filter((p) => p.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return list;
  }

  /** Paths changed between two commit oids (old -> new). */
  changedPaths(repo: Repo, oldOid: string | null, newOid: string): Set<string> {
    const oldFiles = oldOid ? this.commitFiles(repo, oldOid) : new Map<string, { oid: string; mode: string }>();
    const newFiles = this.commitFiles(repo, newOid);
    const changed = new Set<string>();
    for (const [path, f] of newFiles) {
      const old = oldFiles.get(path);
      if (!old || old.oid !== f.oid) changed.add(path);
    }
    for (const path of oldFiles.keys()) if (!newFiles.has(path)) changed.add(path);
    return changed;
  }

  /** File-level diff between two commit oids. */
  diffFiles(repo: Repo, oldOid: string | null, newOid: string): FileChange[] {
    const oldFiles = oldOid ? this.commitFiles(repo, oldOid) : new Map<string, { oid: string; mode: string }>();
    const newFiles = this.commitFiles(repo, newOid);
    const out: FileChange[] = [];
    const all = new Set([...oldFiles.keys(), ...newFiles.keys()]);
    for (const path of [...all].sort()) {
      const oldF = oldFiles.get(path);
      const newF = newFiles.get(path);
      if (!oldF && newF) {
        const content = repo.objects.get(newF.oid)?.bytes.toString('utf8') ?? '';
        out.push({ filename: path, status: 'added', additions: lineCount(content), deletions: 0, sha: newF.oid });
      } else if (oldF && !newF) {
        const content = repo.objects.get(oldF.oid)?.bytes.toString('utf8') ?? '';
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(content), sha: oldF.oid });
      } else if (oldF && newF && oldF.oid !== newF.oid) {
        const oldContent = repo.objects.get(oldF.oid)?.bytes.toString('utf8') ?? '';
        const newContent = repo.objects.get(newF.oid)?.bytes.toString('utf8') ?? '';
        out.push({ filename: path, status: 'modified', additions: lineCount(newContent), deletions: lineCount(oldContent), sha: newF.oid });
      }
    }
    return out;
  }

  /** True when the PR's head changes overlap changes already landed on the base tip. */
  isMergeConflict(repo: Repo, pr: Pull): boolean {
    const baseTip = this.resolveRef(repo, pr.baseRef);
    if (!baseTip) return false;
    if (baseTip === pr.baseSha) return false;
    const headChanged = this.changedPaths(repo, pr.baseSha, pr.headSha);
    const baseChanged = this.changedPaths(repo, pr.baseSha, baseTip);
    for (const p of headChanged) if (baseChanged.has(p)) return true;
    return false;
  }

  pullFiles(repo: Repo, pr: Pull): FileChange[] {
    return this.diffFiles(repo, pr.baseSha, pr.headSha);
  }

  /** Squash-merge a PR onto its base branch. Returns the merge commit sha or an error. */
  mergePull(repo: Repo, pr: Pull): { sha: string } | { error: string; status: number } {
    if (pr.state !== 'open') return { error: 'pull request is not open', status: 405 };
    if (this.isMergeConflict(repo, pr)) return { error: 'merge conflict', status: 405 };
    const baseTip = this.resolveRef(repo, pr.baseRef);
    if (!baseTip) return { error: `base branch ${pr.baseRef} not found`, status: 422 };
    const headFiles = this.commitFiles(repo, pr.headSha);
    const tree = this.buildTree(repo, headFiles);
    const sha = this.createCommit(repo, {
      tree, parents: [baseTip],
      message: `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`,
    });
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.nextTimestamp();
    pr.mergeCommitSha = sha;
    pr.closedAt = pr.mergedAt;
    pr.updatedAt = pr.mergedAt;
    pr.mergeable = true;
    return { sha };
  }
}

export const store = new Store();
