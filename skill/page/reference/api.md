# agent-service API

Generated from this deployment's `openapi.json`. `bin/` adds the address, the bearer token and `claimed-by`, so a path is all a call needs. A field marked `?` is optional.

Runs lasting Claude Code **agents** on a fleet of hosts. Each agent lives on one host and runs in **sessions**; a **role** says what it starts with.

- **Create** an agent on a host, or **request** one in a role, started once Claude usage and a host's room allow. Admission starts the highest role `priority` first, then the oldest.
- **Talk to it** with `SendMessage`, which starts a session when none is live; `StopAgent`, `ResumeAgent` and `RetireAgent` end, carry on and end it for good.
- **Follow it**: its `status` is `working`, `idle`, `waiting` (on the person), `review` or `done`, which it says of itself with `PutAgentStatus`; `ListTranscriptLines` reads what it said, after a cursor.
- **Hosts** run agent-host, which sends heartbeats and takes commands on a WebSocket at `socketUrl`, through the *Host protocol* calls. You don't call those. A page watches live with a ticket from `CreateSocketTicket`.

**Auth:** `Authorization: Bearer <token>` with the stage's token, or the admin token, which also writes roles, on everything but `GetHealth` and the docs.

**Errors:** `{code, message}`, where `code` is an AWS-style exception name such as `ValidationException` or `ResourceNotFoundException`.

## GET /agents/{id}

Get an agent.

Get one agent.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | Assigned by the service when the agent is created. |

- 200: The agent. → `Agent`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: Missing or incorrect bearer token. → `Error`
- 404: ResourceNotFoundException: No agent has this id. → `Error`
- 503: ServiceUnavailableException: No API token is configured. → `Error`

## PUT /agents/{id}/status

Put an agent's status.

Called by the agent itself, from its `page` skill, and by approval-service for the agent whose change it took or shipped. `waiting` says the agent needs the person; it stands until the person messages it. `working` only says what it is doing: whether it reads `working` or `idle` is its host's turns. `review` says its change is submitted to approval-service and `done` that it finished, or its change shipped; each needs no live session. Not sent to its host. Once the agent is in `review` or `done` and no turn or background task of its runs, `whenDone` is carried out: `stop` stops its session, and `retire` retires it once `done` (in `review` it is stopped, never retired, so a send-back reaches it).

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | Assigned by the service when the agent is created. |

Body: `AgentStatus`. What the agent says of itself.

- 200: Recorded. → `Agent`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: Missing or incorrect bearer token. → `Error`
- 404: ResourceNotFoundException: No agent has this id. → `Error`
- 409: ConflictException: The agent is retired, or has no live session to be `working` or `waiting`. → `Error`
- 503: ServiceUnavailableException: No API token is configured. → `Error`

## PUT /agents/{id}/title

Put an agent's title.

Called by the agent itself, early in its first session, once it knows what it is there to do. Set once: after that only the person changes it, with `UpdateAgent`.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | Assigned by the service when the agent is created. |

Body: `AgentTitle`. What the agent names itself.

- 200: Recorded. → `Agent`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: Missing or incorrect bearer token. → `Error`
- 404: ResourceNotFoundException: No agent has this id. → `Error`
- 409: ConflictException: The agent is retired, or has a title already. → `Error`
- 503: ServiceUnavailableException: No API token is configured. → `Error`

# Schemas

## Agent

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) | Assigned by the service when the agent is created. |
| `name` | string | Unique among agents not retired. Names its home folder and tmux session on its host. |
| `title` | string or null | What the agent named itself for its work, with `PutAgentTitle`, or the person with `UpdateAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host. |
| `label` | string or null | A short tag given when it was made or with `UpdateAgent`, shown beside its name. Null for none. |
| `item` | string or null (min 1, max 64) | The work item it was started on, as given when it was made; null for none. |
| `role` | string or null | The role it was made from, as given when it was made; null for one made without. |
| `tokens` | `Tokens` |  |
| `createdBy` | string or null | The `claimed-by` header of the `CreateAgent` call that made it, unverified. Null when it had none. |
| `whenDone` | `keep`, `stop`, `retire` | What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again. |
| `documents` | string[] | The honed skills each session is given after `workplace/global`, by name. |
| `credentials` | array or null | The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own. |
| `hostId` | string | The host it lives on. |
| `state` | `idle`, `working`, `waiting`, `interrupted`, `retired` | `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host. |
| `session` | object or null | The live session, or null for none. |
| `createdAt` | string (date-time) | When it was made. |
| `reportedAt` | string or null (date-time) | When its host last reported a change to it; null until its host first reports it. |
| `status` | `working`, `idle`, `waiting`, `review`, `done`, `null` | What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `PutAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `PutAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person. |
| `summary` | string or null | One line it, or approval-service, last said with `PutAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person. |
| `headline` | string or null | A few words said with its `summary` and gone with it, for a list of agents. Null when none was given. |
| `saidAt` | string or null (date-time) | When `summary` was said; null when there is none. |
| `activity` | object or null | What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something. |
| `tasks` | integer (≥ 0) | Background tasks and subagents its live session has open, as its host last reported; 0 without one. |
| `told` | boolean or null | Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said. |
| `hostStatus` | `connected`, `disconnected`, `lost` | Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date. |

## Tokens

Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.

| Field | Type | |
| --- | --- | --- |
| `inputTokens` | integer (≥ 0, ≤ 9007199254740991) | Input tokens not read from or written to the prompt cache. |
| `outputTokens` | integer (≥ 0, ≤ 9007199254740991) | Output tokens. |
| `cacheCreationInputTokens` | integer (≥ 0, ≤ 9007199254740991) | Input tokens written to the prompt cache. |
| `cacheReadInputTokens` | integer (≥ 0, ≤ 9007199254740991) | Input tokens read from the prompt cache. |

## Error

Every error's body.

| Field | Type | |
| --- | --- | --- |
| `code` | `ValidationException`, `UnauthorizedException`, `AccessDeniedException`, `ResourceNotFoundException`, `ConflictException`, `InternalServerException`, `ServiceUnavailableException` | Exception name. |
| `message` | string | What went wrong. |

## AgentStatus

| Field | Type | |
| --- | --- | --- |
| `status` | `working`, `waiting`, `review`, `done` | `working` or `waiting` (on the person) while its session is live; `review` once its change is submitted, `done` once it has finished. |
| `summary` | string (min 1, max 280) | One line: what it is doing, while `waiting` what it needs from the person, in `review` what it submitted, or when `done` the result. |
| `headline`? | string (min 1, max 29) | The summary in a few words a person can scan in a list, e.g. "Needs merge OK". Omitted, it is null. |

## AgentTitle

| Field | Type | |
| --- | --- | --- |
| `title` | string (min 1, max 40) | What the agent is there to do, in a few words. |
