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

/** One request's context, handed to a surface handler. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: Buffer;
  requestId: string;
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

/** Parse a JSON body; returns null when the body is empty or not JSON. */
export function parseJson(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

/** The token the env gave this entry; '' when unset (local dev). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function isAuthed(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (token.length === 0) return false;
  const expected = expectedToken();
  if (expected.length === 0) return true;
  return token === expected;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `req-${++requestCounter}`;
      res.setHeader('x-request-id', requestId);
      res.setHeader('x-github-request-id', requestId);
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        url = new URL('/', 'http://entry');
      }
      const ctx: Ctx = {
        req, res, method, pathname: path, query: url.searchParams,
        body: Buffer.alloc(0), requestId,
      };
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

        ctx.body = await readBody(req);

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
      }
    })();
  });
}
