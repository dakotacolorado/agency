# agency

**Agents at your command, across all your computers.**

```
 █████╗  ██████╗ ███████╗███╗   ██╗ ██████╗██╗   ██╗        ▄▄██▄▄
██╔══██╗██╔════╝ ██╔════╝████╗  ██║██╔════╝╚██╗ ██╔╝    ▄▄██████████▄▄
███████║██║  ███╗█████╗  ██╔██╗ ██║██║      ╚████╔╝    ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║██║       ╚██╔╝      ██  ██  ██  ██
██║  ██║╚██████╔╝███████╗██║ ╚████║╚██████╗   ██║       ██  ██  ██  ██
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝ ╚═════╝   ╚═╝     ▄████████████████▄
v0.5.0

Agents at your command, across all your computers.
Agents, their sessions, the requests that start them and the hosts they run on.

  ▸ Page      https://agency.example.com/
  ▸ API       https://agency.example.com/agents   docs https://agency.example.com/docs/api
  ▸ MCP       https://agency.example.com/mcp      docs https://agency.example.com/docs/mcp
```

agency runs Claude agents on your machines and keeps track of them. You ask it
for an agent with a role and a brief; it starts one on a host with room, when
the account's usage allows, and shows you every agent, its transcript and
whether it needs you. Each machine that runs agents runs
[agency-host](https://github.com/dakotacolorado/agency-host), which connects
to agency.

## Run it

```sh
npm ci
AUTH_TOKEN=<a secret> node src/cli.ts --services services.json
```

Open the page it prints and sign in with the token. Point each host's
agency-host at its address and the same token.

`node src/cli.ts backup <file>` writes a consistent copy of the database while
it serves.

## Configure it

| Option | Environment | Default | What it does |
| --- | --- | --- | --- |
| `--host` | `AGENCY_HOST` | `127.0.0.1` | Address to listen on. |
| `--port` | `AGENCY_PORT` | `4600` | Port to listen on. |
| `--db` | `AGENCY_DB` | `~/.local/share/agency/agency.db` | The SQLite file. |
| `--public-url` | `AGENCY_URL` | the address each request came to | The address agents and hosts reach agency at. |
| `--services` | `AGENCY_SERVICES` | none | JSON file of the other services a session may be given. |
| `--retire-closed-after` | `AGENCY_RETIRE_CLOSED_AFTER` | `14` | Days an agent stays `done` with no session before the hourly sweep deletes it, as `DeleteAgent` does. `0` never deletes one. |
| | `AUTH_TOKEN` | none | The token every caller and host presents. Without it, every call but `/health` and `/openapi.json` answers 503. |
| | `AGENCY_NUDGE_URL`, `AGENCY_NUDGE_TOKEN` | none | A [nudge](https://github.com/dakotacolorado/nudge) server and producer token, to notify you while an agent is waiting on you or in review (see [How it works](#how-it-works)). Set both or neither. |
| | `AGENCY_WORKER_PAGE_URL` | agency's own page | The base address a notification links to, with `/workers/<agent id>` appended, such as a workplace-ui. |

The services file names each service and where its token comes from. No token
goes in the file:

```json
{
  "waypoint": { "url": "https://waypoint.example:8444", "urlVar": "WAYPOINT_URL", "tokenVar": "WAYPOINT_TOKEN", "tokenEnv": "WAYPOINT_TOKEN", "mcp": "/mcp" }
}
```

A session given `waypoint` gets `url` in `$urlVar` and the token, read from
agency's own `$tokenEnv`, in `$tokenVar`. With `mcp`, the session also gets
that MCP server. A service that runs an instance on each host can add
`"urlByHost": {"<host id>": "<url>"}`: a session on a host it names gets that
address in `$urlVar` instead of `url`. A service named `honed` is where roles and skills are read
from.

## Use it

- API reference: [`docs/API.md`](./docs/API.md), served at `/docs/api`;
  contract in [`openapi.json`](./openapi.json).
- MCP server at `/mcp`: [`docs/MCP.md`](./docs/MCP.md), served at
  `/docs/mcp`; contract in [`mcp.json`](./mcp.json).

Ask for an agent:

```sh
curl -X POST "$AGENCY_URL/requests" \
  -H "Authorization: Bearer $AUTH_TOKEN" -H 'content-type: application/json' \
  -d '{"role": "implementer", "brief": "Fix the login bug."}'
```

## How it works

- **Roles and skills** live in honed. A role is the skill
  `agent-roles/<name>`: what the agent is told, plus its settings in
  `role.json`. An agent gets its role's skills and the ones it names.
- **A request** waits until both usage windows are under 90% and a connected
  host with the right labels has a free slot. The highest-priority role starts
  first, then the oldest. A waiting request says why it waits.
- **One agent to an item.** A request for an `item` that already has an
  agent (not deleted or `done`) or a waiting request is refused with 409,
  naming who is on it. Send `"another": true` to ask for one more anyway.
- **An agent's status** is what it says through its `page` skill: `working`,
  `waiting` (on you) or `done`. A turn that ends without one reads `waiting`.
  A message to a waiting agent makes it `working`.
- **A notification**, with nudge set, is open while an agent is `waiting`
  (urgent) or in `review` (normal), and updated when its summary changes.
  `done`, `working` and `idle` notify you of nothing, since they ask nothing
  of you. It is taken back as soon as the agent leaves `waiting` or `review`,
  is sent a message or an interrupt, or is deleted or retired. On start and
  every hour, agency takes back any it left open and posts any missing.
- **A session** is one run of an agent. One that dies leaves its agent
  `interrupted`, and it can be resumed.
- **A usage limit** that stops an agent's turn is reported by its host as
  `limitedUntil`, when the limit resets. About a minute after that, agency
  tells the agent its limit has reset and to carry on, starting its session
  again if it has none. A limit still in force stops it again, and it waits
  for the next reset.
- **A host** silent for 60 seconds is `disconnected`, and after 300 seconds
  `lost`. Commands to a host wait in its queue and are replayed when it
  reconnects.

## Develop it

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run spec` regenerates `openapi.json`, `mcp.json` and the docs.

## License

MIT. See [LICENSE](./LICENSE).
