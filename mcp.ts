// MCP surface: JSON-RPC 2.0 over Streamable HTTP, POST /api/v3/mcp.
// Single store shared with REST/GraphQL, so every MCP tool result is the
// same object REST reads back. Deterministic: no Date.now(), no Math.random().
import type { Ctx } from './app.ts';
import { sendJson } from './app.ts';
import { store } from './store.ts';
import { VIEWER } from './scenario.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type JsonRpcId = string | number | null;
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function rpcError(id: JsonRpcId, code: number, message: string): RecordValue {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: JsonRpcId, result: unknown): RecordValue {
  return { jsonrpc: '2.0', id, result };
}

/** A successful tool result: text is JSON.stringify(structuredContent). */
function toolOk(structured: RecordValue): RecordValue {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** A failed tool call: HTTP 200, JSON-RPC result with isError:true. */
function toolError(text: string): RecordValue {
  return { content: [{ type: 'text', text }], isError: true };
}

interface ToolInputSchema {
  type: 'object';
  properties: Record<string, RecordValue>;
  required: string[];
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

// One literal, never rebuilt or mutated: two tools/list calls serialise
// byte-identical, and the order is the canonical order.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the given owner (defaults to the viewer).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function missingRequired(tool: ToolDef, args: RecordValue): string | null {
  for (const key of tool.inputSchema.required) {
    if (args[key] === undefined) return key;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Dispatch one tools/call. Returns a tool result, or a JSON-RPC error envelope. */
function callTool(name: string, args: RecordValue): RecordValue {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return rpcError(null, -32602, `Unknown tool: ${name}`);
  const missing = missingRequired(tool, args);
  if (missing !== null) return toolError(`Missing required argument: ${missing}`);

  switch (name) {
    case 'create_repo': {
      const owner = asString(args.owner) !== '' ? asString(args.owner) : VIEWER.login;
      const repoName = asString(args.name);
      const repo = store.createRepo(owner, repoName, asString(args.description), args.private === true);
      if (repo === null) return toolError('Repository already exists');
      return toolOk({
        full_name: repo.fullName, name: repo.name, owner: repo.owner,
        description: repo.description, private: repo.private,
      });
    }
    case 'get_repo': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return toolError('Repository not found');
      return toolOk({
        full_name: repo.fullName, name: repo.name, owner: repo.owner,
        description: repo.description, private: repo.private,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return toolError('Repository not found');
      const labels = Array.isArray(args.labels)
        ? args.labels.filter((l): l is string => typeof l === 'string')
        : [];
      const issue = store.createIssue(repo, asString(args.title), asString(args.body), labels);
      return toolOk({
        number: issue.number, id: issue.id, title: issue.title,
        state: 'open', body: issue.body,
      });
    }
    case 'list_issues': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return toolError('Repository not found');
      const state = asString(args.state) !== '' ? asString(args.state) : 'all';
      const issues = store.listIssues(repo, { state });
      return toolOk({
        issues: issues.map((i) => ({
          number: i.number, title: i.title, state: i.state, body: i.body,
        })),
      });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return toolError('Repository not found');
      const pr = store.createPull(
        repo, asString(args.title), asString(args.body),
        asString(args.head), asString(args.base),
      );
      if ('error' in pr) return toolError(pr.error);
      return toolOk({
        number: pr.number, id: pr.id, title: pr.title, state: 'open',
        head: { ref: pr.headRef }, base: { ref: pr.baseRef },
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return toolError('Repository not found');
      const pullNumber = Number(args.pull_number);
      const pr = store.getPull(repo, pullNumber);
      if (!pr) return toolError('Pull request not found');
      const merged = store.mergePull(repo, pr);
      if ('error' in merged) return toolError(merged.error);
      return toolOk({ merged: true, merge_commit_sha: merged.sha });
    }
    default:
      return rpcError(null, -32602, `Unknown tool: ${name}`);
  }
}

/**
 * Handle one JSON-RPC request object. Returns the response envelope, or
 * null when no response may be sent (a notification, i.e. no `id` member).
 */
function handleOne(req: unknown): RecordValue | null {
  if (!isRecord(req)) return rpcError(null, -32600, 'Invalid Request');
  const hasId = Object.prototype.hasOwnProperty.call(req, 'id');
  const id: JsonRpcId = hasId && (typeof req.id === 'string' || typeof req.id === 'number')
    ? req.id
    : null;
  if (typeof req.method !== 'string' || req.method === '') {
    if (!hasId) return null;
    return rpcError(id, -32600, 'Invalid Request');
  }
  // Notifications carry no id and get no response body, whatever the method.
  if (!hasId) return null;
  const params = isRecord(req.params) ? req.params : {};

  switch (req.method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
    case 'initialize': {
      const protocolVersion = typeof params.protocolVersion === 'string' && params.protocolVersion !== ''
        ? params.protocolVersion
        : '2025-06-18';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
      return rpcResult(id, {});
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(toolName, args);
      // Unknown tool comes back as a JSON-RPC error envelope (id already
      // null there); re-issue it with this request's id.
      if (isRecord(outcome.error)) {
        const err = outcome.error as RecordValue;
        return rpcError(id, typeof err.code === 'number' ? err.code : -32602,
          typeof err.message === 'string' ? err.message : 'Unknown tool');
      }
      return rpcResult(id, outcome);
    }
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}

export async function handleMcp(ctx: Ctx): Promise<void> {
  const { res } = ctx;

  if (ctx.method !== 'POST') {
    sendJson(res, 405, rpcError(null, -32600, 'Invalid Request'));
    return;
  }

  const contentType = String(ctx.req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().includes('application/json')) {
    let id: JsonRpcId = null;
    const parsed = tryParse(ctx.body.toString('utf8'));
    if (isRecord(parsed) && (typeof parsed.id === 'string' || typeof parsed.id === 'number')) {
      id = parsed.id;
    }
    sendJson(res, 415, rpcError(id, -32600, 'Invalid Request'));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      sendJson(res, 200, rpcError(null, -32600, 'Invalid Request'));
      return;
    }
    const responses: RecordValue[] = [];
    for (const item of parsed) {
      const one = handleOne(item);
      if (one !== null) responses.push(one);
    }
    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, responses);
    return;
  }

  if (!isRecord(parsed)) {
    sendJson(res, 200, rpcError(null, -32600, 'Invalid Request'));
    return;
  }

  const single = handleOne(parsed);
  if (single === null) {
    // Notification: no body at all.
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, single);
}
