# github-core-clone-01 — GitHub-compatible git forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dickykw/github-core-clone-01-kyy97/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dickykw/github-core-clone-01-kyy97/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone single-process git forge (Node 22 stdlib only, no git binary, no
external database) serving four surfaces over one in-memory store:

- **git smart HTTP v2** — clone / fetch / push (`upload-pack`, `receive-pack`)
- **REST v3** — repos, issues, pulls, contents, branches, commits, refs
- **GraphQL v4** — viewer, repository, issues, pull requests, mutations
- **MCP** — JSON-RPC 2.0 tools over the same store

## Run

```sh
node main.ts
```

`main.ts` is the make.fun entry lifecycle (bind ephemeral port, register with
the env, wait for done). `app.ts` is the server; `store.ts` is the single
in-memory store; `git/` is the pkt-line / packfile / upload-pack /
receive-pack implementation; `rest.ts`, `graphql.ts`, `mcp.ts` are the API
surfaces.

## License

MIT — see [LICENSE](LICENSE).
