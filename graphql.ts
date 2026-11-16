// GraphQL v4 surface (POST /api/v3/graphql) — single-file implementation.
//
// Mini GraphQL engine written from scratch (Node 22 stdlib only):
// tokenizer + recursive-descent parser + executor over the shared store.
// No Date.now() / Math.random(); timestamps come from store.nextTimestamp()
// only via the store's own create/merge paths.
//
// Supported: query/mutation operations, aliases, named fragments, inline
// fragments, variables (+ defaults), @skip/@include, batched operation
// arrays, __type introspection, node(id:), Relay-style cursor pagination.
import { sendJson, parseJson } from './app.ts';
import type { Ctx } from './app.ts';
import { store, encodeGlobalId, decodeGlobalId, FIXED_ISO } from './store.ts';
import type { Repo, Issue, Pull, Comment, FileChange } from './store.ts';
import { VIEWER } from './scenario.ts';

// ============================================================================
// Tokenizer
// ============================================================================

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
interface Tok { kind: TokKind; value: string; }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      // Block string """...""" or normal "..." with escapes.
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error('Unterminated block string');
        toks.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === undefined) throw new Error('Unterminated string');
          if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            out += map[e] ?? e;
            j += 2;
          }
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= n) throw new Error('Unterminated string');
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      if (j >= n || !(src[j] >= '0' && src[j] <= '9')) throw new Error(`Unexpected character: ${c}`);
      while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j += 1; while (j < n && src[j] >= '0' && src[j] <= '9') j += 1; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (j < n && ((src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= 'a' && src[j] <= 'z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '_')) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { toks.push({ kind: 'punct', value: c }); i += 1; continue; }
    throw new Error(`Unexpected character: ${c}`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ============================================================================
// Parser (AST)
// ============================================================================

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface Directive { name: string; args: { name: string; value: ValueNode }[]; }
interface FieldSel {
  kind: 'field'; name: string; alias: string | null;
  args: { name: string; value: ValueNode }[]; directives: Directive[];
  selections: Selection[] | null;
}
interface SpreadSel { kind: 'spread'; name: string; directives: Directive[]; }
interface InlineSel { kind: 'inline'; typeCondition: string | null; directives: Directive[]; selections: Selection[]; }
type Selection = FieldSel | SpreadSel | InlineSel;

interface VarDef { name: string; type: string; defaultValue: ValueNode | null; }
interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null; varDefs: VarDef[]; selections: Selection[];
}
interface FragmentDef { name: string; typeCondition: string; selections: Selection[]; }
interface Document { operations: Operation[]; fragments: Map<string, FragmentDef>; }

class Parser {
  toks: Tok[];
  pos = 0;
  constructor(toks: Tok[]) { this.toks = toks; }

  peek(): Tok { return this.toks[this.pos]; }
  next(): Tok { const t = this.toks[this.pos]; this.pos += 1; return t; }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`Expected '${v}' but got '${t.value}'`);
  }
  matchPunct(v: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === v) { this.pos += 1; return true; }
    return false;
  }
  expectName(what = 'name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected ${what} but got '${t.value}'`);
    return t.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
      } else if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        const frag = this.parseFragment();
        fragments.set(frag.name, frag);
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  parseOperation(): Operation {
    const kw = this.expectName('operation');
    if (kw !== 'query' && kw !== 'mutation' && kw !== 'subscription') {
      throw new Error(`Unknown operation type '${kw}'`);
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    let varDefs: VarDef[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') varDefs = this.parseVarDefs();
    const selections = this.parseSelectionSet();
    return { kind: kw, name, varDefs, selections };
  }

  parseVarDefs(): VarDef[] {
    this.expectPunct('(');
    const defs: VarDef[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName('variable');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue(true);
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  parseType(): string {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let s = `[${inner}]`;
      if (this.matchPunct('!')) s += '!';
      return s;
    }
    const name = this.expectName('type');
    let s = name;
    if (this.matchPunct('!')) s += '!';
    return s;
  }

  parseFragment(): FragmentDef {
    this.expectName('fragment');
    const name = this.expectName('fragment name');
    const onKw = this.expectName("'on'");
    if (onKw !== 'on') throw new Error(`Expected 'on' in fragment definition`);
    const typeCondition = this.expectName('type condition');
    const selections = this.parseSelectionSet();
    return { name, typeCondition, selections };
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  parseSelection(): Selection {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('type condition');
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selections: this.parseSelectionSet() };
    }
    // Field: [alias ':'] name [args] [directives] [selectionSet]
    const first = this.expectName('field');
    let name = first;
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName('field');
    }
    const args = this.parseArgs();
    const directives = this.parseDirectives();
    let selections: Selection[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, directives, selections };
  }

  parseArgs(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return args;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName('argument');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  parseDirectives(): Directive[] {
    const dirs: Directive[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName('directive');
      const args = this.parseArgs();
      dirs.push({ name, args });
    }
    return dirs;
  }

  parseValue(isConst: boolean): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new Error('Variable in constant value');
      return { kind: 'variable', name: this.expectName('variable') };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName('object field');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value token '${t.value}'`);
  }
}

// ============================================================================
// Introspection tables
// ============================================================================

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'author', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeCommit', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'comments'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issues', 'pullRequests', 'issue', 'pullRequest', 'url', 'createdAt', 'description', 'isPrivate'],
  User: ['id', 'login', 'name', 'repositories'],
  Viewer: ['id', 'login', 'name', 'repositories'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Label: ['id', 'name', 'color', 'description'],
  Ref: ['id', 'name'],
  Commit: ['oid', 'abbreviatedOid'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  RepositoryConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  RepositoryEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType', 'description'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeKind(name: string): string {
  if (TYPE_ENUM_VALUES[name]) return 'ENUM';
  if (name === 'Query' || name === 'Mutation') return 'OBJECT';
  return 'OBJECT';
}

// ============================================================================
// Execution
// ============================================================================

type GqlValue = unknown;
interface Wrapper { __gql: string; [key: string]: GqlValue; }
interface CtxExec {
  vars: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: { message: string; path?: (string | number)[] }[];
}

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return vars[node.name];
    case 'string': case 'int': case 'float': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((v) => evalValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, vars);
      return out;
    }
  }
}

function evalArgs(args: { name: string; value: ValueNode }[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = evalValue(a.value, vars);
  return out;
}

function directivesAllow(dirs: Directive[], vars: Record<string, unknown>): boolean {
  for (const d of dirs) {
    const a = evalArgs(d.args, vars);
    if (d.name === 'skip' && a.if === true) return false;
    if (d.name === 'include' && a.if === false) return false;
  }
  return true;
}

function encodeCursor(key: string | number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64url');
}
function decodeCursor(after: unknown): string | null {
  if (typeof after !== 'string' || after.length === 0) return null;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    return text.slice('cursor:'.length);
  } catch {
    return null;
  }
}

interface PageInfoOut { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null; }

function paginate<T>(items: T[], first: unknown, after: unknown, keyFn: (item: T, idx: number) => string | number): { items: T[]; totalCount: number; pageInfo: PageInfoOut; cursors: (string | null)[] } {
  const totalCount = items.length;
  let start = 0;
  const afterKey = decodeCursor(after);
  if (afterKey !== null) {
    const idx = items.findIndex((it, i) => String(keyFn(it, i)) === afterKey);
    start = idx === -1 ? items.length : idx + 1;
  }
  let page = items.slice(start);
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : null;
  if (limit !== null) page = page.slice(0, limit);
  const hasNextPage = start + page.length < totalCount;
  const cursors = page.map((it, k) => encodeCursor(keyFn(it, start + k)));
  return {
    items: page,
    totalCount,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: cursors.length > 0 ? cursors[0] : null,
      endCursor: cursors.length > 0 ? cursors[cursors.length - 1] : null,
    },
    cursors,
  };
}

function connWrapper(connType: string, edgeType: string, items: Wrapper[], first: unknown, after: unknown, keyFn: (item: Wrapper, idx: number) => string | number): Wrapper {
  const p = paginate(items, first, after, keyFn);
  const edges: Wrapper[] = p.items.map((node, k) => ({ __gql: edgeType, node, cursor: p.cursors[k] }));
  return {
    __gql: connType,
    __items: p.items,
    __edges: edges,
    __totalCount: p.totalCount,
    __pageInfo: { __gql: 'PageInfo', ...p.pageInfo },
  };
}

function userWrapper(login: string): Wrapper {
  return { __gql: 'User', login };
}
function repoWrapper(repo: Repo): Wrapper {
  return { __gql: 'Repository', repo };
}
function issueWrapper(repo: Repo, issue: Issue): Wrapper {
  return { __gql: 'Issue', repo, issue };
}
function prWrapper(repo: Repo, pr: Pull): Wrapper {
  return { __gql: 'PullRequest', repo, pr };
}
function commentWrapper(repo: Repo, comment: Comment): Wrapper {
  return { __gql: 'IssueComment', repo, comment };
}

function findRepoByGlobalId(id: string): Repo | null {
  const dec = decodeGlobalId(id);
  if (!dec || dec.kind !== 'repo' || dec.parts.length < 2) return null;
  return store.getRepo(dec.parts[0], dec.parts[1]) ?? null;
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const dec = decodeGlobalId(id);
  if (!dec || dec.kind !== 'issue' || dec.parts.length < 3) return null;
  const repo = store.getRepo(dec.parts[0], dec.parts[1]);
  if (!repo) return null;
  const issue = store.getIssue(repo, parseInt(dec.parts[2], 10));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(id: string): { repo: Repo; pr: Pull } | null {
  const dec = decodeGlobalId(id);
  if (!dec || dec.kind !== 'pr' || dec.parts.length < 3) return null;
  const repo = store.getRepo(dec.parts[0], dec.parts[1]);
  if (!repo) return null;
  const pr = store.getPull(repo, parseInt(dec.parts[2], 10));
  return pr ? { repo, pr } : null;
}

function issueStateGql(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}
function prStateGql(pr: Pull): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}
function issueUrl(repo: Repo, issue: Issue): string {
  return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
}
function prUrl(repo: Repo, pr: Pull): string {
  return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`;
}

interface Resolved { value: GqlValue; childType: string | null; }

function resolveField(parent: Wrapper, field: string, args: Record<string, unknown>, ctx: CtxExec, path: (string | number)[]): Resolved {
  const t = parent.__gql;
  const nullRes: Resolved = { value: null, childType: null };

  // ---- Query root ----
  if (t === 'Query') {
    if (field === 'viewer') return { value: { __gql: 'Viewer', login: VIEWER.login }, childType: 'Viewer' };
    if (field === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return { value: null, childType: 'Repository' };
      return { value: repoWrapper(repo), childType: 'Repository' };
    }
    if (field === 'node') {
      const id = String(args.id ?? '');
      const dec = decodeGlobalId(id);
      if (!dec) {
        ctx.errors.push({ message: `Could not resolve to a node with the global id of '${id}'`, path: [...path, 'node'] });
        return { value: null, childType: null };
      }
      if (dec.kind === 'repo' && dec.parts.length >= 2) {
        const repo = store.getRepo(dec.parts[0], dec.parts[1]);
        if (repo) return { value: repoWrapper(repo), childType: 'Repository' };
      } else if (dec.kind === 'issue' && dec.parts.length >= 3) {
        const found = findIssueByGlobalId(id);
        if (found) return { value: issueWrapper(found.repo, found.issue), childType: 'Issue' };
      } else if (dec.kind === 'pr' && dec.parts.length >= 3) {
        const found = findPullByGlobalId(id);
        if (found) return { value: prWrapper(found.repo, found.pr), childType: 'PullRequest' };
      } else if (dec.kind === 'user' && dec.parts.length >= 1) {
        return { value: userWrapper(dec.parts[0]), childType: 'User' };
      } else if (dec.kind === 'comment' && dec.parts.length >= 1) {
        const cid = parseInt(dec.parts[0], 10);
        for (const repo of store.repos.values()) {
          const c = repo.comments.get(cid);
          if (c) return { value: commentWrapper(repo, c), childType: 'IssueComment' };
        }
      }
      ctx.errors.push({ message: `Could not resolve to a node with the global id of '${id}'`, path: [...path, 'node'] });
      return { value: null, childType: null };
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] || TYPE_ENUM_VALUES[name]) {
        const fields = TYPE_FIELDS[name]
          ? TYPE_FIELDS[name].map((n) => ({ __gql: '__Field', name: n, description: null }))
          : null;
        const enumValues = TYPE_ENUM_VALUES[name]
          ? TYPE_ENUM_VALUES[name].map((n) => ({ __gql: '__EnumValue', name: n, description: null }))
          : null;
        return { value: { __gql: '__Type', name, kind: typeKind(name), description: null, __fields: fields, __enumValues: enumValues }, childType: '__Type' };
      }
      return { value: null, childType: '__Type' };
    }
    if (field === '__schema') {
      const types = [...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUM_VALUES)].map((n) => {
        const fields = TYPE_FIELDS[n] ? TYPE_FIELDS[n].map((f) => ({ __gql: '__Field', name: f, description: null })) : null;
        const enumValues = TYPE_ENUM_VALUES[n] ? TYPE_ENUM_VALUES[n].map((f) => ({ __gql: '__EnumValue', name: f, description: null })) : null;
        return { __gql: '__Type', name: n, kind: typeKind(n), description: null, __fields: fields, __enumValues: enumValues };
      });
      return {
        value: { __gql: '__Schema', description: null, __types: types, queryType: { __gql: '__Type', name: 'Query', kind: 'OBJECT', description: null, __fields: null, __enumValues: null }, mutationType: { __gql: '__Type', name: 'Mutation', kind: 'OBJECT', description: null, __fields: null, __enumValues: null } },
        childType: '__Schema',
      };
    }
  }

  // ---- Mutation root ----
  if (t === 'Mutation') {
    if (field === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a repository with the provided repositoryId', path: [...path, 'createIssue'] });
        return { value: null, childType: 'CreateIssuePayload' };
      }
      if (typeof input.title !== 'string' || input.title.length === 0) {
        ctx.errors.push({ message: 'createIssue requires a title', path: [...path, 'createIssue'] });
        return { value: null, childType: 'CreateIssuePayload' };
      }
      const issue = store.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
      return { value: { __gql: 'CreateIssuePayload', issue: issueWrapper(repo, issue), clientMutationId: (input.clientMutationId as string | null) ?? null }, childType: 'CreateIssuePayload' };
    }
    if (field === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(input.issueId) : null;
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an issue with the provided issueId', path: [...path, 'closeIssue'] });
        return { value: null, childType: 'CloseIssuePayload' };
      }
      const ts = store.nextTimestamp();
      found.issue.state = 'closed';
      found.issue.closedAt = ts;
      found.issue.updatedAt = ts;
      return { value: { __gql: 'CloseIssuePayload', issue: issueWrapper(found.repo, found.issue), clientMutationId: (input.clientMutationId as string | null) ?? null }, childType: 'CloseIssuePayload' };
    }
    if (field === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a repository with the provided repositoryId', path: [...path, 'createPullRequest'] });
        return { value: null, childType: 'CreatePullRequestPayload' };
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const result = store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
      if ('error' in result) {
        ctx.errors.push({ message: result.error, path: [...path, 'createPullRequest'] });
        return { value: null, childType: 'CreatePullRequestPayload' };
      }
      return { value: { __gql: 'CreatePullRequestPayload', pullRequest: prWrapper(repo, result), clientMutationId: (input.clientMutationId as string | null) ?? null }, childType: 'CreatePullRequestPayload' };
    }
    if (field === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(input.pullRequestId) : null;
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to a pull request with the provided pullRequestId', path: [...path, 'mergePullRequest'] });
        return { value: null, childType: 'MergePullRequestPayload' };
      }
      const result = store.mergePull(found.repo, found.pr);
      if ('error' in result) {
        ctx.errors.push({ message: result.error, path: [...path, 'mergePullRequest'] });
        return { value: null, childType: 'MergePullRequestPayload' };
      }
      return { value: { __gql: 'MergePullRequestPayload', pullRequest: prWrapper(found.repo, found.pr), clientMutationId: (input.clientMutationId as string | null) ?? null }, childType: 'MergePullRequestPayload' };
    }
    if (field === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const dec = decodeGlobalId(subjectId);
      let repo: Repo | null = null;
      let target: Issue | Pull | null = null;
      if (dec && dec.kind === 'issue' && dec.parts.length >= 3) {
        const found = findIssueByGlobalId(subjectId);
        if (found) { repo = found.repo; target = found.issue; }
      } else if (dec && dec.kind === 'pr' && dec.parts.length >= 3) {
        const found = findPullByGlobalId(subjectId);
        if (found) { repo = found.repo; target = found.pr; }
      }
      if (!repo || !target) {
        ctx.errors.push({ message: 'Could not resolve to a subject with the provided subjectId', path: [...path, 'addComment'] });
        return { value: null, childType: 'AddCommentPayload' };
      }
      const comment = store.addComment(repo, body);
      target.commentIds.push(comment.id);
      const edge: Wrapper = { __gql: 'IssueCommentEdge', node: commentWrapper(repo, comment), cursor: null };
      return { value: { __gql: 'AddCommentPayload', commentEdge: edge, clientMutationId: (input.clientMutationId as string | null) ?? null }, childType: 'AddCommentPayload' };
    }
  }

  // ---- Viewer / User ----
  if (t === 'Viewer' || t === 'User') {
    const login = String(parent.login ?? '');
    if (field === 'login') return { value: login, childType: null };
    if (field === 'id') return { value: encodeGlobalId('user', login), childType: null };
    if (field === 'name') return { value: login, childType: null };
    if (field === 'repositories') {
      const repos = store.listRepos(login).map((r) => repoWrapper(r));
      return { value: connWrapper('RepositoryConnection', 'RepositoryEdge', repos, args.first, args.after, (w) => (w.repo as Repo).id), childType: 'RepositoryConnection' };
    }
  }

  // ---- Repository ----
  if (t === 'Repository') {
    const repo = parent.repo as Repo;
    switch (field) {
      case 'id': return { value: encodeGlobalId('repo', repo.owner, repo.name), childType: null };
      case 'databaseId': return { value: repo.id, childType: null };
      case 'name': return { value: repo.name, childType: null };
      case 'nameWithOwner': return { value: repo.fullName, childType: null };
      case 'owner': return { value: userWrapper(repo.owner), childType: 'User' };
      case 'defaultBranchRef': return { value: { __gql: 'Ref', name: repo.defaultBranch }, childType: 'Ref' };
      case 'viewerPermission': return { value: 'ADMIN', childType: null };
      case 'hasIssuesEnabled': return { value: true, childType: null };
      case 'url': return { value: `https://example.invalid/${repo.owner}/${repo.name}`, childType: null };
      case 'createdAt': return { value: FIXED_ISO, childType: null };
      case 'description': return { value: repo.description, childType: null };
      case 'isPrivate': return { value: repo.private, childType: null };
      case 'issue': {
        const issue = store.getIssue(repo, Number(args.number));
        if (!issue) return { value: null, childType: 'Issue' };
        return { value: issueWrapper(repo, issue), childType: 'Issue' };
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
        const fieldName = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
        const dir = direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => {
          let cmp = 0;
          if (fieldName === 'COMMENTS') cmp = a.commentIds.length - b.commentIds.length;
          else cmp = a.createdSeq - b.createdSeq;
          if (cmp === 0) cmp = a.number - b.number;
          return dir * cmp;
        });
        const items = list.map((i) => issueWrapper(repo, i));
        return { value: connWrapper('IssueConnection', 'IssueEdge', items, args.first, args.after, (w) => (w.issue as Issue).number), childType: 'IssueConnection' };
      }
      case 'pullRequests': {
        let list = store.listPulls(repo);
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((p) => wanted.has(prStateGql(p)));
        }
        const items = list.map((p) => prWrapper(repo, p));
        return { value: connWrapper('PullRequestConnection', 'PullRequestEdge', items, args.first, args.after, (w) => (w.pr as Pull).number), childType: 'PullRequestConnection' };
      }
      case 'pullRequest': {
        const pr = store.getPull(repo, Number(args.number));
        if (!pr) return { value: null, childType: 'PullRequest' };
        return { value: prWrapper(repo, pr), childType: 'PullRequest' };
      }
    }
  }

  // ---- Issue ----
  if (t === 'Issue') {
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    switch (field) {
      case 'id': return { value: encodeGlobalId('issue', repo.owner, repo.name, issue.number), childType: null };
      case 'number': return { value: issue.number, childType: null };
      case 'title': return { value: issue.title, childType: null };
      case 'body': return { value: issue.body, childType: null };
      case 'state': return { value: issueStateGql(issue), childType: null };
      case 'url': return { value: issueUrl(repo, issue), childType: null };
      case 'createdAt': return { value: issue.createdAt, childType: null };
      case 'updatedAt': return { value: issue.updatedAt, childType: null };
      case 'closedAt': return { value: issue.closedAt, childType: null };
      case 'author': return { value: userWrapper(issue.user), childType: 'User' };
      case 'repository': return { value: repoWrapper(repo), childType: 'Repository' };
      case 'labels': {
        const items = issue.labels.map((name) => ({ __gql: 'Label', name }));
        return { value: connWrapper('LabelConnection', 'LabelEdge', items, args.first, args.after, (_w, idx) => idx), childType: 'LabelConnection' };
      }
      case 'comments': {
        const comments = issue.commentIds
          .map((id) => repo.comments.get(id))
          .filter((c): c is Comment => c !== undefined)
          .map((c) => commentWrapper(repo, c));
        return { value: connWrapper('CommentConnection', 'CommentEdge', comments, args.first, args.after, (w) => (w.comment as Comment).id), childType: 'CommentConnection' };
      }
    }
  }

  // ---- PullRequest ----
  if (t === 'PullRequest') {
    const repo = parent.repo as Repo;
    const pr = parent.pr as Pull;
    switch (field) {
      case 'id': return { value: encodeGlobalId('pr', repo.owner, repo.name, pr.number), childType: null };
      case 'number': return { value: pr.number, childType: null };
      case 'title': return { value: pr.title, childType: null };
      case 'body': return { value: pr.body, childType: null };
      case 'state': return { value: prStateGql(pr), childType: null };
      case 'merged': return { value: pr.merged, childType: null };
      case 'mergeable': return { value: store.isMergeConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE', childType: null };
      case 'headRefName': return { value: pr.headRef, childType: null };
      case 'baseRefName': return { value: pr.baseRef, childType: null };
      case 'headRefOid': return { value: pr.headSha, childType: null };
      case 'baseRefOid': return { value: pr.baseSha, childType: null };
      case 'mergeCommit': return pr.mergeCommitSha ? { value: { __gql: 'Commit', oid: pr.mergeCommitSha }, childType: 'Commit' } : nullRes;
      case 'author': return { value: userWrapper(pr.user), childType: 'User' };
      case 'repository': return { value: repoWrapper(repo), childType: 'Repository' };
      case 'url': return { value: prUrl(repo, pr), childType: null };
      case 'createdAt': return { value: pr.createdAt, childType: null };
      case 'updatedAt': return { value: pr.updatedAt, childType: null };
      case 'closedAt': return { value: pr.closedAt, childType: null };
      case 'files': {
        const files = store.pullFiles(repo, pr).map((f: FileChange) => ({
          __gql: 'PullRequestChangedFile',
          path: f.filename,
          additions: f.additions,
          deletions: f.deletions,
          changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        }));
        return { value: connWrapper('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', files, args.first, args.after, (_w, idx) => idx), childType: 'PullRequestChangedFileConnection' };
      }
      case 'comments': {
        const comments = pr.commentIds
          .map((id) => repo.comments.get(id))
          .filter((c): c is Comment => c !== undefined)
          .map((c) => commentWrapper(repo, c));
        return { value: connWrapper('CommentConnection', 'CommentEdge', comments, args.first, args.after, (w) => (w.comment as Comment).id), childType: 'CommentConnection' };
      }
    }
  }

  // ---- IssueComment ----
  if (t === 'IssueComment') {
    const comment = parent.comment as Comment;
    switch (field) {
      case 'id': return { value: encodeGlobalId('comment', comment.id), childType: null };
      case 'body': return { value: comment.body, childType: null };
      case 'author': return { value: userWrapper(comment.user), childType: 'User' };
      case 'createdAt': return { value: comment.createdAt, childType: null };
    }
  }

  // ---- Label / Ref / Commit / File ----
  if (t === 'Label') {
    if (field === 'name') return { value: String(parent.name ?? ''), childType: null };
    if (field === 'id') return { value: encodeGlobalId('label', String(parent.name ?? '')), childType: null };
    if (field === 'color' || field === 'description') return nullRes;
  }
  if (t === 'Ref') {
    if (field === 'name') return { value: String(parent.name ?? ''), childType: null };
    if (field === 'id') return { value: encodeGlobalId('ref', String(parent.name ?? '')), childType: null };
  }
  if (t === 'Commit') {
    if (field === 'oid') return { value: String(parent.oid ?? ''), childType: null };
    if (field === 'abbreviatedOid') return { value: String(parent.oid ?? '').slice(0, 7), childType: null };
  }
  if (t === 'PullRequestChangedFile') {
    if (field === 'path') return { value: String(parent.path ?? ''), childType: null };
    if (field === 'additions') return { value: Number(parent.additions ?? 0), childType: null };
    if (field === 'deletions') return { value: Number(parent.deletions ?? 0), childType: null };
    if (field === 'changeType') return { value: String(parent.changeType ?? 'MODIFIED'), childType: null };
  }

  // ---- Connections ----
  if (t.endsWith('Connection')) {
    if (field === 'nodes') {
      const items = (parent.__items as Wrapper[] | undefined) ?? [];
      const itemType = t.replace('Connection', '');
      return { value: items, childType: itemType };
    }
    if (field === 'edges') {
      const edges = (parent.__edges as Wrapper[] | undefined) ?? [];
      return { value: edges, childType: `${t.replace('Connection', '')}Edge` };
    }
    if (field === 'pageInfo') return { value: parent.__pageInfo as Wrapper, childType: 'PageInfo' };
    if (field === 'totalCount') return { value: Number(parent.__totalCount ?? 0), childType: null };
  }

  // ---- Edges ----
  if (t.endsWith('Edge')) {
    if (field === 'node') {
      const node = parent.node as Wrapper;
      return { value: node, childType: node?.__gql ?? null };
    }
    if (field === 'cursor') return { value: (parent.cursor as string | null) ?? null, childType: null };
  }

  // ---- PageInfo ----
  if (t === 'PageInfo') {
    if (field === 'hasNextPage') return { value: Boolean(parent.hasNextPage), childType: null };
    if (field === 'hasPreviousPage') return { value: Boolean(parent.hasPreviousPage), childType: null };
    if (field === 'startCursor') return { value: (parent.startCursor as string | null) ?? null, childType: null };
    if (field === 'endCursor') return { value: (parent.endCursor as string | null) ?? null, childType: null };
  }

  // ---- Payloads ----
  if (t === 'CreateIssuePayload' || t === 'CloseIssuePayload') {
    if (field === 'issue') {
      const issue = parent.issue as Wrapper | undefined;
      return { value: issue ?? null, childType: 'Issue' };
    }
    if (field === 'clientMutationId') return { value: (parent.clientMutationId as string | null) ?? null, childType: null };
  }
  if (t === 'CreatePullRequestPayload' || t === 'MergePullRequestPayload') {
    if (field === 'pullRequest') {
      const pr = parent.pullRequest as Wrapper | undefined;
      return { value: pr ?? null, childType: 'PullRequest' };
    }
    if (field === 'clientMutationId') return { value: (parent.clientMutationId as string | null) ?? null, childType: null };
  }
  if (t === 'AddCommentPayload') {
    if (field === 'commentEdge') {
      const edge = parent.commentEdge as Wrapper | undefined;
      return { value: edge ?? null, childType: 'IssueCommentEdge' };
    }
    if (field === 'clientMutationId') return { value: (parent.clientMutationId as string | null) ?? null, childType: null };
  }

  // ---- Introspection types ----
  if (t === '__Type') {
    if (field === 'name') return { value: String(parent.name ?? ''), childType: null };
    if (field === 'kind') return { value: String(parent.kind ?? 'OBJECT'), childType: null };
    if (field === 'description') return { value: (parent.description as string | null) ?? null, childType: null };
    if (field === 'fields') {
      const fields = (parent.__fields as Wrapper[] | null | undefined) ?? null;
      return { value: fields, childType: '__Field' };
    }
    if (field === 'enumValues') {
      const vals = (parent.__enumValues as Wrapper[] | null | undefined) ?? null;
      return { value: vals, childType: '__EnumValue' };
    }
  }
  if (t === '__Field') {
    if (field === 'name') return { value: String(parent.name ?? ''), childType: null };
    if (field === 'description') return { value: null, childType: null };
    if (field === 'type') return { value: { __gql: '__Type', name: 'String', kind: 'SCALAR', description: null, __fields: null, __enumValues: null }, childType: '__Type' };
  }
  if (t === '__EnumValue') {
    if (field === 'name') return { value: String(parent.name ?? ''), childType: null };
    if (field === 'description') return { value: null, childType: null };
  }
  if (t === '__Schema') {
    if (field === 'types') return { value: (parent.__types as Wrapper[] | undefined) ?? [], childType: '__Type' };
    if (field === 'queryType') return { value: parent.queryType as Wrapper, childType: '__Type' };
    if (field === 'mutationType') return { value: parent.mutationType as Wrapper, childType: '__Type' };
    if (field === 'description') return { value: null, childType: null };
  }

  return nullRes;
}

