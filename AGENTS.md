# pi-motrix

Motrix download manager tools for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Layout

- `index.ts` — extension entry, registers every tool.
- `src/tools.ts` — tool definitions: `name`, `label`, `description`, `promptGuidelines`, `parameters`. Tool-selection wording lives here.
- `src/client.ts` — MDXP JSON-RPC transport with retry, timeout and abort.
- `src/discovery.ts` — locates the running Motrix app through its `bridge/endpoint.json`.
- `src/format.ts` — renders tasks, stats and engine status for the agent.
- `src/types.ts` — MDXP data shapes.
- `README.md` — user-facing docs; keep its tool list in sync with `src/tools.ts`.

## Checks

- `npm run typecheck` — devDependencies are absent on a fresh clone; run `npm install` first.
- `package-lock.json` is gitignored, so CI cannot use `npm ci` or setup-node `cache: npm`; use `npm install`.

## Conventions

- `description` and `promptGuidelines` are tool-selection prompts, not docs: name the tools this one competes with and state the boundary, instead of restating parameters.
