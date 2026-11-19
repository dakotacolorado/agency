# agency API

Generated from this deployment's `openapi.json`. `bin/` adds the address, the bearer token and `claimed-by`, so a path is all a call needs. A field marked `?` is optional.

agency: Agents at your command, across all your computers. People, their Claude Code and agents themselves use this API to start agents on your computers, talk to them and follow what they do. It runs lasting Claude Code **agents** on a fleet of hosts. Each agent lives on one host and runs in **sessions**; a **role** says what it starts with.

- **Create** an agent on a host, or **request** one in a role, started once Claude usage and a host's room allow. Admission starts the highest role `priority` first, then the oldest.
- **Talk to it** with `SendMessage`, which starts a session carrying on its conversation when none is live; `StopAgent` ends its session and keeps it, for a message to start it again; `DeleteAgent` ends it for good. Its session also ends when it says it is done and its role says so.
- **Follow it**: its `status` is `working`, `idle`, `waiting` (on the person), `review` or `done`, which it says of itself with `PutAgentStatus`; `ListTranscriptLines` reads what it said, after a cursor.
- **Hosts** run agency-host, which keeps a WebSocket open at `/socket`: heartbeats and reports go up it, commands come down it (`SocketInbound`, `SocketOutbound`). You don't call it. A page watches live with a ticket from `CreateSocketTicket`.

**Auth:** `Authorization: Bearer <token>` with the stage's token, on everything but `GetHealth`, the page and the docs.

**Roles** are honed skills, `agent-roles/<name>`, read here and changed in honed.

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

Called by the agent itself, from its `page` skill, and by approval-service for the agent whose change it took or shipped. `waiting` says the agent needs the person; it stands until the person messages it. `working` only says what it is doing: whether it reads `working` or `idle` is its host's turns. `review` says its change is submitted to approval-service and `done` that it finished, or its change shipped; each needs no live session. Not sent to its host. Once the agent is in `review` or `done` and no turn or background task of its runs, `whenDone` is carried out: `stop` stops its session, and `delete` deletes it once `done` (in `review` it is stopped, never deleted, so a send-back reaches it).

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | Assigned by the service when the agent is created. |

Body: `AgentStatus`. What the agent says of itself.

- 200: Recorded. → `Agent`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: Missing or incorrect bearer token. → `Error`
- 404: ResourceNotFoundException: No agent has this id. → `Error`
- 409: ConflictException: The agent is deleted, or has no live session to be `working` or `waiting`. → `Error`
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
- 409: ConflictException: The agent is deleted, or has a title already. → `Error`
- 503: ServiceUnavailableException: No API token is configured. → `Error`

# Schemas