function isWrapper(v: GqlValue): v is Wrapper {
  return typeof v === 'object' && v !== null && typeof (v as Wrapper).__gql === 'string';
}

function executeSelections(parentType: string, parent: Wrapper, selections: Selection[], ctx: CtxExec, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      if (!directivesAllow(sel.directives, ctx.vars)) continue;
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}"`, path });
        continue;
      }
      if (frag.typeCondition !== 'Node' && frag.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(parentType, parent, frag.selections, ctx, path));
      continue;
    }
    if (sel.kind === 'inline') {
      if (!directivesAllow(sel.directives, ctx.vars)) continue;
      if (sel.typeCondition !== null && sel.typeCondition !== 'Node' && sel.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(parentType, parent, sel.selections, ctx, path));
      continue;
    }
    // Field
    if (!directivesAllow(sel.directives, ctx.vars)) continue;
    const responseKey = sel.alias ?? sel.name;
    const fieldPath = [...path, responseKey];
    if (sel.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const allowed = TYPE_FIELDS[parentType];
    if (!allowed || !allowed.includes(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}"`, path: fieldPath });
      continue;
    }
    const args = evalArgs(sel.args, ctx.vars);
    const resolved = resolveField(parent, sel.name, args, ctx, path);
    if (resolved.value === null || resolved.value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (sel.selections && resolved.childType) {
      if (Array.isArray(resolved.value)) {
        out[responseKey] = (resolved.value as GqlValue[]).map((item, idx) => {
          if (item === null || item === undefined) return null;
          if (!isWrapper(item)) return item;
          return executeSelections(resolved.childType as string, item, sel.selections as Selection[], ctx, [...fieldPath, idx]);
        });
      } else if (isWrapper(resolved.value)) {
        out[responseKey] = executeSelections(resolved.childType, resolved.value, sel.selections, ctx, fieldPath);
      } else {
        out[responseKey] = resolved.value;
      }
    } else {
      out[responseKey] = resolved.value;
    }
  }
  return out;
}

