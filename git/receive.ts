// git receive-pack, protocol v0: ref updates + packfile, with report-status
// and side-band-64k. The client sends pkt-line ref updates, a flush, then
// the raw packfile. The reply is `unpack ok` + one `ok`/`ng` line per ref.
import { store, type Repo } from '../store.ts';
import { parsePack } from './pack.ts';
import { FLUSH_PKT, parsePktLines, pktLine, pktText, sidebandBytes, sidebandLine, splitNul } from './pkt.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'github-core-clone/1.0.0';

/** Ref advertisement lines (HEAD with caps + every ref), without the `# service` header. */
export function refAdvertisementLines(repo: { refs: Map<string, string>; defaultBranch: string }): Buffer[] {
  const caps = 'report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta object-format=sha1';
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  parts.push(pktLine(`${headTip} HEAD\0${caps} agent=${AGENT}\n`));
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) parts.push(pktText(`${oid} ${ref}`));
  return parts;
}

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Is `ancestor` reachable from `tip` (first-parent + full ancestry walk)? */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || !obj.commit) continue;
    for (const p of obj.commit.parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}

/** Peel an annotated tag to its target commit, or return the oid unchanged. */
function peelToCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') {
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.bytes.toString('utf8'));
    if (!m) return null;
    return peelToCommit(repo, m[1]);
  }
  return null;
}

/** Handle POST git-receive-pack (protocol v0). Returns the response body. */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { items } = parsePktLines(body);
  const updates: RefUpdate[] = [];
  const caps = new Set<string>();
  let packStart = 0;
  let sawFlush = false;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === 'flush') {
      sawFlush = true;
      // The packfile starts right after this flush packet in the raw body.
      // Recompute the byte offset by re-walking the raw buffer.
      packStart = byteOffsetAfterFlush(body);
      break;
    }
    if (item.kind !== 'data') continue;
    const { head, rest } = splitNul(item.data);
    if (rest !== null && updates.length === 0) {
      for (const cap of rest.toString('utf8').trim().split(/\s+/)) if (cap) caps.add(cap);
    }
    const text = head.toString('utf8').trim();
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text);
    if (m) updates.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const reportStatus = caps.has('report-status') || caps.has('report-status-v2');
  const sideband = caps.has('side-band-64k');
  const line = (text: string): Buffer => (sideband ? sidebandLine(1, text.endsWith('\n') ? text : `${text}\n`) : pktText(text));
  if (!sawFlush) {
    // No ref updates at all: nothing to do.
    return Buffer.concat([line('unpack ok'), FLUSH_PKT]);
  }
  if (updates.length === 0) {
    // Probe POST: git's stateless handshake sends only the refspecs it wants
    // to update, and expects the ref advertisement (current values) back —
    // answering with a bare flush leaves git's packet reader misaligned and
    // the real push after it fails with "bad line length".
    return Buffer.concat([...refAdvertisementLines(repo), FLUSH_PKT]);
  }
  const packBytes = body.subarray(packStart);
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes, (oid) => {
        const obj = repo.objects.get(oid);
        return obj ? { type: obj.type, bytes: obj.bytes } : undefined;
      });
      for (const [oid, obj] of parsed.objects) store.putObjectByOid(repo, oid, obj.type, obj.bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'pack parse failed';
      const out: Buffer[] = [line(`unpack ${msg}`)];
      for (const u of updates) out.push(line(`ng ${u.ref} unpack failed`));
      out.push(FLUSH_PKT);
      return Buffer.concat(out);
    }
  }
  for (const u of updates) {
    const current = repo.refs.get(u.ref);
    if (u.newOid === ZERO_OID) {
      // Delete.
      if (u.oldOid !== ZERO_OID && current !== u.oldOid) {
        results.push({ ref: u.ref, ok: false, reason: 'old value mismatch' });
        continue;
      }
      repo.refs.delete(u.ref);
      results.push({ ref: u.ref, ok: true });
      continue;
    }
    const tip = peelToCommit(repo, u.newOid);
    if (!tip) {
      results.push({ ref: u.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (u.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: u.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else {
      if (current !== u.oldOid) {
        results.push({ ref: u.ref, ok: false, reason: 'old value mismatch' });
        continue;
      }
      if (!isAncestor(repo, u.oldOid, tip)) {
        results.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    // Store the exact oid the client sent: a tag ref points at the tag
    // object, not at the commit it peels to — peeling here made a later
    // delete (oldOid = tag oid) fail with "old value mismatch".
    repo.refs.set(u.ref, u.newOid);
    results.push({ ref: u.ref, ok: true });
  }
  // Any ref change invalidates the git caches (keyed on repo.version).
  if (results.length > 0) repo.version += 1;
  if (!reportStatus) return Buffer.concat([FLUSH_PKT]);
  if (caps.has('report-status-v2')) {
    // v2: the status lines are themselves pkt-lines, packed inside sideband
    // band-1 packets, closed by an inner flush, then the outer flush.
    const inner: Buffer[] = [pktText('unpack ok')];
    for (const r of results) {
      inner.push(pktText(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason ?? 'failed'}`));
    }
    inner.push(FLUSH_PKT);
    const innerBytes = Buffer.concat(inner);
    return Buffer.concat([...sidebandBytes(1, innerBytes), FLUSH_PKT]);
  }
  const out: Buffer[] = [line('unpack ok')];
  for (const r of results) {
    out.push(line(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason ?? 'failed'}`));
  }
  out.push(FLUSH_PKT);
  return Buffer.concat(out);
}

/** Byte offset just past the first flush packet (0000) in `body`. */
function byteOffsetAfterFlush(body: Buffer): number {
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) return body.length;
    if (len === 0) return i + 4;
    if (len === 1 || len === 2) {
      i += 4;
      continue;
    }
    if (i + len > body.length) return body.length;
    i += len;
  }
  return body.length;
}
