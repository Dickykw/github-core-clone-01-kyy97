// The server: one process, node:http, stdlib only. Routes the four surfaces
// (git smart HTTP, REST v3, GraphQL v4, MCP) onto the single store, plus the
// env's /healthz boot probe. main.ts is the lifecycle; this file is the app.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git/http.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Server-side handler timing per route label (diagnostic only; never
 * enters a response or the export). Lets the perf tuner split a
 * workload's wall time into server compute vs client/HTTP overhead. */
const routeStats = new Map<string, { n: number; ms: number }>();
export function serverRouteStats(): { label: string; n: number; ms: number; avgMs: number }[] {
  return [...routeStats.entries()]
    .map(([label, s]) => ({ label, n: s.n, ms: Math.round(s.ms * 100) / 100, avgMs: s.n > 0 ? Math.round((s.ms / s.n) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.ms - a.ms);
}
export function resetServerRouteStats(): void {
  routeStats.clear();
}
function routeLabel(method: string, path: string): string {
  if (path === '/healthz') return 'healthz';
  if (path === '/api/graphql' || path === '/api/v3/graphql') return 'graphql';
  if (path === '/mcp' || path === '/api/v3/mcp') return 'mcp';
  if (path.startsWith('/api/v3/') || path === '/api/v3' || path === '/api/v3/') return `rest:${method}`;
  if (path.includes('.git/git-upload-pack')) return 'git:upload-pack';
  if (path.includes('.git/git-receive-pack')) return 'git:receive-pack';
  if (path.includes('.git/info/refs')) return 'git:info-refs';
  return 'other';
}

/** One request's context, handed to a surface handler. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: Buffer;
  requestId: string;
  /** GET response-cache key, set by handleRest for repo-scoped GETs. */
  cacheKey?: string;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendBytes(res: ServerResponse, status: number, bytes: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': bytes.length, ...headers });
  res.end(bytes);
}

/** GitHub-style error body. */
export function jsonError(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { message, ...extra });
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const noop = (): void => undefined;

/** Parse a JSON body; returns null when the body is empty or not JSON. */
export function parseJson(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

/** The token the env gave this entry; '' when unset (local dev). Read once
 * at module load — process.env access per request is needless overhead on
 * the 2,000-request read bench. */
const EXPECTED_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function isAuthed(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (token.length === 0) return false;
  if (EXPECTED_TOKEN.length === 0) return true;
  return token === EXPECTED_TOKEN;
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `req-${++requestCounter}`;
      res.setHeader('x-request-id', requestId);
      res.setHeader('x-github-request-id', requestId);
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        url = new URL('/', 'http://entry');
      }
      const path = url.pathname;
      const ctx: Ctx = {
        req, res, method, pathname: path, query: url.searchParams,
        body: Buffer.alloc(0), requestId,
      };
      const label = routeLabel(method, path);
      const t0 = performance.now();
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Everything else needs a Bearer token.
        if (!isAuthed(req)) {
          jsonError(res, 401, 'Requires authentication');
          return;
        }

        // GET/HEAD never carries a body in this suite; reading it costs a
        // promise + event-listener setup per request (2,000x on the read
        // bench). Only skip when the request provably has no body. The
        // error listener stays: an unhandled 'error' on the request would
        // throw and kill the process.
        const hasBody = method !== 'GET' && method !== 'HEAD'
          ? true
          : (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
            || req.headers['transfer-encoding'] !== undefined;
        if (hasBody) {
          ctx.body = await readBody(req);
        } else {
          req.on('error', noop);
          ctx.body = Buffer.alloc(0);
        }

        if (path === '/api/graphql' || path === '/api/v3/graphql') {
          await handleGraphql(ctx);
          return;
        }
        if (path === '/mcp' || path === '/api/v3/mcp') {
          await handleMcp(ctx);
          return;
        }
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          await handleRest(ctx);
          return;
        }
        const gitMatch = GIT_ROUTE.exec(path);
        if (gitMatch) {
          await handleGit(ctx, gitMatch[1], gitMatch[2], gitMatch[3]);
          return;
        }

        jsonError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.writableEnded) {
          jsonError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
      } finally {
        const s = routeStats.get(label) ?? { n: 0, ms: 0 };
        s.n += 1;
        s.ms += performance.now() - t0;
        routeStats.set(label, s);
      }
    })();
  });
}
