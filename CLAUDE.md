# agent-service

The agents' API: agents, their sessions, the requests that start them, roles,
usage and the hosts they run on. One Node 24 process (`src/cli.ts`) serving
HTTP, its data in one SQLite file (`src/store.ts`), what ages out pruned by an
in-process timer (`src/sweep.ts`). agent-host, on each host, follows its
shapes; change them with it.

Keep a comment only when it explains what the code cannot say: a constraint, a
trade-off, a reason something is not the obvious way. Prefer a type, a name or
a failing test to a sentence.

## Tests

Colocated as `*.spec.ts`; `npm test` needs no network: the store runs on
SQLite in memory or in a temporary file (`src/fake-store.ts` is the real store
in memory, read as maps), and `src/cli.spec.ts` starts the server on ports the
OS picks. `integration.spec.ts` hits a running instance and skips without
`INTEGRATION_AG_URL`/`INTEGRATION_AG_TOKEN`. How to run the checks is the
`test` skill (`.claude/skills/test/SKILL.md`).

## Changing the API

Edit `src/schema.ts`; it validates every request and generates the document.
Name an operation as AWS does (a verb, then what it acts on, in PascalCase);
`src/mcp.ts` makes each a snake_case tool. `npm run spec` writes
`openapi.json`, `mcp.json` and `docs/` from them, the pre-commit hook
runs it, and `schema.spec.ts` fails if they drift. A host reports on its
socket alone (`SocketReport`); the heartbeat carries no report and returns no
commands. The host and the service deploy together: there is no versioning
between them.
