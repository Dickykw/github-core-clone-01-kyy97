// Entry point: the conversation between this program and the trial env.
// The env (kit program/env) owns port 8080 and drives the trial; this
// process only has to (a) serve the forge on a kernel-chosen port,
// (b) hand that port number to the env, and (c) stay alive until the env
// reports the trial finished. Nothing here scores points — the forge in
// app.ts does that — so this file stays small and does exactly the dance
// above, in this order:
//
//   1. Read MAKEFUN_ENV_URL. It is the env's origin, e.g.
//      http://store:8080 inside a trial pod. Missing it means there is
//      no env to talk to, so the process quits with code 1 right away.
//   2. Start the forge and listen on port 0. The kernel hands back a free
//      port; 8080 is never bound here because the env already uses it.
//   3. POST {port} to $MAKEFUN_ENV_URL/register. The env remembers where
//      the request came from plus the port, and calls that base URL from
//      then on. Whoever registers first wins: a 409 reply means somebody
//      else already did, and this process simply carries on waiting.
//   4. GET $MAKEFUN_ENV_URL/done over and over until it says done. The
//      env replies immediately either way, so this is a short poll loop,
//      not a held-open request. Slow or failed polls back off briefly
//      and try again; the process never quits before done is true.
//   5. Shut the server down and leave with code 0. The harness then
//      stops the env, which writes the export the scorer reads.
//
// Only the forge is imported. No packages, no Node built-ins, no model.

import { createApp } from "./app.ts";

// Exit codes for the two ways this process can end.
const EXIT_OK = 0;
const EXIT_FAILURE = 1;

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin.length === 0) {
  process.stderr.write("[entry] MAKEFUN_ENV_URL missing: no env to register with\n");
  process.exit(EXIT_FAILURE);
}

// Upper bound on one register/done round trip before it is given up on.
const REQUEST_BUDGET_MS = 30_000;
// Backoff ladder for failed attempts: first pause, then the ceiling.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

// Pause for ms.
const pause = (ms: number): Promise<void> =>
  new Promise((wake) => setTimeout(wake, ms));

// Pause after `failures` failed attempts: doubling from BACKOFF_FIRST_MS,
// capped at BACKOFF_CEILING_MS (the exponent stops growing at 8).
function backoffFor(failures: number): number {
  const steps = failures < 8 ? failures : 8;
  const wait = BACKOFF_FIRST_MS * 2 ** steps;
  return wait < BACKOFF_CEILING_MS ? wait : BACKOFF_CEILING_MS;
}

// Announce the bound port to the env, retrying until it sticks. A 200
// means accepted; a 409 means another entry registered first, which is
// fine too. 400/405 mean the request itself is wrong, so those end the
// process; anything else (dropped connection, odd status, env still
// starting) is worth another try after a short pause.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try { // One register attempt; a throw below means retry, not failure.
      const reply = await fetch(`${envOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register refused with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (problem) {
      if (problem instanceof Error && problem.message.startsWith("register refused with HTTP ")) throw problem;
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

// Ask the env whether the trial is over, forever until it says yes.
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try { // One done poll; a throw below means retry, not failure.
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch { // No answer, or the answer was garbled: not done yet, poll again.
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

// The process's whole life: serve, announce, wait, shut down.
async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((ready, failed) => {
    forge.once("error", failed);
    forge.listen(0, ready);
  });
  const bound = forge.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("server did not bind a TCP port");
  }
  process.stdout.write(`[entry] serving on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write("[entry] port announced; waiting for the env\n");

  await waitUntilDone();
  forge.close();
  process.stdout.write("[entry] trial done\n");
}

try { // Run the lifecycle; a throw anywhere above ends the process below.
  await run();
  process.exit(EXIT_OK);
} catch (problem) {
  process.stderr.write(`[entry] ${problem instanceof Error ? problem.message : String(problem)}\n`);
  process.exit(EXIT_FAILURE);
}
