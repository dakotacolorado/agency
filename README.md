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
| `--default-runtime` | `AGENCY_DEFAULT_RUNTIME` | `container` | Where an agent runs when its request's labels do not include `runtime:host`: `container` or `host`. |
| `--capabilities` | `AGENCY_CAPABILITIES` | 1 `claude-haiku-5-5`, 2 `claude-sonnet-5-5`, 3 `claude-opus-5-5`, at list prices | JSON file of the model each capability (1-3) runs an agent on and its `prices`; each capability it names replaces that one's default (see below). |
| | `AUTH_TOKEN` | none | The token every caller and host presents. Without it, every call but `/health` and `/openapi.json` answers 503. |
| | `AGENCY_NUDGE_URL`, `AGENCY_NUDGE_TOKEN` | none | A [nudge](https://github.com/dakotacolorado/nudge) server and producer token, to notify you while an agent is waiting on you or in review (see [How it works](#how-it-works)). Set both or neither. |
| | `AGENCY_KEYRING_URL`, `AGENCY_KEYRING_TOKEN` | none | A [keyring](https://github.com/dakotacolorado/keyring) server and a resolver token. Each new or resumed session is given the secrets keyring grants it, over the services' tokens: keyring's value wins. While keyring cannot be reached, no session starts and its request says why. Set both or neither. |
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

The capabilities file gives each capability its `model`, an optional
`effort` (`low`, `medium`, `high` or `xhigh`; null for Claude Code's default)
and an optional `priceStepAt`, the context size in tokens above which the
model's price goes up. By default only capability 1 has one, `100000`.
Its optional `prices`, in US dollars per million tokens, price each session's
`estimatedCostUsd`; `aboveStep` gives the prices past `priceStepAt`. An entry
without `prices` whose model is a default's keeps that model's prices:

```json
{
  "1": { "model": "claude-haiku-5-5", "effort": null, "priceStepAt": 100000 },
  "2": { "model": "claude-sonnet-5-5", "effort": "high",
         "prices": { "input": 2, "output": 10, "cacheRead": 0.1, "cacheWrite": 4, "aboveStep": null } }
}
```

The default prices (Anthropic's list prices, 2026-11; cache writes at the
1-hour TTL Claude Code uses):

| Model | Input | Output | Cache read | Cache write |
| --- | --- | --- | --- | --- |
| `claude-opus-5-5` | 4 | 20 | 0.20 | 8 |
| `claude-sonnet-5-5` | 2 | 10 | 0.10 | 4 |
| `claude-haiku-5-5`, up to 100k context | 0.10 | 0.50 | 0.01 | 0.20 |
| `claude-haiku-5-5`, past 100k | 0.50 | 2.50 | 0.05 | 1.00 |

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

See what every session on a task spent, and on which models (add
`&format=csv` for a spreadsheet):

```sh
curl "$AGENCY_URL/sessions?item=<task id>" -H "Authorization: Bearer $AUTH_TOKEN"
```

## How it works

- **Roles and skills** live in honed. A role is the skill
  `agent-roles/<name>`: what the agent is told, plus its settings in
  `role.json`. An agent gets its role's skills and the ones it names.
- **Capability** picks an agent's model: 3 is today's default and the
  ceiling, 2 and 1 a step and two down, for easier work. A caller gives
  `capability` to `CreateAgent` or `CreateRequest`, never a model; without
  one, the agent takes its role's (`role.json`'s `capability`, 3 when absent).
  `GET /capabilities` lists the map. `PUT /agents/{id}/capability` changes a
  live agent's: its session switches model at its next request, at the cost
  of one prompt-cache rewrite, and an idle agent's next start uses it. An
  agent shows its `model` and last `contextTokens`, and `overPriceStep` once
  that is above its model's `priceStepAt`.
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
- **Where an agent runs.** Agents run in containers by default. A request
  whose `labels` include `runtime:host` runs its agent on the host instead,
  for host work such as installs, `/etc`, podman builds or the host's
  systemd. **A host agent may not have full functionality:** the host may
  lack the tools, logins or environment a container gets. The runtime is
  chosen when the agent is made and kept for its life; each agent's
  `runtime` says which it has.
- **A session** is one run of an agent. One that dies leaves its agent
  `interrupted`, and it can be resumed. Each keeps a record, after its agent
  is deleted too (`GET /sessions`): its agent, role, task, capability and
  model at start and each capability change, each model's tokens, start, end,
  time in turns, turns and why it ended. A live agent's `currentSession` is
  its record so far.
- **A session's cost** is an estimate at API list prices: the account may be
  on a subscription, which bills otherwise. agency does not know each
  request's context size, so a model with a price step is priced above it for
  the whole session once its context went past `priceStepAt`. Sessions from
  before records kept them have tokens only, and no cost.
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