## Agent

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) | Assigned by the service when the agent is created. |
| `name` | string | Unique among agents not deleted. Names its home folder and tmux session on its host. |
| `title` | string or null | What the agent named itself for its work, with `PutAgentTitle`, or the person with `UpdateAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host. |
| `label` | string or null | A short tag given when it was made or with `UpdateAgent`, shown beside its name. Null for none. |
| `item` | string or null (min 1, max 64) | The work item it was started on, as given when it was made; null for none. |
| `role` | string or null | The role it was made from, as given when it was made; null for one made without. |
| `tokens` | `Tokens` |  |
| `createdBy` | string or null | The `claimed-by` header of the `CreateAgent` call that made it, unverified. Null when it had none. |
| `whenDone` | `keep`, `stop`, `delete` | What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `delete`, it is stopped and deleted, as by `DeleteAgent`. On `review`, `stop` and `delete` both only stop its session, so a send-back can still start it again. Whatever it is, an agent `done` with no session for longer than agency's `--retire-closed-after` days (14 unless set) is deleted by its hourly sweep. |
| `runtime` | `container`, `host` | Where its sessions run. `container`: in a container on its host, with the tools, logins and environment agents are given. `host`: on the host itself, for host work such as installs, `/etc`, podman builds or the host's systemd; a host agent may not have full functionality, since the host may lack the tools, logins or environment a container gets. Chosen when it is made, `host` when its labels include `runtime:host` and otherwise agency's default (`container`, unless `AGENCY_DEFAULT_RUNTIME` says otherwise), and kept for its life. An agent made before runtimes were chosen is `host`. |
| `capability` | integer (≥ 1, ≤ 3) | How capable a model it runs on, 1 to 3: the one it was made or requested with, else its role's, as `SetAgentCapability` last changed it. An agent made before capabilities is 3. |
| `model` | string | Its capability's model, as `ListCapabilities` maps it now: what its next start, or a live session told with `configure`, runs on. |
| `contextTokens` | integer or null (≥ 0) | How large its session's context was at its last request to the model (input plus cache read plus cache write tokens), as its host last reported; null until one is reported. |
| `contextAddedTokens` | integer or null (≥ 0) | How many tokens its session's context grew by at its last request to the model, over the request before it (its `contextTokens` less that one's), as its host last reported; null until one is, and null again when a report's `contextTokens` falls (a compaction) without one. |
| `overPriceStep` | boolean | True when `contextTokens` is above its model's `priceStepAt`, past which each token costs more: such a session is worth ending or compacting. False otherwise, or when the model has no step. |
| `skills` | string[] | The honed skills each session is given, by name: its role's own first. |
| `credentials` | array or null | The services each session is given, by name; null for every one the stage has. Never a token. |
| `hostId` | string | The host it lives on. |
| `state` | `idle`, `working`, `waiting`, `interrupted`, `deleted` | `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `deleted`: no longer on the team; its home folder is kept on the host. |
| `session` | object or null | The live session, or null for none: when it started, and what it started with. |
| `createdAt` | string (date-time) | When it was made. |
| `reportedAt` | string or null (date-time) | When its host last reported a change to it; null until its host first reports it. |
| `status` | `working`, `idle`, `waiting`, `review`, `done`, `null` | What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `PutAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `PutAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person. |
| `summary` | string or null | One line it, or approval-service, last said with `PutAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person. |
| `headline` | string or null | A few words said with its `summary` and gone with it, for a list of agents. Null when none was given. |
| `saidAt` | string or null (date-time) | When `summary` was said; null when there is none. |
| `activity` | object or null | What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something. |
| `tasks` | integer (≥ 0) | Background tasks and subagents its live session has open, as its host last reported; 0 without one. |
| `told` | boolean or null | Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said. |
| `limitedUntil` | string or null (date-time) | When the usage limit that stopped its last turn resets, as its host reported; null when no limit stopped it. About a minute after that time, agency sends it `Your usage limit has reset. Carry on from where you were stopped.` as `SendMessage` would (a `message` to a live session, else a `start` resuming its last conversation) and clears this, so each limit resumes it once. A message sent to it, or a report without it, clears it too. |
| `hostStatus` | `connected`, `disconnected`, `lost` | Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date. |
| `lifetimeCostUsd` | number or null | The estimated cost of every session it has had, ended or live, each priced as in `ListSessions`; null when none can be priced. |
| `sessionCount` | integer | How many sessions it has had, ended or live. |
| `currentSession` | `Session` |  |

## Tokens

Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.

| Field | Type | |
| --- | --- | --- |
| `inputTokens` | integer (≥ 0, ≤ 9007199254740991) | Input tokens not read from or written to the prompt cache. |
| `outputTokens` | integer (≥ 0, ≤ 9007199254740991) | Output tokens. |
| `cacheCreationInputTokens` | integer (≥ 0, ≤ 9007199254740991) | Input tokens written to the prompt cache. |
| `cacheReadInputTokens` | integer (≥ 0, ≤ 9007199254740991) | Input tokens read from the prompt cache. |

## Session

Its live session's record, as `ListSessions` lists it, so far; null without a live session.

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) | Assigned by the service when it queues the session's `start`. |
| `agentId` | string (uuid) | Assigned by the service when the agent is created. |
| `agentName` | string or null | Its agent's name as the session started; null on a record whose agent was never on record. |
| `role` | string or null | The role its agent was made from; null for none. |
| `item` | string or null (min 1, max 64) | The work item its agent was started on; null for none. |
| `capability` | integer or null (≥ 1, ≤ 3) | Its agent's capability as it started; null on a session from before it was kept. |
| `model` | string or null | The model it started on; null on a session from before it was kept. |
| `capabilityChanges` | {at: string (date-time), from: integer (≥ 1, ≤ 3), to: integer (≥ 1, ≤ 3)}[] | Each `SetAgentCapability` while it was live, oldest first. |
| `tokens` | `Tokens` and any |  |
| `modelsUsed` | {model: string, inputTokens: integer (≥ 0, ≤ 9007199254740991), outputTokens: integer (≥ 0, ≤ 9007199254740991), cacheCreationInputTokens: integer (≥ 0, ≤ 9007199254740991), cacheReadInputTokens: integer (≥ 0, ≤ 9007199254740991), estimatedCostUsd: number or null (≥ 0)}[] | Each model's tokens, as its host reported them by model; from a host that reports none by model, all its tokens on `model`. Empty on a session from before its model was kept. |
| `estimatedCostUsd` | number or null (≥ 0) | `modelsUsed`'s costs summed, those with no price left out. An estimate at API list prices, from the stage's capability map (`ListCapabilities`): the account may be on a subscription, which bills otherwise. agency does not know each request's context size, so a model with a price step is priced above it for the whole session once its `peakContextTokens` went past `priceStepAt`, which errs high. Null on a session from before its model was kept. |
| `startedAt` | string (date-time) | When its `start` was queued. |
| `endedAt` | string or null (date-time) | When it stopped, finished or died; null while it is live. |
| `activeMs` | integer or null | Time it spent in turns, in ms, as its host reported; null on a session from before it was kept. |
| `turns` | integer or null | Turns it took, as its host reported; null on a session from before it was kept. |
| `peakContextTokens` | integer or null | The largest context its host reported while it was live; null until one is. |
| `endReason` | `stopped`, `interrupted`, `limit`, `null` | `stopped`: told to stop, deleted, or its host ended it cleanly. `interrupted`: it died. `limit`: it ended while a usage limit held its agent. Null while live. |
| `skills` | {name: string, version: integer}[] | The honed skills it started with, in order. |
| `secretNames`? | string[] | The environment variables keyring's secrets set in it: names only, never a value. Absent on a session from before they were kept. |

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
