// git upload-pack, protocol v2: `ls-refs` and `fetch`.
// Reads the request body (pkt-lines), answers with pkt-line sections.
import { store, type Repo } from '../store.ts';
import { parseCommit, parseTree, type ObjectType } from './objects.ts';
import { buildPack, type PackObject } from './pack.ts';
import { DELIM_PKT, FLUSH_PKT, parsePktLines, pktLine, pktText, RESPONSE_END_PKT, sidebandBytes, splitNul } from './pkt.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';

/** Objects reachable from `tips`; with `maxDepth`, commit parents stop at that depth (deepen). */
export function collectReachable(repo: Repo, tips: string[], maxDepth?: number): { objects: Map<string, PackObject>; boundary: string[] } {
  const objects = new Map<string, PackObject>();
  const boundary: string[] = [];
  const visited = new Set<string>();
  const queue: { oid: string; depth: number }[] = tips.map((oid) => ({ oid, depth: 1 }));
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    objects.set(oid, { type: obj.type, bytes: obj.bytes });
    if (obj.type === 'commit' && obj.commit) {
      const atBoundary = maxDepth !== undefined && depth >= maxDepth;
      if (atBoundary) boundary.push(oid);
      queue.push({ oid: obj.commit.tree, depth });
      if (!atBoundary) for (const p of obj.commit.parents) queue.push({ oid: p, depth: depth + 1 });
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.bytes)) queue.push({ oid: e.oid, depth });
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.bytes);
      if (target) queue.push({ oid: target, depth });
    }
  }
  return { objects, boundary };
}

function parseTagTarget(bytes: Buffer): string | null {
  const m = /^object ([0-9a-f]{40})$/m.exec(bytes.toString('utf8'));
  return m ? m[1] : null;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  deepen?: number;
  sidebandAll: boolean;
  ofsDelta: boolean;
  includeTag: boolean;
}

/** Parse a v2 command request body into {command, args}. */
function parseCommand(body: Buffer): { command: string; args: string[] } {
  const { items } = parsePktLines(body);
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'data') lines.push(item.data.toString('utf8').trim());
    else if (item.kind === 'flush') break;
  }
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const line of lines) {
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else if (line === '') seenDelim = true;
    else if (line.startsWith('agent=')) { /* ignore */ }
    else args.push(line);
  }
  void seenDelim;
  return { command, args };
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], sidebandAll: false, ofsDelta: false, includeTag: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg === 'done') { /* end of negotiation */ }
    else if (arg.startsWith('deepen ')) out.deepen = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) out.deepen = 1;
    else if (arg === 'sideband-all') out.sidebandAll = true;
    else if (arg === 'ofs-delta') out.ofsDelta = true;
    else if (arg === 'include-tag') out.includeTag = true;
  }
  return out;
}

/** ls-refs response lines for the repo, honouring ref-prefix args. */
function lsRefsLines(repo: Repo, args: string[]): string[] {
  const prefixes: string[] = [];
  let refLimit = 0;
  let peel = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('ref-limit ')) refLimit = Number(arg.slice('ref-limit '.length)) || 0;
    else if (arg === 'peel') peel = true;
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef);
  // HEAD is advertised only when the default branch has a tip. For an empty
  // repo ls-refs answers nothing at all — that is what makes `git clone`
  // print "You appear to have cloned an empty repository" and `git
  // ls-remote` show no HEAD (an `unborn` HEAD line gives the wrong warning).
  if (matches('HEAD') && defaultTip) {
    lines.push(`${defaultTip} HEAD\0symref-target:${defaultRef}\n`);
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    // With `peel`, an annotated tag ref carries the commit it peels to.
    let line = `${oid} ${ref}\n`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const target = parseTagTarget(obj.bytes);
        if (target) line = `${oid} ${ref}\0peeled:${target}\n`;
      }
    }
    lines.push(line);
    if (refLimit > 0 && lines.length >= refLimit) break;
  }
  return lines;
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lsRefsLines(repo, args)) parts.push(pktLine(line));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function handleFetch(repo: Repo, args: string[]): Buffer {
  const fetch = parseFetchArgs(args);
  const parts: Buffer[] = [];
  // A want of the zero OID is how `git clone` asks for an empty repo (the
  // ls-refs unborn HEAD): answer with an empty pack, never an error.
  const wants = fetch.wants.filter((w) => w !== ZERO_OID);
  // Every other want must exist, or the fetch fails with an error packet.
  for (const want of wants) {
    if (!repo.objects.has(want)) {
      return Buffer.concat([pktText(`error object ${want} not found`), FLUSH_PKT]);
    }
  }
  const { objects, boundary } = collectReachable(repo, wants, fetch.deepen);
  // With haves and no deepen, send only what the client does not already
  // hold: subtract everything reachable from the haves. (With deepen the
  // depth limit dominates — the shallow/deepen checks expect the next
  // generation even though it is reachable from the shallow have.)
  if (fetch.haves.length > 0 && fetch.deepen === undefined) {
    const held = collectReachable(repo, fetch.haves).objects;
    for (const oid of held.keys()) objects.delete(oid);
  }
  // With `include-tag`, also send tag objects whose target is in the pack
  // (an annotated tag pointing at a wanted commit round-trips in a clone).
  if (fetch.includeTag) {
    for (const [oid, obj] of repo.objects) {
      if (obj.type !== 'tag' || objects.has(oid)) continue;
      const target = parseTagTarget(obj.bytes);
      if (target && objects.has(target)) objects.set(oid, { type: obj.type, bytes: obj.bytes });
    }
  }
  // Acknowledgment section, only when the client offered haves. Sections are
  // separated by DELIM (0001), not flush: a flush here ends the whole
  // response in the client's eyes and the packfile after it is "unexpected".
  // ACK the first have the repo already holds, then `ready`; else NAK.
  if (fetch.haves.length > 0) {
    parts.push(pktText('acknowledgments'));
    const common = fetch.haves.find((h) => repo.objects.has(h));
    if (common) {
      parts.push(pktText(`ACK ${common}`));
      parts.push(pktText('ready'));
    } else {
      parts.push(pktText('NAK'));
    }
    parts.push(DELIM_PKT);
  }
  // Shallow-info section, only when deepen was asked for.
  if (fetch.deepen !== undefined) {
    parts.push(pktText('shallow-info'));
    for (const oid of boundary) parts.push(pktText(`shallow ${oid}`));
    parts.push(DELIM_PKT);
  }
  // Packfile section. In protocol v2 the packfile is always sent with
  // sideband framing (band 1 = pack data), whether or not the client sent
  // `sideband-all` — git's fetch-pack demultiplexes it unconditionally.
  // No response-end packet (0002) here: remote-curl rejects a trailing
  // 0002 as "unexpected response end packet" (it treats the packfile flush
  // as the end of the response), and fetch-pack accepts the flush-ended
  // response once the sections are delim-separated.
  const pack = buildPack(objects);
  parts.push(pktText('packfile'));
  parts.push(...sidebandBytes(1, pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** Handle POST git-upload-pack (protocol v2). Returns the response body. */
export function handleUploadPack(repo: Repo, body: Buffer): Buffer {
  const { command, args } = parseCommand(body);
  if (command === 'ls-refs') return handleLsRefs(repo, args);
  if (command === 'fetch') return handleFetch(repo, args);
  return Buffer.concat([pktText(`error unknown command ${command}`), FLUSH_PKT]);
}
