// Git smart-HTTP endpoints: info/refs advertisements (v2 for upload-pack,
// v0 for receive-pack) and the two POST handlers. Repo lookup is by
// (owner, name) in the shared store; a missing repo is a JSON 404.
import { store } from '../store.ts';
import { jsonError, sendBytes, type Ctx } from '../app.ts';
import { FLUSH_PKT, pktText } from './pkt.ts';
import { handleUploadPack } from './upload.ts';
import { handleReceivePack, refAdvertisementLines } from './receive.ts';

const AGENT = 'github-core-clone/1.0.0';

function uploadPackAdvertisement(repo: { refs: Map<string, string>; defaultBranch: string }): Buffer {
  const parts: Buffer[] = [
    pktText('# service=git-upload-pack'),
    FLUSH_PKT,
    pktText('version 2'),
    pktText(`agent=${AGENT}`),
    pktText('ls-refs=unborn'),
    pktText('fetch=shallow wait-for-done'),
    pktText('server-option'),
    pktText('object-format=sha1'),
    FLUSH_PKT,
  ];
  return Buffer.concat(parts);
}

function receivePackAdvertisement(repo: { refs: Map<string, string>; defaultBranch: string }): Buffer {
  const parts: Buffer[] = [pktText('# service=git-receive-pack'), FLUSH_PKT, ...refAdvertisementLines(repo), FLUSH_PKT];
  return Buffer.concat(parts);
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
      sendBytes(ctx.res, 200, uploadPackAdvertisement(repo), 'application/x-git-upload-pack-advertisement');
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
