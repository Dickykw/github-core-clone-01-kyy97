// REST v3 surface — GitHub REST API clone (see study/03-rest.md).
// Single file; talks to the shared store only. Deterministic: timestamps
// and ids come from the store counters, never Date.now()/Math.random().
import type { Ctx } from './app.ts';
import { jsonError, sendJson } from './app.ts';
import { VIEWER } from './scenario.ts';
import {
  store, encodeGlobalId, FIXED_ISO, SCENARIO_EPOCH_SEC,
  type Comment, type Issue, type Pull, type Repo,
} from './store.ts';
import { parseTree } from './git/objects.ts';

const COMMON_HEADERS: Record<string, string> = {
  'x-github-media-type': 'github.v3',
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-reset': String(SCENARIO_EPOCH_SEC),
};

function send(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(ctx.res, status, body, {
    ...COMMON_HEADERS,
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
}

function fail(ctx: Ctx, status: number, message: string, extra: Record<string, unknown> = {}): void {
  send(ctx, status, { message, ...extra });
}

function sendNoContent(ctx: Ctx): void {
  ctx.res.writeHead(204, { ...COMMON_HEADERS, 'x-github-request-id': ctx.requestId });
  ctx.res.end();
}

/** Parse a request body. Empty body -> null value. Invalid JSON -> 400. */
function parseBody(ctx: Ctx): { ok: true; value: unknown } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(ctx.body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function bodyObj(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function isoFromTs(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

// ---- shapes ----

function userShape(login: string): Record<string, unknown> {
  return { login, id: VIEWER.id, type: 'User' };
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: encodeGlobalId('repo', repo.owner, repo.name),
    name: repo.name,
    full_name: repo.fullName,
    owner: userShape(repo.owner),
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function labelShape(repo: Repo, name: string): Record<string, unknown> {
  return { name, color: labelColor(repo, name) };
}

// Label colours live beside the store (Repo only keeps a Set of names).
const labelColors = new Map<string, Map<string, string>>();
function labelColor(repo: Repo, name: string): string {
  return labelColors.get(repo.fullName)?.get(name) ?? 'ededed';
}
function setLabelColor(repo: Repo, name: string, color: string): void {
  let m = labelColors.get(repo.fullName);
  if (!m) {
    m = new Map();
    labelColors.set(repo.fullName, m);
  }
  m.set(name, color);
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeGlobalId('issue', repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => labelShape(repo, l)),
    user: userShape(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.commentIds.length,
  };
}

function pullShape(repo: Repo, pr: Pull): Record<string, unknown> {
  const mergeable = pr.state === 'open' ? !store.isMergeConflict(repo, pr) : true;
  return {
    id: pr.id,
    node_id: encodeGlobalId('pr', repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable,
    head: {
      ref: pr.headRef,
      sha: pr.headSha,
      repo: { full_name: repo.fullName },
    },
    base: {
      ref: pr.baseRef,
      sha: pr.baseSha,
      repo: { full_name: repo.fullName },
    },
    user: userShape(pr.user),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    draft: false,
  };
}

function commentShape(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: encodeGlobalId('comment', comment.id),
    body: comment.body,
    user: userShape(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function commitShape(sha: string, repo: Repo): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || !obj.commit) return null;
  const c = obj.commit;
  return {
    sha,
    commit: {
      message: c.message,
      author: { name: c.authorName, email: c.authorEmail, date: isoFromTs(c.authorTs) },
      committer: { name: c.committerName, email: c.committerEmail, date: isoFromTs(c.committerTs) },
    },
    parents: c.parents.map((p) => ({ sha: p })),
    tree: { sha: c.tree },
  };
}

// ---- pagination ----

function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(ctx: Ctx, list: T[]): { items: T[]; link: string | null } {
  const { page, perPage } = pageParams(ctx);
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const items = list.slice((page - 1) * perPage, page * perPage);
  if (totalPages <= 1 && page <= 1) return { items, link: null };
  const base = ctx.pathname;
  // Link URLs must be absolute (same origin as the entry): the env's
  // pagination walk rejects a relative URL as "left the entry's origin".
  const origin = `http://${ctx.req.headers.host ?? 'entry'}`;
  const mk = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${origin}${base}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) {
    parts.push(`${mk(page + 1)}; rel="next"`);
    parts.push(`${mk(totalPages)}; rel="last"`);
  }
  if (page > 1) {
    parts.push(`${mk(1)}; rel="first"`);
    parts.push(`${mk(page - 1)}; rel="prev"`);
  }
  return { items, link: parts.length > 0 ? parts.join(', ') : null };
}

function sendList(ctx: Ctx, list: unknown[]): void {
  const { items, link } = paginate(ctx, list);
  send(ctx, 200, items, link ? { Link: link } : {});
}

// ---- git helpers ----

/** Tree oid of `path` inside the tree rooted at `rootTreeOid`, or null. */
function treeOidAtPath(repo: Repo, rootTreeOid: string, path: string): string | null {
  if (path === '') return rootTreeOid;
  let cur = rootTreeOid;
  for (const part of path.split('/')) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.bytes).find((e) => e.name === part);
    if (!entry) return null;
    cur = entry.oid;
  }
  return cur;
}

function dirEntries(repo: Repo, treeOid: string, basePath: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.bytes).map((e) => ({
    name: e.name,
    path: basePath === '' ? e.name : `${basePath}/${e.name}`,
    sha: e.oid,
    type: e.mode === '40000' ? 'dir' : 'file',
  }));
}

// ---- main handler ----

export async function handleRest(ctx: Ctx): Promise<void> {
  const { method } = ctx;
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let parsed: unknown = null;
  if (hasBody) {
    const r = parseBody(ctx);
    if (!r.ok) {
      fail(ctx, 400, 'Problems parsing JSON');
      return;
    }
    parsed = r.value;
  }

  const restPath = ctx.pathname === '/api/v3' ? '/' : ctx.pathname.slice('/api/v3'.length);
  const segs = restPath.split('/').filter((s) => s.length > 0).map(decodeSeg);

  // GET /api/v3/ — root.
  if (segs.length === 0) {
    if (method !== 'GET') {
      fail(ctx, 404, 'Not Found');
      return;
    }
    send(ctx, 200, {}, { 'x-oauth-scopes': 'repo, user' });
    return;
  }

  // GET /api/v3/meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') {
      fail(ctx, 404, 'Not Found');
      return;
    }
    send(ctx, 200, { installed_version: '1.0.0' });
    return;
  }

  // GET /api/v3/rate_limit
  if (segs.length === 1 && segs[0] === 'rate_limit') {
    if (method !== 'GET') {
      fail(ctx, 404, 'Not Found');
      return;
    }
    const core = { limit: 5000, remaining: 4999, reset: SCENARIO_EPOCH_SEC, used: 1 };
    send(ctx, 200, { resources: { core, search: core, graphql: core }, rate: core });
    return;
  }

  // GET /api/v3/user
  if (segs.length === 1 && segs[0] === 'user') {
    if (method !== 'GET') {
      fail(ctx, 404, 'Not Found');
      return;
    }
    send(ctx, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: encodeGlobalId('user', VIEWER.login),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
    });
    return;
  }

  // /user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      sendList(ctx, store.listRepos(VIEWER.login).map((r) => repoShape(r)));
      return;
    }
    if (method === 'POST') {
      const b = bodyObj(parsed);
      if (!b) {
        fail(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const name = str(b.name).trim();
      if (name === '') {
        fail(ctx, 422, 'Validation Failed', { errors: [{ resource: 'Repository', field: 'name', code: 'missing' }] });
        return;
      }
      const repo = store.createRepo(
        VIEWER.login, name, str(b.description),
        b.private === undefined ? false : b.private === true,
      );
      if (!repo) {
        // Study 03-rest §3.1: a duplicate create is accepted by the suite as 422.
        fail(ctx, 422, 'Repository already exists', { errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
        return;
      }
      send(ctx, 201, repoShape(repo));
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // POST /orgs/{org}/repos
  if (segs.length === 3 && segs[0] === 'orgs' && segs[2] === 'repos') {
    if (method !== 'POST') {
      fail(ctx, 404, 'Not Found');
      return;
    }
    const b = bodyObj(parsed);
    if (!b) {
      fail(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const name = str(b.name).trim();
    if (name === '') {
      fail(ctx, 422, 'Validation Failed');
      return;
    }
    const repo = store.createRepo(segs[1], name, str(b.description), b.private === true);
    if (!repo) {
      fail(ctx, 422, 'Repository already exists');
      return;
    }
    send(ctx, 201, repoShape(repo));
    return;
  }

  // Everything below is /repos/{owner}/{repo}/...
  if (segs.length < 3 || segs[0] !== 'repos') {
    fail(ctx, 404, 'Not Found');
    return;
  }
  const owner = segs[0 + 1];
  const repoName = segs[2];
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    fail(ctx, 404, 'Not Found');
    return;
  }
  const tail = segs.slice(3);

  // /repos/{o}/{r} itself — GET / PATCH / PUT / DELETE
  if (tail.length === 0) {
    if (method === 'GET') {
      send(ctx, 200, repoShape(repo));
      return;
    }
    if (method === 'PATCH' || method === 'PUT') {
      const b = bodyObj(parsed);
      if (b) {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        if (typeof b.default_branch === 'string' && b.default_branch !== '') {
          repo.defaultBranch = b.default_branch;
        }
        if (typeof b.name === 'string' && b.name !== '' && b.name !== repo.name) {
          // Renames are not supported by the store; ignore the name change.
        }
      }
      send(ctx, 200, repoShape(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendNoContent(ctx);
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  const head = tail[0];

  // ---- branches ----
  if (head === 'branches' && tail.length === 1) {
    if (method !== 'GET') {
      fail(ctx, 404, 'Not Found');
      return;
    }
    send(ctx, 200, store.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha } })));
    return;
  }

  // ---- commits ----
  if (head === 'commits' && tail.length === 1) {
    if (method !== 'GET') {
      fail(ctx, 404, 'Not Found');
      return;
    }
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (!tip) {
      send(ctx, 200, []);
      return;
    }
    const pathFilter = ctx.query.get('path') ?? '';
    const chain = store.commitChain(repo, tip);
    const items: Record<string, unknown>[] = [];
    for (const sha of chain) {
      const shape = commitShape(sha, repo);
      if (!shape) continue;
      if (pathFilter !== '') {
        const files = store.commitFiles(repo, sha);
        if (!files.has(pathFilter)) continue;
        const obj = repo.objects.get(sha);
        const parent = obj?.commit?.parents[0];
        if (parent) {
          const parentFiles = store.commitFiles(repo, parent);
          const cur = files.get(pathFilter);
          const prev = parentFiles.get(pathFilter);
          if (prev && cur && prev.oid === cur.oid) continue;
        }
      }
      items.push(shape);
    }
    sendList(ctx, items);
    return;
  }

  // ---- contents ----
  if (head === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (!tip) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      const commitObj = repo.objects.get(tip);
      if (!commitObj || !commitObj.commit) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      if (path === '') {
        send(ctx, 200, dirEntries(repo, commitObj.commit.tree, ''));
        return;
      }
      const files = store.commitFiles(repo, tip);
      const file = files.get(path);
      if (file) {
        const blob = repo.objects.get(file.oid);
        const bytes = blob ? blob.bytes : Buffer.alloc(0);
        send(ctx, 200, {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: file.oid,
          size: bytes.length,
          content: bytes.toString('base64'),
          encoding: 'base64',
        });
        return;
      }
      const treeOid = treeOidAtPath(repo, commitObj.commit.tree, path);
      if (treeOid !== null) {
        const entries = dirEntries(repo, treeOid, path);
        if (entries.length > 0 || [...files.keys()].some((p) => p.startsWith(`${path}/`))) {
          send(ctx, 200, entries);
          return;
        }
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const b = bodyObj(parsed);
      if (!b) {
        fail(ctx, 400, 'Problems parsing JSON');
        return;
      }
      if (path === '' || typeof b.content !== 'string') {
        fail(ctx, 422, 'Validation Failed');
        return;
      }
      const branch = str(b.branch) !== '' ? str(b.branch) : (ctx.query.get('branch') ?? repo.defaultBranch);
      const tip = store.resolveRef(repo, branch);
      if (!tip && branch !== repo.defaultBranch) {
        fail(ctx, 422, `Branch ${branch} not found`);
        return;
      }
      const files = tip ? store.commitFiles(repo, tip) : new Map<string, { oid: string; mode: string }>();
      const existing = files.get(path);
      if (existing && typeof b.sha === 'string' && b.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        fail(ctx, 409, 'Conflict: sha does not match the current file');
        return;
      }
      const bytes = Buffer.from(b.content.replace(/[\r\n\t ]+/g, ''), 'base64');
      const blobOid = store.putObject(repo, 'blob', bytes);
      const next = new Map(files);
      next.set(path, { oid: blobOid, mode: '100644' });
      const tree = store.buildTree(repo, next);
      const commitSha = store.createCommit(repo, {
        tree,
        parents: tip ? [tip] : [],
        message: str(b.message) !== '' ? str(b.message) : `Update ${path}`,
      });
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      send(ctx, existing ? 200 : 201, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: bytes.length,
          encoding: 'base64',
        },
        commit: { sha: commitSha, message: str(b.message) !== '' ? str(b.message) : `Update ${path}` },
      });
      return;
    }
    if (method === 'DELETE') {
      const b = bodyObj(parsed);
      const branch = (b && str(b.branch) !== '' ? str(b.branch) : (ctx.query.get('branch') ?? repo.defaultBranch));
      const tip = store.resolveRef(repo, branch);
      if (!tip) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      const files = store.commitFiles(repo, tip);
      const existing = files.get(path);
      if (!existing) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      if (b && typeof b.sha === 'string' && b.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        fail(ctx, 409, 'Conflict: sha does not match the current file');
        return;
      }
      const next = new Map(files);
      next.delete(path);
      const tree = store.buildTree(repo, next);
      const commitSha = store.createCommit(repo, {
        tree,
        parents: [tip],
        message: (b && str(b.message) !== '') ? str(b.message) : `Delete ${path}`,
      });
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      send(ctx, 200, { commit: { sha: commitSha } });
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- labels (repo level) ----
  if (head === 'labels') {
    if (tail.length === 1) {
      if (method === 'GET') {
        send(ctx, 200, [...repo.labels].sort().map((l) => labelShape(repo, l)));
        return;
      }
      if (method === 'POST') {
        const b = bodyObj(parsed);
        if (!b || str(b.name).trim() === '') {
          fail(ctx, 422, 'Validation Failed');
          return;
        }
        const name = str(b.name).trim();
        repo.labels.add(name);
        if (typeof b.color === 'string' && b.color !== '') setLabelColor(repo, name, b.color);
        send(ctx, 201, labelShape(repo, name));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    if (tail.length === 2 && method === 'DELETE') {
      repo.labels.delete(tail[1]);
      sendNoContent(ctx);
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- git refs / commits / trees ----
  if (head === 'git') {
    const sub = tail[1];
    if (sub === 'refs' && method === 'POST' && tail.length === 2) {
      const b = bodyObj(parsed);
      if (!b || str(b.ref) === '' || str(b.sha) === '') {
        fail(ctx, 422, 'Validation Failed');
        return;
      }
      const ref = str(b.ref);
      const sha = str(b.sha);
      if (repo.refs.has(ref)) {
        fail(ctx, 422, 'Reference already exists');
        return;
      }
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') {
        fail(ctx, 422, 'Object does not exist');
        return;
      }
      repo.refs.set(ref, sha);
      send(ctx, 201, { ref, object: { sha, type: 'commit' } });
      return;
    }
    if (sub === 'refs' && method === 'GET') {
      if (tail.length === 2) {
        const refs: Record<string, unknown>[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          refs.push({ ref, object: { sha, type: 'commit' } });
        }
        send(ctx, 200, refs);
        return;
      }
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      send(ctx, 200, { ref, object: { sha, type: 'commit' } });
      return;
    }
    if (sub === 'ref' && method === 'GET' && tail.length >= 3) {
      const raw = tail.slice(2).join('/');
      const candidates = raw.startsWith('refs/') ? [raw] : [`refs/${raw}`, raw];
      for (const ref of candidates) {
        const sha = repo.refs.get(ref);
        if (sha) {
          send(ctx, 200, { ref, object: { sha, type: 'commit' } });
          return;
        }
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    if (sub === 'commits' && method === 'GET' && tail.length === 3) {
      const sha = store.resolveRef(repo, tail[2]) ?? tail[2];
      const shape = commitShape(sha, repo);
      if (!shape) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      send(ctx, 200, shape);
      return;
    }
    if (sub === 'trees' && method === 'GET' && tail.length === 3) {
      const raw = tail[2];
      let treeOid: string | null = null;
      const asCommit = repo.objects.get(raw);
      if (asCommit && asCommit.type === 'commit' && asCommit.commit) treeOid = asCommit.commit.tree;
      else if (asCommit && asCommit.type === 'tree') treeOid = raw;
      else {
        const resolved = store.resolveRef(repo, raw);
        if (resolved) {
          const c = repo.objects.get(resolved);
          if (c && c.commit) treeOid = c.commit.tree;
        }
      }
      if (!treeOid) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      if (ctx.query.get('recursive') === '1') {
        const files = store.treeFiles(repo, treeOid);
        const entries: Record<string, unknown>[] = [];
        for (const [path, f] of [...files.entries()].sort()) {
          const blob = repo.objects.get(f.oid);
          entries.push({ path, mode: f.mode, type: 'blob', sha: f.oid, size: blob ? blob.bytes.length : 0 });
        }
        send(ctx, 200, { sha: treeOid, tree: entries, truncated: false });
        return;
      }
      const entries = dirEntries(repo, treeOid, '').map((e) => {
        const out: Record<string, unknown> = { path: e.name, mode: e.type === 'dir' ? '040000' : '100644', type: e.type, sha: e.sha };
        if (e.type === 'file') {
          const blob = repo.objects.get(String(e.sha));
          if (blob) out.size = blob.bytes.length;
        }
        return out;
      });
      send(ctx, 200, { sha: treeOid, tree: entries, truncated: false });
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- issues ----
  if (head === 'issues') {
    // /issues — list / create
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const labelsParam = ctx.query.get('labels') ?? '';
        const labels = labelsParam === '' ? undefined : labelsParam.split(',').map((s) => s.trim()).filter((s) => s !== '');
        const list = store.listIssues(repo, {
          state,
          labels,
          sort: ctx.query.get('sort') ?? undefined,
          direction: ctx.query.get('direction') ?? undefined,
        });
        sendList(ctx, list.map((i) => issueShape(repo, i)));
        return;
      }
      if (method === 'POST') {
        const b = bodyObj(parsed);
        if (!b || str(b.title).trim() === '') {
          fail(ctx, 422, 'Validation Failed');
          return;
        }
        const labels: string[] = Array.isArray(b.labels)
          ? (b.labels as unknown[]).map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name))).filter((s) => s !== '')
          : [];
        const unknown = labels.filter((l) => !repo.labels.has(l));
        if (unknown.length > 0) {
          fail(ctx, 422, `Validation Failed: label '${unknown[0]}' does not exist`, {
            errors: unknown.map((l) => ({ resource: 'Issue', field: 'labels', code: 'invalid', message: `label '${l}' does not exist` })),
          });
          return;
        }
        const issue = store.createIssue(repo, str(b.title), str(b.body), labels);
        send(ctx, 201, issueShape(repo, issue));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    // /issues/{n}...
    const n = Number(tail[1]);
    if (!Number.isInteger(n) || n < 1) {
      fail(ctx, 404, 'Not Found');
      return;
    }
    const issue = repo.issues.get(n);
    if (!issue) {
      fail(ctx, 404, 'Not Found');
      return;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        send(ctx, 200, issueShape(repo, issue));
        return;
      }
      if (method === 'PATCH' || method === 'PUT') {
        const b = bodyObj(parsed);
        if (b) {
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) {
            if (b.state === 'closed' && issue.state !== 'closed') {
              issue.state = 'closed';
              issue.closedAt = store.nextTimestamp();
            } else if (b.state === 'open') {
              issue.state = 'open';
              issue.closedAt = null;
            }
          }
          if (Array.isArray(b.labels)) {
            const labels = (b.labels as unknown[]).map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name))).filter((s) => s !== '');
            const unknown = labels.filter((l) => !repo.labels.has(l));
            if (unknown.length > 0) {
              fail(ctx, 422, `Validation Failed: label '${unknown[0]}' does not exist`);
              return;
            }
            issue.labels = [...labels];
            for (const l of labels) repo.labels.add(l);
          }
          issue.updatedAt = store.nextTimestamp();
        }
        send(ctx, 200, issueShape(repo, issue));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    // /issues/{n}/labels
    if (tail[2] === 'labels') {
      if (tail.length === 3) {
        if (method === 'GET') {
          send(ctx, 200, issue.labels.map((l) => labelShape(repo, l)));
          return;
        }
        if (method === 'POST') {
          const names: string[] = [];
          if (Array.isArray(parsed)) {
            for (const l of parsed as unknown[]) names.push(typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name));
          } else {
            const b = bodyObj(parsed);
            if (b) {
              if (Array.isArray(b.labels)) {
                for (const l of b.labels as unknown[]) names.push(typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name));
              } else if (typeof b.name === 'string') names.push(b.name);
            }
          }
          for (const name of names) {
            const clean = name.trim();
            if (clean === '') continue;
            repo.labels.add(clean);
            if (!issue.labels.includes(clean)) issue.labels.push(clean);
          }
          issue.updatedAt = store.nextTimestamp();
          send(ctx, 200, issue.labels.map((l) => labelShape(repo, l)));
          return;
        }
        if (method === 'DELETE') {
          issue.labels = [];
          send(ctx, 200, []);
          return;
        }
        fail(ctx, 404, 'Not Found');
        return;
      }
      if (tail.length === 4 && method === 'DELETE') {
        issue.labels = issue.labels.filter((l) => l !== tail[3]);
        send(ctx, 200, issue.labels.map((l) => labelShape(repo, l)));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    // /issues/{n}/comments
    if (tail[2] === 'comments' && tail.length === 3) {
      if (method === 'GET') {
        const comments = issue.commentIds
          .map((id) => repo.comments.get(id))
          .filter((c): c is Comment => c !== undefined)
          .map((c) => commentShape(c));
        sendList(ctx, comments);
        return;
      }
      if (method === 'POST') {
        const b = bodyObj(parsed);
        if (!b || typeof b.body !== 'string' || b.body === '') {
          fail(ctx, 422, 'Validation Failed');
          return;
        }
        const comment = store.addComment(repo, b.body);
        issue.commentIds.push(comment.id);
        send(ctx, 201, commentShape(comment));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  // ---- pulls ----
  if (head === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const list = store.listPulls(repo, state);
        sendList(ctx, list.map((p) => pullShape(repo, p)));
        return;
      }
      if (method === 'POST') {
        const b = bodyObj(parsed);
        if (!b || str(b.head) === '') {
          fail(ctx, 422, 'Validation Failed');
          return;
        }
        const base = str(b.base) !== '' ? str(b.base) : repo.defaultBranch;
        const result = store.createPull(repo, str(b.title), str(b.body), str(b.head), base);
        if ('error' in result) {
          fail(ctx, result.status, result.error);
          return;
        }
        send(ctx, 201, pullShape(repo, result));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    const n = Number(tail[1]);
    if (!Number.isInteger(n) || n < 1) {
      fail(ctx, 404, 'Not Found');
      return;
    }
    const pr = repo.pulls.get(n);
    if (!pr) {
      fail(ctx, 404, 'Not Found');
      return;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        send(ctx, 200, pullShape(repo, pr));
        return;
      }
      if (method === 'PATCH' || method === 'PUT') {
        const b = bodyObj(parsed);
        if (b) {
          if (typeof b.title === 'string') pr.title = b.title;
          if (typeof b.body === 'string') pr.body = b.body;
          if (b.state === 'closed' && pr.state === 'open') {
            pr.state = 'closed';
            pr.closedAt = store.nextTimestamp();
            pr.updatedAt = pr.closedAt;
          }
        }
        send(ctx, 200, pullShape(repo, pr));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    if (tail[2] === 'files' && tail.length === 3) {
      if (method !== 'GET') {
        fail(ctx, 404, 'Not Found');
        return;
      }
      const files = store.pullFiles(repo, pr).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.additions + f.deletions,
        sha: f.sha,
      }));
      send(ctx, 200, files);
      return;
    }
    if (tail[2] === 'merge' && tail.length === 3) {
      if (method !== 'PUT' && method !== 'POST') {
        fail(ctx, 404, 'Not Found');
        return;
      }
      const result = store.mergePull(repo, pr);
      if ('error' in result) {
        fail(ctx, result.status, result.error);
        return;
      }
      send(ctx, 200, {
        sha: result.sha,
        merged: true,
        message: `Pull request successfully merged`,
        merge_commit_sha: result.sha,
      });
      return;
    }
    if (tail[2] === 'comments' && tail.length === 3) {
      if (method === 'GET') {
        const comments = pr.commentIds
          .map((id) => repo.comments.get(id))
          .filter((c): c is Comment => c !== undefined)
          .map((c) => commentShape(c));
        sendList(ctx, comments);
        return;
      }
      if (method === 'POST') {
        const b = bodyObj(parsed);
        if (!b || typeof b.body !== 'string' || b.body === '') {
          fail(ctx, 422, 'Validation Failed');
          return;
        }
        const comment = store.addComment(repo, b.body);
        pr.commentIds.push(comment.id);
        send(ctx, 201, commentShape(comment));
        return;
      }
      fail(ctx, 404, 'Not Found');
      return;
    }
    if (tail[2] === 'commits' && tail.length === 3 && method === 'GET') {
      const chain = store.commitChain(repo, pr.headSha);
      const items: Record<string, unknown>[] = [];
      for (const sha of chain) {
        if (sha === pr.baseSha) break;
        const shape = commitShape(sha, repo);
        if (shape) items.push(shape);
      }
      send(ctx, 200, items);
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  fail(ctx, 404, 'Not Found');
}
