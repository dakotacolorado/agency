# worker-service

The workers' API: one package holding the API (`src/`) and its CDK (`infra/`).

Keep a comment only when it explains what the code cannot say: a constraint, a
trade-off, a reason something is not the obvious way. Prefer a type, a name or
a failing test to a sentence.

## Tests

`npm run typecheck`, `npm test`, `npm run synth` — the checks. Tests are
colocated as `*.spec.ts`. `integration.spec.ts` hits a deployed stage and skips
without `WORKER_SERVICE_URL`/`WORKER_SERVICE_TOKEN`, so `npm test` needs no
credentials.
`npm run scenarios:beta` runs real worker sessions on beta and is the check
for changes to status, paging or prompts; it is no part of `npm test`.
The `test` skill (`.claude/skills/test/SKILL.md`) says how to run the checks
and the scenarios, and which pipeline jobs deploy, smoke and roll back.

## Changing the API

Edit `src/schema.ts`; it validates every request and generates the document.
`npm run spec` writes `openapi.json` and `docs/` from it, the pre-commit hook
runs it, and `schema.spec.ts` fails if they drift. A host reports on its
socket alone (`SocketReport`); the heartbeat carries no report and returns no
commands. The host and the service deploy together: there is no versioning
between them.
