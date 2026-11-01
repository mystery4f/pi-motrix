# pi-motrix

[Motrix](https://github.com/agalwood/Motrix) download manager tools for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Gives the agent a real download manager instead of `curl`: multi-connection HTTP(S)/FTP(S)/SFTP downloads, BitTorrent (magnet + `.torrent`), live progress, pause/resume — driven by Motrix's local [MDXP](https://www.npmjs.com/package/@motrix/mdxp) bridge.

## Requirements

- The **Motrix desktop app** must be running (it hosts the local MDXP bridge).
- Motrix recent enough to ship the bridge (`bridge/endpoint.json` in the Motrix user-data directory).

## Install

```sh
pi install github:mystery4f/pi-motrix
```

or add it to your pi settings packages list.

## Tools

- **motrix_download** — submit a download. Pass `urls` (array), `magnet` (URI), or `torrentPath` (local `.torrent`). Options: `saveDir` (default `~/Downloads`), `filename`, `connections` (1–128), `headers`, `proxy`, `selectedFiles`, `displayName`. By default returns immediately with the task snapshot; pass `wait: true` to block until completion (streams progress updates, `waitTimeoutSec` caps the wait, default 300).
- **motrix_tasks** — list tasks with live progress, optionally filtered by `status`.
- **motrix_task** — `get` / `pause` / `resume` / `remove` one task; `remove` accepts `deleteFiles`.
- **motrix_stats** — total speeds and task counts; also confirms the engine is reachable.

## How it works

The extension discovers the running Motrix app via `<Motrix user-data dir>/bridge/endpoint.json` (port + `localToken`), then speaks unary JSON-RPC 2.0 to `http://127.0.0.1:{port}/mdxp` (`download/add`, `task/list`, `task/get`, `task/pause`, `task/resume`, `task/remove`, `stats/get`, `engine/status`). `download/add` submissions carry an `idempotencyKey` so a transport-level retry can never duplicate a task.

If Motrix is not running, tools fail with a clear message telling you to start it.

## License

MIT
