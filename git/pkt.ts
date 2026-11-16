// pkt-line framing (git protocol) + sideband. Pure helpers, no I/O.
export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

/** One pkt-line: 4 hex digits (total length incl. the 4) + payload. */
export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  if (len > 65520) throw new Error('pkt-line too large');
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

/** A pkt-line carrying a text line (adds the trailing LF when missing). */
export function pktText(text: string): Buffer {
  return pktLine(text.endsWith('\n') ? text : `${text}\n`);
}

export type PktItem =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse as many complete pkt-lines as possible from the front of `buf`. */
export function parsePktLines(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      items.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'response-end' });
      i += 4;
      continue;
    }
    if (i + len > buf.length) break;
    items.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { items, rest: buf.subarray(i) };
}

/** Split a pkt-line data payload into NUL-separated head and rest. */
export function splitNul(data: Buffer): { head: Buffer; rest: Buffer | null } {
  const idx = data.indexOf(0);
  if (idx === -1) return { head: data, rest: null };
  return { head: data.subarray(0, idx), rest: data.subarray(idx + 1) };
}

/** Frame a byte stream as pkt-lines of at most `chunk` payload bytes. */
export function frameStream(data: Buffer, chunk = 65516): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunk) out.push(pktLine(data.subarray(i, Math.min(i + chunk, data.length))));
  return out;
}

/** Wrap one text line for sideband band 1 (pack data / progress text). */
export function sidebandLine(band: number, text: string): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), Buffer.from(text, 'utf8')]);
  return pktLine(payload);
}

/** Wrap raw bytes for a sideband band, chunked. */
export function sidebandBytes(band: number, data: Buffer, chunk = 65515): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunk) {
    out.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(i, Math.min(i + chunk, data.length))])));
  }
  return out;
}
