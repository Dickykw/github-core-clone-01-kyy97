// Packfile build + parse (git pack format v2). Plain objects on build
// (no deltas — correct, just larger); full delta support on parse, because
// `git push` sends delta-compressed packs, including thin packs whose
// REF_DELTA bases live in the repo already.
import { createHash } from 'node:crypto';
import { hashObject, zlibDeflate, zlibInflate, type ObjectType } from './objects.ts';

export interface PackObject {
  type: ObjectType;
  bytes: Buffer;
}

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

function typeToCode(type: ObjectType): number {
  switch (type) {
    case 'commit': return OBJ_COMMIT;
    case 'tree': return OBJ_TREE;
    case 'blob': return OBJ_BLOB;
    case 'tag': return OBJ_TAG;
  }
}
function codeToType(code: number): ObjectType | null {
  switch (code) {
    case OBJ_COMMIT: return 'commit';
    case OBJ_TREE: return 'tree';
    case OBJ_BLOB: return 'blob';
    case OBJ_TAG: return 'tag';
    default: return null;
  }
}

/** Build a packfile (v2, plain objects, entries sorted by oid for determinism). */
export function buildPack(objects: Map<string, PackObject>): Buffer {
  const oids = [...objects.keys()].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = objects.get(oid)!;
    const size = obj.bytes.length;
    const typeCode = typeToCode(obj.type);
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(zlibDeflate(obj.bytes));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(createHash('sha1').update(body).digest('hex'), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to a base object, per the pack format spec. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error(`delta base size mismatch: ${srcSize} != ${base.length}`);
  const dstSize = readVarint();
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== dstSize) throw new Error(`delta target size mismatch: ${outLen} != ${dstSize}`);
  return Buffer.concat(out);
}

/**
 * Inflate exactly one deflate stream starting at `start`, whose inflated
 * length is `expectedSize`. Node's inflateSync with `{ info: true }`
 * returns the engine, whose `bytesWritten` is exactly the number of input
 * bytes the stream consumed (verified: it stops at the stream end even
 * with trailing garbage after it, and still throws on truncation). So one
 * inflate call gives both the bytes and the consumed length — no
 * exponential probe + binary search, and no throw per probe.
 */
function inflateBounded(buf: Buffer, start: number, expectedSize: number, limit: number): { bytes: Buffer; consumed: number } {
  const { buffer, engine } = zlibInflate(buf.subarray(start, limit), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (buffer.length !== expectedSize) throw new Error('deflate stream size mismatch');
  return { bytes: buffer, consumed: engine.bytesWritten };
}

export interface ParsedPack {
  objects: Map<string, PackObject>;
}

interface PendingDelta {
  offset: number;
  delta: Buffer;
  baseOid?: string;
  baseOffset?: number;
}

/**
 * Parse a packfile. `resolveBase` supplies objects already in the repo, for
 * thin packs (REF_DELTA whose base is not in the pack). Returns every object
 * in the pack, keyed by oid, with deltas resolved. Deltas resolve in passes,
 * so a delta based on another delta in the same pack works in any order.
 */
export function parsePack(buf: Buffer, resolveBase?: (oid: string) => PackObject | undefined): ParsedPack {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const limit = buf.length - 20; // last 20 bytes are the trailer checksum
  const objects = new Map<string, PackObject>();
  const byOffset = new Map<number, { oid: string; type: ObjectType; bytes: Buffer }>();
  const pending: PendingDelta[] = [];
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const entryStart = pos;
    let byte = buf[pos++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === OBJ_OFS_DELTA) {
      let b = buf[pos++];
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos++];
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryStart - offset;
    } else if (typeCode === OBJ_REF_DELTA) {
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (!codeToType(typeCode)) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const { bytes: inflated, consumed } = inflateBounded(buf, pos, size, limit);
    pos += consumed;
    if (typeCode === OBJ_OFS_DELTA || typeCode === OBJ_REF_DELTA) {
      pending.push({ offset: entryStart, delta: inflated, baseOid, baseOffset });
      byOffset.set(entryStart, { oid: '', type: 'blob', bytes: inflated });
      continue;
    }
    const type = codeToType(typeCode)!;
    const oid = hashObject(type, inflated);
    objects.set(oid, { type, bytes: inflated });
    byOffset.set(entryStart, { oid, type, bytes: inflated });
  }
  let remaining = pending;
  while (remaining.length > 0) {
    const next: PendingDelta[] = [];
    let progressed = false;
    for (const entry of remaining) {
      let base: { oid: string; type: ObjectType; bytes: Buffer } | undefined;
      if (entry.baseOffset !== undefined) {
        const at = byOffset.get(entry.baseOffset);
        if (at && at.oid !== '') base = at;
      } else if (entry.baseOid) {
        const inPack = objects.get(entry.baseOid);
        if (inPack) base = { oid: entry.baseOid, type: inPack.type, bytes: inPack.bytes };
        else if (resolveBase) {
          const ext = resolveBase(entry.baseOid);
          if (ext) base = { oid: entry.baseOid, type: ext.type, bytes: ext.bytes };
        }
      }
      if (!base) {
        next.push(entry);
        continue;
      }
      const bytes = applyDelta(base.bytes, entry.delta);
      const oid = hashObject(base.type, bytes);
      objects.set(oid, { type: base.type, bytes });
      byOffset.set(entry.offset, { oid, type: base.type, bytes });
      progressed = true;
    }
    if (!progressed) throw new Error('unresolvable delta base in pack');
    remaining = next;
  }
  return { objects };
}
