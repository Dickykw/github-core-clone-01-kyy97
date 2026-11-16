// Git object primitives: SHA-1 ids, zlib, object serialisation/parsing.
// Pure functions only — no store dependency, no clock, no randomness.
import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id for `<type> <len>\0<bytes>`. */
export function hashObject(type: ObjectType, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, content]));
}

/** Raw on-disk form of an object (header + content), for packfiles. */
export function rawObject(type: ObjectType, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${content.length}\0`, 'ascii'), content]);
}

export { zlibDeflate, zlibInflate };

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  authorTz: string;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  committerTz: string;
  message: string;
}

export function parseCommit(content: Buffer): CommitInfo {
  const text = content.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  const info: CommitInfo = {
    tree: '', parents: [], authorName: '', authorEmail: '', authorTs: 0, authorTz: '+0000',
    committerName: '', committerEmail: '', committerTs: 0, committerTz: '+0000', message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) parseIdent(line.slice(7), info, 'author');
    else if (line.startsWith('committer ')) parseIdent(line.slice(10), info, 'committer');
  }
  return info;
}

function parseIdent(text: string, info: CommitInfo, which: 'author' | 'committer'): void {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(text);
  if (!m) return;
  if (which === 'author') {
    info.authorName = m[1]; info.authorEmail = m[2]; info.authorTs = Number(m[3]); info.authorTz = m[4];
  } else {
    info.committerName = m[1]; info.committerEmail = m[2]; info.committerTs = Number(m[3]); info.committerTz = m[4];
  }
}

export function serializeCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.authorName} <${info.authorEmail}> ${info.authorTs} ${info.authorTz}`);
  lines.push(`committer ${info.committerName} <${info.committerEmail}> ${info.committerTs} ${info.committerTz}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object body into entries (in stored order). */
export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < content.length) {
    const space = content.indexOf(0x20, i);
    const mode = content.subarray(i, space).toString('ascii');
    const nul = content.indexOf(0x00, space + 1);
    const name = content.subarray(space + 1, nul).toString('utf8');
    const oid = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

/** Serialise tree entries in git's order (directories sort as name + '/'). */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a tree object from a flat path -> {oid, mode} map. Returns {rootOid, objects} with every tree object. */
export function buildTreeObjects(files: Map<string, { oid: string; mode: string }>): { rootOid: string; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  interface Node {
    trees: Map<string, Node>;
    blobs: Map<string, { oid: string; mode: string }>;
  }
  const root: Node = { trees: new Map(), blobs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.trees.get(parts[i]);
      if (!next) {
        next = { trees: new Map(), blobs: new Map() };
        node.trees.set(parts[i], next);
      }
      node = next;
    }
    node.blobs.set(parts[parts.length - 1], file);
  }
  function build(node: Node): string {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of node.trees) entries.push({ mode: '40000', name, oid: build(sub) });
    for (const [name, file] of node.blobs) entries.push({ mode: file.mode, name, oid: file.oid });
    const bytes = serializeTree(entries);
    const oid = hashObject('tree', bytes);
    objects.set(oid, bytes);
    return oid;
  }
  return { rootOid: build(root), objects };
}