function executeOperation(op: unknown): Record<string, unknown> {
  if (typeof op !== 'object' || op === null || Array.isArray(op)) {
    return { data: null, errors: [{ message: 'GraphQL operation must be a JSON object with a query string' }] };
  }
  const body = op as Record<string, unknown>;
  const query = body.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { data: null, errors: [{ message: 'GraphQL query is required' }] };
  }
  const variables = (body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables))
    ? (body.variables as Record<string, unknown>)
    : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;

  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'GraphQL query is required' }] };
  }
  let operation: Operation | undefined;
  if (operationName !== null) {
    operation = doc.operations.find((o) => o.name === operationName);
    if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations' }] };
  }
  if (operation.kind === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported' }] };
  }

  const vars: Record<string, unknown> = {};
  for (const def of operation.varDefs) {
    if (def.defaultValue !== null) vars[def.name] = evalValue(def.defaultValue, {});
  }
  for (const [k, v] of Object.entries(variables)) vars[k] = v;

  const ctx: CtxExec = { vars, fragments: doc.fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: Wrapper = { __gql: rootType };
  const data = executeSelections(rootType, root, operation.selections, ctx, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ============================================================================
// HTTP handler
// ============================================================================

export async function handleGraphql(ctx: Ctx): Promise<void> {
  if (ctx.method !== 'POST') {
    sendJson(ctx.res, 405, { errors: [{ message: 'Method not allowed' }] });
    return;
  }
  const parsed = parseJson(ctx.body);
  if (parsed === null) {
    sendJson(ctx.res, 400, { errors: [{ message: 'Request body must be valid JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      sendJson(ctx.res, 400, { errors: [{ message: 'Batch must contain at least one operation' }] });
      return;
    }
    sendJson(ctx.res, 200, parsed.map((op) => executeOperation(op)));
    return;
  }
  if (typeof parsed !== 'object') {
    sendJson(ctx.res, 400, { errors: [{ message: 'Request body must be a JSON object or an array of operations' }] });
    return;
  }
  const query = (parsed as Record<string, unknown>).query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    sendJson(ctx.res, 400, { errors: [{ message: 'GraphQL query is required' }] });
    return;
  }
  sendJson(ctx.res, 200, executeOperation(parsed));
}
