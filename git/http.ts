// Git smart-HTTP endpoints: info/refs advertisements (v2 for upload-pack,
// v0 for receive-pack) and the two POST handlers. Repo lookup is by
// (owner, name) in the shared store; a missing repo is a JSON 404.
import { store } from '../store.ts';
import { jsonError, sendBytes, type Ctx } from '../app.ts';
import { FLUSH_PKT, pktText } from './pkt.ts';
import { handleUploadPack } from './upload.ts';
import { handleReceivePack, refAdvertisementLines } from './receive.ts';

const AGENT = 'github-core-clone/1.0.0';

/** The upload-pack advertisement is the same bytes for every repo (v2
 * capabilities only, no refs) — build once, reuse forever. */
const UPLOAD_PACK_ADVERTISEMENT: Buffer = Buffer.concat([
  pktText('# service=git-upload-pack'),
  FLUSH_PKT,
  pktText('version 2'),
  pktText(`agent=${AGENT}`),
  pktText('ls-refs=unborn'),
  pktText('fetch=shallow wait-for-done'),
  pktText('server-option'),
  pktText('object-format=sha1'),
  FLUSH_PKT,
]);

/** Receive-pack advertisement cache, keyed on repo version (any ref or
 * object change bumps it). The push bench GETs info/refs before every
 * one of its 200 pushes; rebuilding + sorting refs each time is pure
 * overhead. Capped, FIFO eviction. */
const receiveAdvertCache = new Map<string, Buffer>();
const RECEIVE_ADVERT_CACHE_MAX = 128;
function receivePackAdvertisement(repo: { id: number; version: number; refs: Map<string, string>; defaultBranch: string }): Buffer {
  const key = `rp:${repo.id}:${repo.version}`;
  const hit = receiveAdvertCache.get(key);
  if (hit) return hit;
  const out = Buffer.concat([pktText('# service=git-receive-pack'), FLUSH_PKT, ...refAdvertisementLines(repo), FLUSH_PKT]);
  if (receiveAdvertCache.size >= RECEIVE_ADVERT_CACHE_MAX) {
    const first = receiveAdvertCache.keys().next().value;
    if (first !== undefined) receiveAdvertCache.delete(first);
  }
  receiveAdvertCache.set(key, out);
  return out;
}

export async function handleGit(ctx: Ctx, owner: string, repoName: string, action: string): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    jsonError(ctx.res, 404, 'Not Found');
    return;
  }
  if (action === 'info/refs') {
    const service = ctx.query.get('service');
    if (service === 'git-upload-pack') {
      sendBytes(ctx.res, 200, UPLOAD_PACK_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendBytes(ctx.res, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
      return;
    }
    jsonError(ctx.res, 400, 'Missing service parameter');
    return;
  }
  if (action === 'git-upload-pack') {
    const out = handleUploadPack(repo, ctx.body);
    sendBytes(ctx.res, 200, out, 'application/x-git-upload-pack-result');
    return;
  }
  if (action === 'git-receive-pack') {
    const out = handleReceivePack(repo, ctx.body);
    sendBytes(ctx.res, 200, out, 'application/x-git-receive-pack-result');
    return;
  }
  jsonError(ctx.res, 404, 'Not Found');
}
