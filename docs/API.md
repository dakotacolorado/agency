# agent-service

> Version 0.1.0

The API for agents: lasting agents, each living on one host, run in sessions. Hosts send a heartbeat every 30 seconds, which keeps them `connected` and says what they offer. Clients read state and issue commands. Every route under every route needs the stage's bearer token.

Commands and reports go by WebSocket at `socketUrl` alone: a host connects with `?hostId=<id>` and the stage's token as `Authorization: Bearer`, a page with `?ticket=<one-time ticket>` from `createSocketTicket`. What goes up is a `SocketInbound` (`report`, `ping`), and what comes down a `SocketOutbound`: a host's sockets get each `command` as it is queued, and a host's socket, once open, every command still pending for it; every viewer gets each `agent` as it changes, `lines` as they arrive and the `host` on each heartbeat. A command stays queued until a report names it, so a dropped socket loses nothing: it is replayed on the next.

No body carries the server's time: a response's `Date` header is when it was made, and so when a host's `status` was computed.


## Path Table

| Method | Path | Description |
| --- | --- | --- |
| GET | [/health](#gethealth) | Health check |
| GET | [/skill](#getskill) | Read the clients agents call this deployment with |
| POST | [/hosts/{id}/heartbeat](#posthostsidheartbeat) | Keep the host connected, and say what it offers |
| GET | [/hosts](#gethosts) | List hosts |
| DELETE | [/hosts/{id}](#deletehostsid) | Deregister a host |
| GET | [/roles](#getroles) | List roles |
| POST | [/roles](#postroles) | Create a role |
| GET | [/roles/{name}](#getrolesname) | Get one role |
| PATCH | [/roles/{name}](#patchrolesname) | Change a role |
| POST | [/requests](#postrequests) | Ask for an agent in a role, to start when usage and a host allow |
| GET | [/requests](#getrequests) | List requests for agents |
| GET | [/requests/{id}](#getrequestsid) | Get one request for an agent |
| DELETE | [/requests/{id}](#deleterequestsid) | Withdraw a waiting request, so it never starts |
| POST | [/agents](#postagents) | Create an agent on a host |
| GET | [/agents](#getagents) | List agents |
| GET | [/agents/{id}](#getagentsid) | Get one agent |
| PATCH | [/agents/{id}](#patchagentsid) | Rename an agent, or change or clear its title or label |
| DELETE | [/agents/{id}](#deleteagentsid) | Retire an agent |
| POST | [/agents/{id}/messages](#postagentsidmessages) | Send an agent a message, or interrupt it |
| POST | [/agents/{id}/stop](#postagentsidstop) | Stop an agent's session, or force it idle |
| POST | [/agents/{id}/resume](#postagentsidresume) | Start a session continuing the agent's last conversation |
| PUT | [/agents/{id}/status](#putagentsidstatus) | Say whether the agent needs the person, is in review or done, and what on |
| PUT | [/agents/{id}/title](#putagentsidtitle) | Name the agent for its work, once |
| GET | [/agents/{id}/transcript](#getagentsidtranscript) | List an agent's transcript lines after a cursor, oldest first, across its sessions |
| GET | [/agents/{id}/sessions](#getagentsidsessions) | List an agent's sessions, oldest first |
| GET | [/agents/{id}/sessions/{sessionId}/context](#getagentsidsessionssessionidcontext) | Read a live session's whole context, when its start was too large to carry it |
| GET | [/agents/{id}/commands](#getagentsidcommands) | List the commands sent to an agent, oldest first, with their delivery |
| GET | [/usage](#getusage) | Read how much of the Claude account's 5-hour and weekly allowance is used |
| POST | [/socket-tickets](#postsocket-tickets) | Trade the bearer token for a one-time socket ticket |

## Reference Table

| Name | Path | Description |
| --- | --- | --- |
| bearerAuth | [#/components/securitySchemes/bearerAuth](#componentssecurityschemesbearerauth) |  |
| SocketInbound | [#/components/schemas/SocketInbound](#componentsschemassocketinbound) |  |
| SocketReport | [#/components/schemas/SocketReport](#componentsschemassocketreport) | Host to service, the only way a host reports: whenever something changes, and in full (every agent, every line and result not yet sent) whenever its socket connects. Pushed on to viewers. Idempotent: lines by (`agentId`, `seq`), results by `commandId`. Does not count as a heartbeat. A socket message is at most 128 KB, sent in frames of 32 KB at most, so lines that would not fit go in the reports after it. |
| AgentReport | [#/components/schemas/AgentReport](#componentsschemasagentreport) |  |
| LineReport | [#/components/schemas/LineReport](#componentsschemaslinereport) |  |
| CommandReport | [#/components/schemas/CommandReport](#componentsschemascommandreport) |  |
| SessionTokensReport | [#/components/schemas/SessionTokensReport](#componentsschemassessiontokensreport) | A session's running total of tokens so far, not what was used since the last report. The service keeps the highest of each count reported for the session, so a total sent again, or late, never adds twice. |
| UsageReport | [#/components/schemas/UsageReport](#componentsschemasusagereport) | The account's usage, when a session's stream has said it since the last report. |
| UsageWindowReport | [#/components/schemas/UsageWindowReport](#componentsschemasusagewindowreport) | The 5-hour window; absent when the event did not carry it. |
| SocketPing | [#/components/schemas/SocketPing](#componentsschemassocketping) | Either side's keep-alive, beside the server's WebSocket pings, which close a socket that misses one. |
| SocketOutbound | [#/components/schemas/SocketOutbound](#componentsschemassocketoutbound) |  |
| CommandPush | [#/components/schemas/CommandPush](#componentsschemascommandpush) | To every socket of the command's host, the moment it is queued; and to a host's socket once it is open, every command still pending for that host, oldest first. That replay follows the first message the host sends on it (its full report on connecting), and leaves out commands that message reports. A command is pending until a report names it, or until it is withdrawn; a host may see one more than once, and knows it by `id`. |
| Command | [#/components/schemas/Command](#componentsschemascommand) |  |
| CreateCommand | [#/components/schemas/CreateCommand](#componentsschemascreatecommand) | Make the agent's home folder. |
| StartCommand | [#/components/schemas/StartCommand](#componentsschemasstartcommand) |  |
| MessageCommand | [#/components/schemas/MessageCommand](#componentsschemasmessagecommand) | Deliver `text` at the session's next turn. |
| InterruptCommand | [#/components/schemas/InterruptCommand](#componentsschemasinterruptcommand) |  |
| StopCommand | [#/components/schemas/StopCommand](#componentsschemasstopcommand) | End the session; the agent becomes idle. |
| RetireCommand | [#/components/schemas/RetireCommand](#componentsschemasretirecommand) | Stop any session and take the agent off the host. Its home folder is kept. |
| AgentPush | [#/components/schemas/AgentPush](#componentsschemasagentpush) | To viewers, whenever an agent changes. |
| Agent | [#/components/schemas/Agent](#componentsschemasagent) |  |
| Tokens | [#/components/schemas/Tokens](#componentsschemastokens) | Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows. |
| LinesPush | [#/components/schemas/LinesPush](#componentsschemaslinespush) | To viewers, as lines arrive. |
| TranscriptLine | [#/components/schemas/TranscriptLine](#componentsschemastranscriptline) |  |
| SentPush | [#/components/schemas/SentPush](#componentsschemassentpush) | To viewers, when a command carrying `text` (a `message`, a `start` or an `interrupt`) is queued, and each time its `delivery` changes, but for a time-based `withdrawn`, which a read of `listAgentCommands` says. |
| SentCommand | [#/components/schemas/SentCommand](#componentsschemassentcommand) |  |
| HostPush | [#/components/schemas/HostPush](#componentsschemashostpush) | To viewers, on every heartbeat. |
| Host | [#/components/schemas/Host](#componentsschemashost) |  |
| UsagePush | [#/components/schemas/UsagePush](#componentsschemasusagepush) | To viewers, when a report brings a newer reading of the account's usage. |
| Usage | [#/components/schemas/Usage](#componentsschemasusage) | How much of the Claude account's 5-hour and weekly allowance is used, as last reported. |
| UsageWindow | [#/components/schemas/UsageWindow](#componentsschemasusagewindow) | The 5-hour window's newest reading; null when none has been reported. |
| SocketError | [#/components/schemas/SocketError](#componentsschemassocketerror) | To the socket whose message could not be handled, saying why. |
| Skill | [#/components/schemas/Skill](#componentsschemasskill) |  |
| Error | [#/components/schemas/Error](#componentsschemaserror) |  |
| HeartbeatResponse | [#/components/schemas/HeartbeatResponse](#componentsschemasheartbeatresponse) |  |
| Heartbeat | [#/components/schemas/Heartbeat](#componentsschemasheartbeat) |  |
| HostList | [#/components/schemas/HostList](#componentsschemashostlist) |  |
| RoleList | [#/components/schemas/RoleList](#componentsschemasrolelist) |  |
| Role | [#/components/schemas/Role](#componentsschemasrole) |  |
| NewRole | [#/components/schemas/NewRole](#componentsschemasnewrole) |  |
| RoleChange | [#/components/schemas/RoleChange](#componentsschemasrolechange) |  |
| AgentRequest | [#/components/schemas/AgentRequest](#componentsschemasagentrequest) |  |
| NewAgentRequest | [#/components/schemas/NewAgentRequest](#componentsschemasnewagentrequest) |  |
| AgentRequestList | [#/components/schemas/AgentRequestList](#componentsschemasagentrequestlist) |  |
| NewAgent | [#/components/schemas/NewAgent](#componentsschemasnewagent) |  |
| AgentList | [#/components/schemas/AgentList](#componentsschemasagentlist) |  |
| Accepted | [#/components/schemas/Accepted](#componentsschemasaccepted) |  |
| Message | [#/components/schemas/Message](#componentsschemasmessage) |  |
| Stop | [#/components/schemas/Stop](#componentsschemasstop) |  |
| AgentRename | [#/components/schemas/AgentRename](#componentsschemasagentrename) |  |
| AgentStatus | [#/components/schemas/AgentStatus](#componentsschemasagentstatus) |  |
| AgentTitle | [#/components/schemas/AgentTitle](#componentsschemasagenttitle) |  |
| Transcript | [#/components/schemas/Transcript](#componentsschemastranscript) |  |
| Cursor | [#/components/schemas/Cursor](#componentsschemascursor) | Pass as `after` to read what follows. Unchanged when nothing does yet. |
| SessionList | [#/components/schemas/SessionList](#componentsschemassessionlist) |  |
| Session | [#/components/schemas/Session](#componentsschemassession) |  |
| SessionContext | [#/components/schemas/SessionContext](#componentsschemassessioncontext) |  |
| AgentCommands | [#/components/schemas/AgentCommands](#componentsschemasagentcommands) |  |
| SocketTicket | [#/components/schemas/SocketTicket](#componentsschemassocketticket) |  |

## Path Details

***

### [GET]/health

- Summary  
  Health check

- Operation id  
  healthCheck

- Tags  
  meta

#### Responses

- 200 Service is up.

`application/json`

```typescript
{
  ok: enum[true]
  // The package's version.
  version: string
  // The commit it was built from, ending `-dirty` when built with uncommitted changes.
  commit: string
}
```

***

### [GET]/skill

- Summary  
  Read the clients agents call this deployment with

- Operation id  
  getSkill

- Description  
  The `page` and `title` skills, `SKILL.md`, `bin/` and `reference/`, as this deployment was built with them. Every start lays them, and each other service's `GET /skill` (its `bin/` and `reference/` alone), over `workplace/global`'s files at the same paths, so an agent calls the API that is deployed.

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Responses

- 200 The skills' files.

`application/json`

```typescript
{
  // Whose skills these are: `agent-service`.
  key: string
  // The deployed tree's commit count, 0 when deployed from outside git.
  version: integer
  // The deployed commit, ending `-dirty` when deployed with uncommitted changes.
  commit: string
  files: {
    // Under the agent's Claude Code folder: `skills/<name>/bin/…` or `skills/<name>/reference/…`.
    path: string
    content: string
    executable: boolean
  }[]
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/hosts/{id}/heartbeat

- Summary  
  Keep the host connected, and say what it offers

- Operation id  
  heartbeat

- Description  
  Liveness and what the host offers, nothing more: commands come down the host's socket at `socketUrl`, and reports go up it. The host chooses its id; the first heartbeat from an id registers it. Only a heartbeat keeps a host `connected`.

- Tags  
  hosts

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
id: string //pattern: ^[A-Za-z0-9._-]{1,64}$
```

#### RequestBody

What the host is and offers.

- application/json

```typescript
{
  // The agent-host build that sent the heartbeat.
  version: string //maxLength: 64
  labels?: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$ //maxItems: 64
  // How many sessions the host will run at once. Absent, capacity is unknown.
  capacity?: integer //minimum: 0 //maximum: 256
}
```

#### Responses

- 200 Accepted.

`application/json`

```typescript
{
  // Seconds until the host should send its next heartbeat.
  heartbeatInterval: integer //exclusiveMinimum: 0
  // Where to open the host's socket: `<socketUrl>?hostId=<id>` with this token as `Authorization: Bearer`. Commands and reports go by the socket alone, so on a server with none (null) no command reaches the host.
  socketUrl: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/hosts

- Summary  
  List hosts

- Operation id  
  listHosts

- Description  
  Every host that has sent a heartbeat since it was last deregistered with `deleteHost`, however long it has been `lost`. With `status`, only the hosts with one of those statuses.

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Parameters(Query)

```typescript
// Comma-separated, any of `connected`, `disconnected`, `lost`.
// Comma-separated, any of `connected`, `disconnected`, `lost`.
status?: string //pattern: ^(connected|disconnected|lost)(,(connected|disconnected|lost))*$
```

#### Responses

- 200 The hosts listed.

`application/json`

```typescript
{
  hosts: {
    id: string //pattern: ^[A-Za-z0-9._-]{1,64}$
    heartbeatAt: string //format: date-time
    // The agent-host build of its last heartbeat.
    version: string | null
    // Computed from `heartbeatAt` when the response was made, never stored. `connected`: silent at most 60 seconds. `disconnected`: at most 300. `lost`: longer.
    status: enum[connected, disconnected, lost]
    labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
    // How many sessions the host will run at once; null if it has never said.
    capacity: integer | null //minimum: 0 //maximum: 256
    // How many more sessions it will take now: `capacity` minus its agents with a live session. Null when `capacity` is.
    available: integer | null //minimum: 0 //maximum: 256
  }[]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [DELETE]/hosts/{id}

- Summary  
  Deregister a host

- Operation id  
  deleteHost

- Description  
  Deletes the host's record, which is how a host leaves `listHosts`. Its agents, their transcripts and the commands sent to them stay on record, and its agents read as on a `lost` host. The next heartbeat from this id registers it again, and its socket is sent whatever is still queued for it.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
id: string //pattern: ^[A-Za-z0-9._-]{1,64}$
```

#### Responses

- 204 Deregistered.

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No host has this id.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/roles

- Summary  
  List roles

- Operation id  
  listRoles

- Description  
  Every role an agent can be made from, highest `priority` first. A stage starts with `planner`, `reviewer`, `conflict`, `investigator`, `judge` and `implementer`, as their callers made them before roles; one written with `createRole` or `updateRole` is served as written.

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Responses

- 200 The roles.

`application/json`

```typescript
{
  roles: {
    // A role's name, such as `reviewer`: what kind of agent it makes.
    name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
    documents: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
    // The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.
    credentials: array | null //maxItems: 16
    // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
    whenDone: enum[keep, stop, retire]
    // A short tag shown beside the agent's name, so sessions can be told apart.
    label: string //minLength: 1 //maxLength: 40
    // What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.
    description: string | null //minLength: 1 //maxLength: 16384
    // Of two requests waiting to start, the higher starts first.
    priority: integer //minimum: 0 //maximum: 1000
    // The first message of an agent made from it with no `brief` of its own; null when the caller must give one.
    brief: string | null //minLength: 1 //maxLength: 16384
    // When it was last written; null for a role as the stage was seeded with it.
    updatedAt: string | null //format: date-time
  }[]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/roles

- Summary  
  Create a role

- Operation id  
  createRole

- Description  
  Takes the stage's admin token. An agent made from it afterwards gets what it names; one made before keeps what it was given.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### RequestBody

The role.

- application/json

```typescript
{
  // A role's name, such as `reviewer`: what kind of agent it makes.
  name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  documents?: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
  // Absent, null: the stage's defaults.
  credentials?: array | null //maxItems: 16
  // Absent, `keep`.
  whenDone?: enum[keep, stop, retire]
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label: string //minLength: 1 //maxLength: 40
  // Absent, null.
  description?: string | null //minLength: 1 //maxLength: 16384
  // Absent, 0.
  priority?: integer //minimum: 0 //maximum: 1000
  // Absent, null.
  brief?: string | null //minLength: 1 //maxLength: 16384
}
```

#### Responses

- 201 Created.

`application/json`

```typescript
{
  // A role's name, such as `reviewer`: what kind of agent it makes.
  name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  documents: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
  // The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.
  credentials: array | null //maxItems: 16
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label: string //minLength: 1 //maxLength: 40
  // What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.
  description: string | null //minLength: 1 //maxLength: 16384
  // Of two requests waiting to start, the higher starts first.
  priority: integer //minimum: 0 //maximum: 1000
  // The first message of an agent made from it with no `brief` of its own; null when the caller must give one.
  brief: string | null //minLength: 1 //maxLength: 16384
  // When it was last written; null for a role as the stage was seeded with it.
  updatedAt: string | null //format: date-time
}
```

- 400 The request failed validation, a credential is not one this stage has, or honed has no skill named in `documents`.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 403 Writing a role takes the stage's admin token.

`application/json`

```typescript
{
  error: string
}
```

- 409 A role has this name already.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/roles/{name}

- Summary  
  Get one role

- Operation id  
  getRole

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// A role's name, such as `reviewer`: what kind of agent it makes.
// A role's name, such as `reviewer`: what kind of agent it makes.
name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
```

#### Responses

- 200 The role.

`application/json`

```typescript
{
  // A role's name, such as `reviewer`: what kind of agent it makes.
  name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  documents: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
  // The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.
  credentials: array | null //maxItems: 16
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label: string //minLength: 1 //maxLength: 40
  // What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.
  description: string | null //minLength: 1 //maxLength: 16384
  // Of two requests waiting to start, the higher starts first.
  priority: integer //minimum: 0 //maximum: 1000
  // The first message of an agent made from it with no `brief` of its own; null when the caller must give one.
  brief: string | null //minLength: 1 //maxLength: 16384
  // When it was last written; null for a role as the stage was seeded with it.
  updatedAt: string | null //format: date-time
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No role has this name.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [PATCH]/roles/{name}

- Summary  
  Change a role

- Operation id  
  updateRole

- Description  
  Takes the stage's admin token. Each field given replaces the role's; one absent is kept. Agents made from it before keep what they were given; those made after get what it names now.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// A role's name, such as `reviewer`: what kind of agent it makes.
// A role's name, such as `reviewer`: what kind of agent it makes.
name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
```

#### RequestBody

What changes.

- application/json

```typescript
{
  documents?: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
  // The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.
  credentials?: array | null //maxItems: 16
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone?: enum[keep, stop, retire]
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label?: string //minLength: 1 //maxLength: 40
  // What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.
  description?: string | null //minLength: 1 //maxLength: 16384
  // Of two requests waiting to start, the higher starts first.
  priority?: integer //minimum: 0 //maximum: 1000
  // The first message of an agent made from it with no `brief` of its own; null when the caller must give one.
  brief?: string | null //minLength: 1 //maxLength: 16384
}
```

#### Responses

- 200 Changed.

`application/json`

```typescript
{
  // A role's name, such as `reviewer`: what kind of agent it makes.
  name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  documents: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
  // The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.
  credentials: array | null //maxItems: 16
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label: string //minLength: 1 //maxLength: 40
  // What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.
  description: string | null //minLength: 1 //maxLength: 16384
  // Of two requests waiting to start, the higher starts first.
  priority: integer //minimum: 0 //maximum: 1000
  // The first message of an agent made from it with no `brief` of its own; null when the caller must give one.
  brief: string | null //minLength: 1 //maxLength: 16384
  // When it was last written; null for a role as the stage was seeded with it.
  updatedAt: string | null //format: date-time
}
```

- 400 The request failed validation, a credential is not one this stage has, or honed has no skill named in `documents`.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 403 Writing a role takes the stage's admin token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No role has this name.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/requests

- Summary  
  Ask for an agent in a role, to start when usage and a host allow

- Operation id  
  createRequest

- Description  
  Records the request `waiting`, then admits what it can at once. A request starts once both usage windows read under 90% (from a reading under 15 minutes old, or one whose window has since reset) and a connected host carrying its `labels` has a free slot; of those waiting, the highest role `priority` first, then the oldest. Admission runs when a request is made and on every host's heartbeat, every 30 seconds while any host is connected, which is when a host's capacity and usage are next known. A reading older than that, of a window not since reset, still admits one request at a time while both windows read under 70%: one starts once none has since that reading, or none in the last 15 minutes, so the agent it starts gives the next reading. Admitted, the agent is made from its role as `createAgent` with `role` would, with this request's id as its own and a name of the service's choosing (`<role>-<first 8 of its id>`), placed on a host of the service's choosing; `agentId` names it. A request names no host or agent name.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Headers

```typescript
// Who is making the agent: a person's name, or a service's own, such as `approval-service`. Recorded as `createdBy`, as said and not checked, since every caller holds the same token.
// Who is making the agent: a person's name, or a service's own, such as `approval-service`. Recorded as `createdBy`, as said and not checked, since every caller holds the same token.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

What kind of agent, and what it is for.

- application/json

```typescript
{
  // A role's name, such as `reviewer`: what kind of agent it makes.
  role: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  // The first message. Absent, the role's own; a role without one needs it.
  brief?: string //minLength: 1 //maxLength: 16384
  // A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
  item?: string //minLength: 1 //maxLength: 64
  // What it is for when that is no work item, such as `PR #41` or `judgment 3f…`: shown, never read.
  subject?: string //minLength: 1 //maxLength: 200
  // Absent, the role's.
  label?: string //minLength: 1 //maxLength: 40
  labels?: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$ //maxItems: 64
  credentials?: Partial(string) & Partial(   // A name with a token of the caller's, given this agent in place of the name's shared secret.
{
     name: string //pattern: ^[a-z0-9][a-z0-9-]{0,63}$
     token: string //minLength: 1 //maxLength: 4096
   })[] //maxItems: 16
  // A name with a token of the caller's, given this agent in place of the name's shared secret.
  tokens: {
    name: string //pattern: ^[a-z0-9][a-z0-9-]{0,63}$
    token: string //minLength: 1 //maxLength: 4096
  }[] //minItems: 1 //maxItems: 16
}
```

#### Responses

- 201 Recorded, and `started` if it was admitted at once.

`application/json`

```typescript
{
  // Assigned by the service; also the id of the agent it starts.
  id: string //format: uuid
  // A role's name, such as `reviewer`: what kind of agent it makes.
  role: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  // The first message; null to start on the role's own.
  brief: string | null
  // A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
  item: string | null //minLength: 1 //maxLength: 64
  // What it is for when that is no work item; null for none.
  subject: string | null
  // In place of the role's label; null for the role's.
  label: string | null
  labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
  // In place of the role's, by name; null for the role's. Never a token.
  credentials: array | null
  // The `claimed-by` header it was made with, unverified; null for none.
  requester: string | null
  // `waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.
  state: enum[waiting, started, withdrawn]
  // While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.
  why: string | null
  // Its role's, now.
  priority: integer //minimum: 0 //maximum: 1000
  // Where it stands among those waiting, 1 starting next; null once it is not waiting.
  position: integer | null //minimum: 1
  createdAt: string //format: date-time
  startedAt: string | null //format: date-time
  // The agent it started; null until it has.
  agentId: string | null //format: uuid
  withdrawnAt: string | null //format: date-time
}
```

- 400 The request failed validation, the stage has no such role, neither it nor its role has a brief, a credential is not one this stage has, or a token is for a service the agent would not be given.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured, or a token of its own could not be kept.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/requests

- Summary  
  List requests for agents

- Operation id  
  listRequests

- Description  
  Those `waiting`, in the order they would start, each with why it waits. With `all=true`, every one, the waiting first in that order and then the rest newest first. A request starts once both usage windows read under 90% (from a reading under 15 minutes old, or one whose window has since reset) and a connected host carrying its `labels` has a free slot; of those waiting, the highest role `priority` first, then the oldest. Admission runs when a request is made and on every host's heartbeat, every 30 seconds while any host is connected, which is when a host's capacity and usage are next known. A reading older than that, of a window not since reset, still admits one request at a time while both windows read under 70%: one starts once none has since that reading, or none in the last 15 minutes, so the agent it starts gives the next reading.

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Parameters(Query)

```typescript
// `true` includes those started and withdrawn.
// `true` includes those started and withdrawn.
all?: enum[true, false]
```

```typescript
// Only those made with this `claimed-by`.
// Only those made with this `claimed-by`.
requester?: string //minLength: 1 //maxLength: 200
```

```typescript
// Only those for this work item.
// Only those for this work item.
item?: string //minLength: 1 //maxLength: 64
```

#### Responses

- 200 The requests.

`application/json`

```typescript
{
  requests: {
    // Assigned by the service; also the id of the agent it starts.
    id: string //format: uuid
    // A role's name, such as `reviewer`: what kind of agent it makes.
    role: string //pattern: ^[a-z][a-z0-9-]{0,39}$
    // The first message; null to start on the role's own.
    brief: string | null
    // A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
    item: string | null //minLength: 1 //maxLength: 64
    // What it is for when that is no work item; null for none.
    subject: string | null
    // In place of the role's label; null for the role's.
    label: string | null
    labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
    // In place of the role's, by name; null for the role's. Never a token.
    credentials: array | null
    // The `claimed-by` header it was made with, unverified; null for none.
    requester: string | null
    // `waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.
    state: enum[waiting, started, withdrawn]
    // While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.
    why: string | null
    // Its role's, now.
    priority: integer //minimum: 0 //maximum: 1000
    // Where it stands among those waiting, 1 starting next; null once it is not waiting.
    position: integer | null //minimum: 1
    createdAt: string //format: date-time
    startedAt: string | null //format: date-time
    // The agent it started; null until it has.
    agentId: string | null //format: uuid
    withdrawnAt: string | null //format: date-time
  }[]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/requests/{id}

- Summary  
  Get one request for an agent

- Operation id  
  getRequest

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service; also the id of the agent it starts.
// Assigned by the service; also the id of the agent it starts.
id: string //format: uuid
```

#### Responses

- 200 The request.

`application/json`

```typescript
{
  // Assigned by the service; also the id of the agent it starts.
  id: string //format: uuid
  // A role's name, such as `reviewer`: what kind of agent it makes.
  role: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  // The first message; null to start on the role's own.
  brief: string | null
  // A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
  item: string | null //minLength: 1 //maxLength: 64
  // What it is for when that is no work item; null for none.
  subject: string | null
  // In place of the role's label; null for the role's.
  label: string | null
  labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
  // In place of the role's, by name; null for the role's. Never a token.
  credentials: array | null
  // The `claimed-by` header it was made with, unverified; null for none.
  requester: string | null
  // `waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.
  state: enum[waiting, started, withdrawn]
  // While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.
  why: string | null
  // Its role's, now.
  priority: integer //minimum: 0 //maximum: 1000
  // Where it stands among those waiting, 1 starting next; null once it is not waiting.
  position: integer | null //minimum: 1
  createdAt: string //format: date-time
  startedAt: string | null //format: date-time
  // The agent it started; null until it has.
  agentId: string | null //format: uuid
  withdrawnAt: string | null //format: date-time
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No request has this id.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [DELETE]/requests/{id}

- Summary  
  Withdraw a waiting request, so it never starts

- Operation id  
  withdrawRequest

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service; also the id of the agent it starts.
// Assigned by the service; also the id of the agent it starts.
id: string //format: uuid
```

#### Responses

- 200 Withdrawn.

`application/json`

```typescript
{
  // Assigned by the service; also the id of the agent it starts.
  id: string //format: uuid
  // A role's name, such as `reviewer`: what kind of agent it makes.
  role: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  // The first message; null to start on the role's own.
  brief: string | null
  // A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
  item: string | null //minLength: 1 //maxLength: 64
  // What it is for when that is no work item; null for none.
  subject: string | null
  // In place of the role's label; null for the role's.
  label: string | null
  labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
  // In place of the role's, by name; null for the role's. Never a token.
  credentials: array | null
  // The `claimed-by` header it was made with, unverified; null for none.
  requester: string | null
  // `waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.
  state: enum[waiting, started, withdrawn]
  // While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.
  why: string | null
  // Its role's, now.
  priority: integer //minimum: 0 //maximum: 1000
  // Where it stands among those waiting, 1 starting next; null once it is not waiting.
  position: integer | null //minimum: 1
  createdAt: string //format: date-time
  startedAt: string | null //format: date-time
  // The agent it started; null until it has.
  agentId: string | null //format: uuid
  withdrawnAt: string | null //format: date-time
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No request has this id.

`application/json`

```typescript
{
  error: string
}
```

- 409 It has started, or was withdrawn already.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/agents

- Summary  
  Create an agent on a host

- Operation id  
  createAgent

- Description  
  Records the agent `idle` and queues `create` for its host, which makes its home. With a `brief`, also queues a `start` whose first message is the brief, and the agent is `working` at once. Without a `hostId`, the service chooses a connected host with room.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Headers

```typescript
// Who is making the agent: a person's name, or a service's own, such as `approval-service`. Recorded as `createdBy`, as said and not checked, since every caller holds the same token.
// Who is making the agent: a person's name, or a service's own, such as `approval-service`. Recorded as `createdBy`, as said and not checked, since every caller holds the same token.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

Who the agent is and where it lives.

- application/json

```typescript
{
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // The role it is made from (`listRoles`): its `documents`, `credentials`, `whenDone`, `label` and `brief` are the agent's, each unless given here, which overrides the role's. A role this stage does not have is refused.
  role?: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  // Where it lives. Absent, the service places it on a `connected` host with room (`available` above 0), the one with the most first, carrying every one of `labels`.
  hostId?: string //pattern: ^[A-Za-z0-9._-]{1,64}$
  labels?: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$ //maxItems: 64
  // The first session's first message. Absent, the role's, if it has one; otherwise no session starts.
  brief?: string //minLength: 1 //maxLength: 16384
  // Absent, the role's, or without one none.
  label?: string //minLength: 1 //maxLength: 40
  // The work item it is started on, kept for its life so `listAgents` with `item` finds it. Absent, none.
  item?: string //minLength: 1 //maxLength: 64
  // Absent, the role's, or without one `keep`.
  whenDone?: enum[keep, stop, retire]
  credentials?: Partial(string) & Partial(   // A name with a token of the caller's, given this agent in place of the name's shared secret.
{
     name: string //pattern: ^[a-z0-9][a-z0-9-]{0,63}$
     token: string //minLength: 1 //maxLength: 4096
   })[] //maxItems: 16
  documents?: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
}
```

#### Responses

- 201 Created; its `create` is queued for the host.

`application/json`

```typescript
{
  // Assigned by the service when the agent is created.
  id: string //format: uuid
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // What the agent named itself for its work, with `setAgentTitle`, or the person with `renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.
  title: string | null
  // A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none.
  label: string | null
  // The work item it was started on, as given when it was made; null for none.
  item: string | null //minLength: 1 //maxLength: 64
  // The role it was made from, as given when it was made; null for one made without.
  role: string | null //pattern: ^[a-z][a-z0-9-]{0,39}$
  // Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
  tokens: {
    // Input tokens not read from or written to the prompt cache.
    inputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Output tokens.
    outputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens written to the prompt cache.
    cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens read from the prompt cache.
    cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
  }
  // The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none.
  createdBy: string | null
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  documents: string[]
  // The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.
  credentials: array | null
  hostId: string //pattern: ^[A-Za-z0-9._-]{1,64}$
  // `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.
  state: enum[idle, working, waiting, interrupted, retired]
  // The live session, or null for none.
  session: object | null
  createdAt: string //format: date-time
  // When its host last reported a change to it; null until its host first reports it.
  reportedAt: string | null //format: date-time
  // What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `setAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `setAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.
  status: enum[working, idle, waiting, review, done, ] | null
  // One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.
  summary: string | null
  // A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.
  headline: string | null
  // When `summary` was said; null when there is none.
  saidAt: string | null //format: date-time
  // What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.
  activity: object | null
  // Background tasks and subagents its live session has open, as its host last reported; 0 without one.
  tasks: integer //minimum: 0
  // Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.
  told: boolean | null
  // Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.
  hostStatus: enum[connected, disconnected, lost]
}
```

- 400 The request failed validation, `role` is not one this stage has, a credential is not one this stage has, or honed has no skill named in `documents`.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No host has the id `hostId`.

`application/json`

```typescript
{
  error: string
}
```

- 409 Nothing was queued: an agent not retired already has `name`, the host is `lost`, or it is full and a `brief` was given.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured, or no `hostId` was given and no connected host fits and has room.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/agents

- Summary  
  List agents

- Operation id  
  listAgents

- Description  
  Retired agents are listed only with `all=true`, or with `item`. With `createdBy`, only the agents made by that `claimed-by`, so a service can list its own. With `item`, only those started on that work item, retired ones included, so what they used is still there once they have gone. With `role`, only those made from that role.

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Parameters(Query)

```typescript
createdBy?: string //minLength: 1 //maxLength: 200
```

```typescript
// A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
// A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
item?: string //minLength: 1 //maxLength: 64
```

```typescript
// Only the agents made from this role.
// Only the agents made from this role.
role?: string //pattern: ^[a-z][a-z0-9-]{0,39}$
```

```typescript
// `true` includes retired agents.
// `true` includes retired agents.
all?: enum[true, false]
```

#### Responses

- 200 Matching agents.

`application/json`

```typescript
{
  agents: {
    // Assigned by the service when the agent is created.
    id: string //format: uuid
    // Unique among agents not retired. Names its home folder and tmux session on its host.
    name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
    // What the agent named itself for its work, with `setAgentTitle`, or the person with `renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.
    title: string | null
    // A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none.
    label: string | null
    // The work item it was started on, as given when it was made; null for none.
    item: string | null //minLength: 1 //maxLength: 64
    // The role it was made from, as given when it was made; null for one made without.
    role: string | null //pattern: ^[a-z][a-z0-9-]{0,39}$
    // Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
    tokens: {
      // Input tokens not read from or written to the prompt cache.
      inputTokens: integer //minimum: 0 //maximum: 9007199254740991
      // Output tokens.
      outputTokens: integer //minimum: 0 //maximum: 9007199254740991
      // Input tokens written to the prompt cache.
      cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
      // Input tokens read from the prompt cache.
      cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    }
    // The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none.
    createdBy: string | null
    // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
    whenDone: enum[keep, stop, retire]
    documents: string[]
    // The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.
    credentials: array | null
    hostId: string //pattern: ^[A-Za-z0-9._-]{1,64}$
    // `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.
    state: enum[idle, working, waiting, interrupted, retired]
    // The live session, or null for none.
    session: object | null
    createdAt: string //format: date-time
    // When its host last reported a change to it; null until its host first reports it.
    reportedAt: string | null //format: date-time
    // What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `setAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `setAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.
    status: enum[working, idle, waiting, review, done, ] | null
    // One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.
    summary: string | null
    // A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.
    headline: string | null
    // When `summary` was said; null when there is none.
    saidAt: string | null //format: date-time
    // What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.
    activity: object | null
    // Background tasks and subagents its live session has open, as its host last reported; 0 without one.
    tasks: integer //minimum: 0
    // Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.
    told: boolean | null
    // Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.
    hostStatus: enum[connected, disconnected, lost]
  }[]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/agents/{id}

- Summary  
  Get one agent

- Operation id  
  getAgent

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### Responses

- 200 The agent.

`application/json`

```typescript
{
  // Assigned by the service when the agent is created.
  id: string //format: uuid
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // What the agent named itself for its work, with `setAgentTitle`, or the person with `renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.
  title: string | null
  // A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none.
  label: string | null
  // The work item it was started on, as given when it was made; null for none.
  item: string | null //minLength: 1 //maxLength: 64
  // The role it was made from, as given when it was made; null for one made without.
  role: string | null //pattern: ^[a-z][a-z0-9-]{0,39}$
  // Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
  tokens: {
    // Input tokens not read from or written to the prompt cache.
    inputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Output tokens.
    outputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens written to the prompt cache.
    cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens read from the prompt cache.
    cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
  }
  // The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none.
  createdBy: string | null
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  documents: string[]
  // The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.
  credentials: array | null
  hostId: string //pattern: ^[A-Za-z0-9._-]{1,64}$
  // `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.
  state: enum[idle, working, waiting, interrupted, retired]
  // The live session, or null for none.
  session: object | null
  createdAt: string //format: date-time
  // When its host last reported a change to it; null until its host first reports it.
  reportedAt: string | null //format: date-time
  // What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `setAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `setAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.
  status: enum[working, idle, waiting, review, done, ] | null
  // One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.
  summary: string | null
  // A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.
  headline: string | null
  // When `summary` was said; null when there is none.
  saidAt: string | null //format: date-time
  // What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.
  activity: object | null
  // Background tasks and subagents its live session has open, as its host last reported; 0 without one.
  tasks: integer //minimum: 0
  // Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.
  told: boolean | null
  // Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.
  hostStatus: enum[connected, disconnected, lost]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [PATCH]/agents/{id}

- Summary  
  Rename an agent, or change or clear its title or label

- Operation id  
  renameAgent

- Description  
  A new `name` is taken and the old one freed at once. Only the record changes: its host keeps the folder and session it made under the name it was created with. `title` replaces the agent's, or with null clears it, whether or not the agent gave it. `label` likewise.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### RequestBody

The agent's new name, title or label.

- application/json

```typescript
{
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name?: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // What the agent is there to do, in a few words.
  title?: string | null //minLength: 1 //maxLength: 40
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label?: string | null //minLength: 1 //maxLength: 40
}
```

#### Responses

- 200 Renamed.

`application/json`

```typescript
{
  // Assigned by the service when the agent is created.
  id: string //format: uuid
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // What the agent named itself for its work, with `setAgentTitle`, or the person with `renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.
  title: string | null
  // A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none.
  label: string | null
  // The work item it was started on, as given when it was made; null for none.
  item: string | null //minLength: 1 //maxLength: 64
  // The role it was made from, as given when it was made; null for one made without.
  role: string | null //pattern: ^[a-z][a-z0-9-]{0,39}$
  // Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
  tokens: {
    // Input tokens not read from or written to the prompt cache.
    inputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Output tokens.
    outputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens written to the prompt cache.
    cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens read from the prompt cache.
    cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
  }
  // The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none.
  createdBy: string | null
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  documents: string[]
  // The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.
  credentials: array | null
  hostId: string //pattern: ^[A-Za-z0-9._-]{1,64}$
  // `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.
  state: enum[idle, working, waiting, interrupted, retired]
  // The live session, or null for none.
  session: object | null
  createdAt: string //format: date-time
  // When its host last reported a change to it; null until its host first reports it.
  reportedAt: string | null //format: date-time
  // What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `setAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `setAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.
  status: enum[working, idle, waiting, review, done, ] | null
  // One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.
  summary: string | null
  // A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.
  headline: string | null
  // When `summary` was said; null when there is none.
  saidAt: string | null //format: date-time
  // What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.
  activity: object | null
  // Background tasks and subagents its live session has open, as its host last reported; 0 without one.
  tasks: integer //minimum: 0
  // Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.
  told: boolean | null
  // Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.
  hostStatus: enum[connected, disconnected, lost]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Nothing was queued: the agent is retired, or an agent not retired already has `name`.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [DELETE]/agents/{id}

- Summary  
  Retire an agent

- Operation id  
  retireAgent

- Description  
  Records it `retired` at once, ends any session, frees its name, and queues a `stop` if it had a live session and then `retire`, which is offered until its host takes it. Its transcript, sessions and home folder are kept.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### Responses

- 202 Retired; `commandId` is the `retire`'s.

`application/json`

```typescript
{
  // Follow it in `listAgentCommands`. Null when nothing was sent to the host.
  commandId: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Nothing was queued: the agent is retired already.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/agents/{id}/messages

- Summary  
  Send an agent a message, or interrupt it

- Operation id  
  messageAgent

- Description  
  To an agent with a live session, `text` is a `message`, delivered at its next turn; with `interrupt: true` it is an `interrupt`, stopping the current turn first, and with no `text` it only interrupts. To an `idle` or `interrupted` agent, it queues a `start` with `text` as its first message, resuming its last conversation if it has had one. 202 means queued, not delivered.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### RequestBody

*Required*

What to tell it.

- application/json

```typescript
{
  // Required unless `interrupt` is true.
  text?: string //minLength: 1 //maxLength: 16384
  // `true` stops the current turn before `text` is sent.
  interrupt?: boolean
}
```

#### Responses

- 202 Queued, and not yet delivered.

`application/json`

```typescript
{
  // Follow it in `listAgentCommands`. Null when nothing was sent to the host.
  commandId: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Nothing was queued: the agent is retired, has no session to interrupt, or its host is `lost` or full.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/agents/{id}/stop

- Summary  
  Stop an agent's session, or force it idle

- Operation id  
  stopAgent

- Description  
  Queues a `stop`; the session ends and the agent is `idle` once its host reports doing it. When its host is `lost` or deregistered, and so cannot be told, or with `force: true`, the session is ended and the agent `idle` at once, and everything queued for it but `create` is withdrawn; nothing is sent. If its host later reports that session still running, it is sent a `stop`. A caller need not send `force`: the service decides it from the host.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### RequestBody

Optional. Absent, the host is asked to stop it.

- application/json

```typescript
{
  // `true` ends it on record without waiting for the host, even one still connected.
  force?: boolean
}
```

#### Responses

- 202 The `stop` is queued; ended on record (its host `lost`, or `force`), and `commandId` is null.

`application/json`

```typescript
{
  // Follow it in `listAgentCommands`. Null when nothing was sent to the host.
  commandId: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Nothing was queued: the agent has no live session.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/agents/{id}/resume

- Summary  
  Start a session continuing the agent's last conversation

- Operation id  
  resumeAgent

- Description  
  Queues a `start` with `resume: true`, or `false` for an agent that has never had a session.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### Responses

- 202 The `start` is queued.

`application/json`

```typescript
{
  // Follow it in `listAgentCommands`. Null when nothing was sent to the host.
  commandId: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 409 Nothing was queued: the agent is retired or has a live session, or its host is `lost` or full.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [PUT]/agents/{id}/status

- Summary  
  Say whether the agent needs the person, is in review or done, and what on

- Operation id  
  setAgentStatus

- Description  
  Called by the agent itself, from its `page` skill, and by approval-service for the agent whose change it took or shipped. `waiting` says the agent needs the person; it stands until the person messages it. `working` only says what it is doing: whether it reads `working` or `idle` is its host's turns. `review` says its change is submitted to approval-service and `done` that it finished, or its change shipped; each needs no live session. Not sent to its host. Once the agent is in `review` or `done` and no turn or background task of its runs, `whenDone` is carried out: `stop` stops its session, and `retire` retires it once `done` (in `review` it is stopped, never retired, so a send-back reaches it).

- Tags  
  agents, of themselves

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### RequestBody

What the agent says of itself.

- application/json

```typescript
{
  status: enum[working, waiting, review, done]
  // One line: what it is doing, while `waiting` what it needs from the person, in `review` what it submitted, or when `done` the result.
  summary: string //minLength: 1 //maxLength: 280
  // The summary in a few words a person can scan in a list, e.g. "Needs merge OK". Omitted, it is null.
  headline?: string //minLength: 1 //maxLength: 29
}
```

#### Responses

- 200 Recorded.

`application/json`

```typescript
{
  // Assigned by the service when the agent is created.
  id: string //format: uuid
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // What the agent named itself for its work, with `setAgentTitle`, or the person with `renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.
  title: string | null
  // A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none.
  label: string | null
  // The work item it was started on, as given when it was made; null for none.
  item: string | null //minLength: 1 //maxLength: 64
  // The role it was made from, as given when it was made; null for one made without.
  role: string | null //pattern: ^[a-z][a-z0-9-]{0,39}$
  // Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
  tokens: {
    // Input tokens not read from or written to the prompt cache.
    inputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Output tokens.
    outputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens written to the prompt cache.
    cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens read from the prompt cache.
    cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
  }
  // The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none.
  createdBy: string | null
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  documents: string[]
  // The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.
  credentials: array | null
  hostId: string //pattern: ^[A-Za-z0-9._-]{1,64}$
  // `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.
  state: enum[idle, working, waiting, interrupted, retired]
  // The live session, or null for none.
  session: object | null
  createdAt: string //format: date-time
  // When its host last reported a change to it; null until its host first reports it.
  reportedAt: string | null //format: date-time
  // What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `setAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `setAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.
  status: enum[working, idle, waiting, review, done, ] | null
  // One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.
  summary: string | null
  // A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.
  headline: string | null
  // When `summary` was said; null when there is none.
  saidAt: string | null //format: date-time
  // What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.
  activity: object | null
  // Background tasks and subagents its live session has open, as its host last reported; 0 without one.
  tasks: integer //minimum: 0
  // Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.
  told: boolean | null
  // Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.
  hostStatus: enum[connected, disconnected, lost]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 409 The agent is retired, or has no live session to be `working` or `waiting`.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [PUT]/agents/{id}/title

- Summary  
  Name the agent for its work, once

- Operation id  
  setAgentTitle

- Description  
  Called by the agent itself, early in its first session, once it knows what it is there to do. Set once: after that only the person changes it, with `renameAgent`.

- Tags  
  agents, of themselves

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### RequestBody

What the agent names itself.

- application/json

```typescript
{
  // What the agent is there to do, in a few words.
  title: string //minLength: 1 //maxLength: 40
}
```

#### Responses

- 200 Recorded.

`application/json`

```typescript
{
  // Assigned by the service when the agent is created.
  id: string //format: uuid
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // What the agent named itself for its work, with `setAgentTitle`, or the person with `renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.
  title: string | null
  // A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none.
  label: string | null
  // The work item it was started on, as given when it was made; null for none.
  item: string | null //minLength: 1 //maxLength: 64
  // The role it was made from, as given when it was made; null for one made without.
  role: string | null //pattern: ^[a-z][a-z0-9-]{0,39}$
  // Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
  tokens: {
    // Input tokens not read from or written to the prompt cache.
    inputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Output tokens.
    outputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens written to the prompt cache.
    cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens read from the prompt cache.
    cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
  }
  // The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none.
  createdBy: string | null
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  documents: string[]
  // The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.
  credentials: array | null
  hostId: string //pattern: ^[A-Za-z0-9._-]{1,64}$
  // `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.
  state: enum[idle, working, waiting, interrupted, retired]
  // The live session, or null for none.
  session: object | null
  createdAt: string //format: date-time
  // When its host last reported a change to it; null until its host first reports it.
  reportedAt: string | null //format: date-time
  // What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `setAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `setAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.
  status: enum[working, idle, waiting, review, done, ] | null
  // One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.
  summary: string | null
  // A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.
  headline: string | null
  // When `summary` was said; null when there is none.
  saidAt: string | null //format: date-time
  // What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.
  activity: object | null
  // Background tasks and subagents its live session has open, as its host last reported; 0 without one.
  tasks: integer //minimum: 0
  // Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.
  told: boolean | null
  // Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.
  hostStatus: enum[connected, disconnected, lost]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 409 The agent is retired, or has a title already.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/agents/{id}/transcript

- Summary  
  List an agent's transcript lines after a cursor, oldest first, across its sessions

- Operation id  
  listTranscript

- Description  
  Poll with the returned `next`, or take `lines` on a socket, to follow it as it grows.

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### Parameters(Query)

```typescript
// The `next` from the previous read. Absent reads from the start.
after?: #/components/schemas/Cursor & 
```

```typescript
limit?: integer //minimum: 1 //maximum: 1000 //default: 500
```

#### Responses

- 200 Lines after the cursor.

`application/json`

```typescript
{
  lines: {
    // Line number per agent, from 0, continuing across its sessions.
    seq: integer //minimum: 0
    at: string //format: date-time
    // Assigned by the service when it queues the session's `start`.
    sessionId: string //format: uuid
    // `instruction`: a message sent to the agent.
    from: enum[agent, tool, instruction]
    // Whole up to 65536 characters. A text cut short, by its host to fit a socket message or here, ends `… [cut: N of M characters]`: N kept of the M there were.
    text: string
    // On an `instruction` line that is a command's text as the session took it (a `message`, a `start`'s first message, an `interrupt`'s text): that command's id. Absent on any other line.
    commandId?: string //minLength: 1 //maxLength: 128
  }[]
  // Pass as `after` to read what follows. Unchanged when nothing does yet.
  next: string //minLength: 1 //maxLength: 512
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/agents/{id}/sessions

- Summary  
  List an agent's sessions, oldest first

- Operation id  
  listSessions

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### Responses

- 200 Every session.

`application/json`

```typescript
{
  sessions: {
    // Assigned by the service when it queues the session's `start`.
    id: string //format: uuid
    // Assigned by the service when the agent is created.
    agentId: string //format: uuid
    // When its `start` was queued.
    startedAt: string //format: date-time
    endedAt: string | null //format: date-time
    // `stopped`: told to stop, or its host ended it cleanly. `interrupted`: it died. Null while live.
    ended: enum[stopped, interrupted, ] | null
    // The `workplace/global` it started with, from honed; null when it was given none.
    context: object | null
    documents: {
      key: string
      version: integer
    }[]
    skills: {
      key: string
      version: integer
      commit: string
    }[]
    // Why it was given no context, or why a document it was made with, or a service's skill, was left out.
    contextNote: string | null
  }[]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/agents/{id}/sessions/{sessionId}/context

- Summary  
  Read a live session's whole context, when its start was too large to carry it

- Operation id  
  getSessionContext

- Description  
  Read at the moment it is asked, as a start's is, and recorded on the session in place of what its start carried, so the session's `contextNote` says what it was given.

- Tags  
  hosts

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

```typescript
// Assigned by the service when it queues the session's `start`.
// Assigned by the service when it queues the session's `start`.
sessionId: string //format: uuid
```

#### Responses

- 200 Its context and documents.

`application/json`

```typescript
{
  // Written as a start's `context` is; null when there is none to give.
  context: object | null
  documents: {
    key: string
    version: integer
    files: {
      path: string
      content: string
      executable: boolean
    }[]
  }[]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 409 The session is not the agent's live one.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/agents/{id}/commands

- Summary  
  List the commands sent to an agent, oldest first, with their delivery

- Operation id  
  listAgentCommands

- Description  
  Each is kept 7 days from when it was queued, then deleted.

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
// Assigned by the service when the agent is created.
// Assigned by the service when the agent is created.
id: string //format: uuid
```

#### Responses

- 200 Every command kept.

`application/json`

```typescript
{
  commands: {
    // discriminator: kind
    command: #/components/schemas/CreateCommand | #/components/schemas/StartCommand | #/components/schemas/MessageCommand | #/components/schemas/InterruptCommand | #/components/schemas/StopCommand | #/components/schemas/RetireCommand
    queuedAt: string //format: date-time
    // `queued`: not yet reported by the host. `written`: its text is in the agent's session, which has not yet taken it (it takes it at its next step); a session that ends first makes it `rejected`. `withdrawn`: never to be sent, because it went unreported for 300 seconds (`create` and `retire` excepted) or its agent was force-stopped. `done` / `rejected`: the host reported it, done (a text: taken) or not.
    delivery: enum[queued, written, withdrawn, done, rejected]
    // When the host last reported it; null until then.
    reportedAt: string | null //format: date-time
    // The host's words when it could not do the command; null otherwise.
    error: string | null
  }[]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No agent has this id.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/usage

- Summary  
  Read how much of the Claude account's 5-hour and weekly allowance is used

- Operation id  
  getUsage

- Description  
  The newest reading of each window any host has reported. A window whose `resetsAt` has passed has since started again from 0; the reading says only what was true at `readAt`. With nothing reported yet, every field is null.

- Tags  
  clients, reading

- Security  
  bearerAuth

#### Responses

- 200 The newest reading.

`application/json`

```typescript
// How much of the Claude account's 5-hour and weekly allowance is used, as last reported.
{
  // The newest of the windows' `readAt`; null when nothing has been reported.
  readAt: string | null //format: date-time
  // The 5-hour window's newest reading; null when none has been reported.
  fiveHour: object | null
  sevenDay: #/components/schemas/UsageWindow & 
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/socket-tickets

- Summary  
  Trade the bearer token for a one-time socket ticket

- Operation id  
  createSocketTicket

- Description  
  A browser cannot set a header on a WebSocket, and a long-lived token must never go in a URL, so a page opens `<socketUrl>?ticket=<ticket>` instead. Good once, for 60 seconds. The socket then receives `SocketOutbound` messages: `agent`, `lines` and `host`.

- Tags  
  clients, acting

- Security  
  bearerAuth

#### Responses

- 201 The ticket.

`application/json`

```typescript
{
  ticket: string
  socketUrl: string
  expiresAt: string //format: date-time
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured, or this server has no socket.

`application/json`

```typescript
{
  error: string
}
```

## References

### #/components/securitySchemes/bearerAuth

- Type: http
- Scheme: bearer

### #/components/schemas/SocketInbound

```typescript
// discriminator: type
#/components/schemas/SocketReport | #/components/schemas/SocketPing
```

### #/components/schemas/SocketReport

```typescript
// Host to service, the only way a host reports: whenever something changes, and in full (every agent, every line and result not yet sent) whenever its socket connects. Pushed on to viewers. Idempotent: lines by (`agentId`, `seq`), results by `commandId`. Does not count as a heartbeat. A socket message is at most 128 KB, sent in frames of 32 KB at most, so lines that would not fit go in the reports after it.
{
  type: enum[report]
  agents: {
    // Assigned by the service when the agent is created.
    id: string //format: uuid
    // `idle`: no session running. `working`: its session is taking a turn (from Claude Code's `system` `init` to its `result`). `waiting`: its session is running and between turns. `interrupted`: a session the service started is not running, and was not stopped (a crash, a restart, or a session it does not know).
    state: enum[idle, working, waiting, interrupted]
    // The session running, or null for none.
    sessionId: string | null //format: uuid
    // Background tasks and subagents its session has open, as Claude Code's latest `background_tasks_changed` lists them, whether or not a turn is running; 0 once its session ends. Absent from a host that does not say, read as 0.
    tasks?: integer //minimum: 0 //maximum: 1000
    // Whether the turn running, or the last one, began with a message the host delivered (its echo came back in that turn), rather than by itself, as a turn a background task's end begins does. Absent from a host that does not say, read as unknown.
    told?: boolean
  }[] //maxItems: 256
  lines: {
    // Assigned by the service when the agent is created.
    agentId: string //format: uuid
    // Assigned by the service when it queues the session's `start`.
    sessionId: string //format: uuid
    // Deduplicated by (`agentId`, `seq`), so resending is safe.
    seq: integer //minimum: 0
    at: string //format: date-time
    // `instruction`: a message sent to the agent.
    from: enum[agent, tool, instruction]
    // Kept whole up to 65536 characters, and past that cut rather than refused, so the rest of its report is not lost with it. A text cut short, by its host to fit a socket message or here, ends `… [cut: N of M characters]`: N kept of the M there were.
    text: string
    // On an `instruction` line that is a command's text as the session took it (a `message`, a `start`'s first message, an `interrupt`'s text): that command's id. Absent on any other line.
    commandId?: string //minLength: 1 //maxLength: 128
  }[] //maxItems: 1000
  commandResults: {
    commandId: string //minLength: 1 //maxLength: 128
    // False when the host could not do the command.
    ok: boolean
    // Why not, when `ok` is false, in the host's words.
    error?: string //maxLength: 4096
    // `false` with `ok` true: a command with text, written to its agent's session but not yet taken by it. The command is off the queue (`written`), and its host reports it once more, `ok` true once the session takes it, false if it never will. Absent or true: settled.
    taken?: boolean
  }[] //maxItems: 1000
  // A session's running total of tokens so far, not what was used since the last report. The service keeps the highest of each count reported for the session, so a total sent again, or late, never adds twice.
  tokens: {
    // Assigned by the service when the agent is created.
    agentId: string //format: uuid
    // Assigned by the service when it queues the session's `start`.
    sessionId: string //format: uuid
    // Input tokens not read from or written to the prompt cache.
    inputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Output tokens.
    outputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens written to the prompt cache.
    cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens read from the prompt cache.
    cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
  }[] //maxItems: 256
  // The account's usage, when a session's stream has said it since the last report.
  usage: {
    // When the session's stream said it: its `rate_limit_event`'s time.
    readAt: string //format: date-time
    // The 5-hour window; absent when the event did not carry it.
    fiveHour: {
      // How much of the window's allowance is used, 0 to 1 (1 is all of it).
      utilization: number //minimum: 0
      // When the window starts again from 0.
      resetsAt: string //format: date-time
    }
    sevenDay?: #/components/schemas/UsageWindowReport & 
  }
}
```

### #/components/schemas/AgentReport

```typescript
{
  // Assigned by the service when the agent is created.
  id: string //format: uuid
  // `idle`: no session running. `working`: its session is taking a turn (from Claude Code's `system` `init` to its `result`). `waiting`: its session is running and between turns. `interrupted`: a session the service started is not running, and was not stopped (a crash, a restart, or a session it does not know).
  state: enum[idle, working, waiting, interrupted]
  // The session running, or null for none.
  sessionId: string | null //format: uuid
  // Background tasks and subagents its session has open, as Claude Code's latest `background_tasks_changed` lists them, whether or not a turn is running; 0 once its session ends. Absent from a host that does not say, read as 0.
  tasks?: integer //minimum: 0 //maximum: 1000
  // Whether the turn running, or the last one, began with a message the host delivered (its echo came back in that turn), rather than by itself, as a turn a background task's end begins does. Absent from a host that does not say, read as unknown.
  told?: boolean
}
```

### #/components/schemas/LineReport

```typescript
{
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  // Assigned by the service when it queues the session's `start`.
  sessionId: string //format: uuid
  // Deduplicated by (`agentId`, `seq`), so resending is safe.
  seq: integer //minimum: 0
  at: string //format: date-time
  // `instruction`: a message sent to the agent.
  from: enum[agent, tool, instruction]
  // Kept whole up to 65536 characters, and past that cut rather than refused, so the rest of its report is not lost with it. A text cut short, by its host to fit a socket message or here, ends `… [cut: N of M characters]`: N kept of the M there were.
  text: string
  // On an `instruction` line that is a command's text as the session took it (a `message`, a `start`'s first message, an `interrupt`'s text): that command's id. Absent on any other line.
  commandId?: string //minLength: 1 //maxLength: 128
}
```

### #/components/schemas/CommandReport

```typescript
{
  commandId: string //minLength: 1 //maxLength: 128
  // False when the host could not do the command.
  ok: boolean
  // Why not, when `ok` is false, in the host's words.
  error?: string //maxLength: 4096
  // `false` with `ok` true: a command with text, written to its agent's session but not yet taken by it. The command is off the queue (`written`), and its host reports it once more, `ok` true once the session takes it, false if it never will. Absent or true: settled.
  taken?: boolean
}
```

### #/components/schemas/SessionTokensReport

```typescript
// A session's running total of tokens so far, not what was used since the last report. The service keeps the highest of each count reported for the session, so a total sent again, or late, never adds twice.
{
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  // Assigned by the service when it queues the session's `start`.
  sessionId: string //format: uuid
  // Input tokens not read from or written to the prompt cache.
  inputTokens: integer //minimum: 0 //maximum: 9007199254740991
  // Output tokens.
  outputTokens: integer //minimum: 0 //maximum: 9007199254740991
  // Input tokens written to the prompt cache.
  cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
  // Input tokens read from the prompt cache.
  cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
}
```

### #/components/schemas/UsageReport

```typescript
// The account's usage, when a session's stream has said it since the last report.
{
  // When the session's stream said it: its `rate_limit_event`'s time.
  readAt: string //format: date-time
  // The 5-hour window; absent when the event did not carry it.
  fiveHour: {
    // How much of the window's allowance is used, 0 to 1 (1 is all of it).
    utilization: number //minimum: 0
    // When the window starts again from 0.
    resetsAt: string //format: date-time
  }
  sevenDay?: #/components/schemas/UsageWindowReport & 
}
```

### #/components/schemas/UsageWindowReport

```typescript
// The 5-hour window; absent when the event did not carry it.
{
  // How much of the window's allowance is used, 0 to 1 (1 is all of it).
  utilization: number //minimum: 0
  // When the window starts again from 0.
  resetsAt: string //format: date-time
}
```

### #/components/schemas/SocketPing

```typescript
// Either side's keep-alive, beside the server's WebSocket pings, which close a socket that misses one.
{
  type: enum[ping]
}
```

### #/components/schemas/SocketOutbound

```typescript
// discriminator: type
#/components/schemas/CommandPush | #/components/schemas/AgentPush | #/components/schemas/LinesPush | #/components/schemas/SentPush | #/components/schemas/HostPush | #/components/schemas/UsagePush | #/components/schemas/SocketError
```

### #/components/schemas/CommandPush

```typescript
// To every socket of the command's host, the moment it is queued; and to a host's socket once it is open, every command still pending for that host, oldest first. That replay follows the first message the host sends on it (its full report on connecting), and leaves out commands that message reports. A command is pending until a report names it, or until it is withdrawn; a host may see one more than once, and knows it by `id`.
{
  type: enum[command]
  // discriminator: kind
  command: #/components/schemas/CreateCommand | #/components/schemas/StartCommand | #/components/schemas/MessageCommand | #/components/schemas/InterruptCommand | #/components/schemas/StopCommand | #/components/schemas/RetireCommand
}
```

### #/components/schemas/Command

```typescript
// discriminator: kind
#/components/schemas/CreateCommand | #/components/schemas/StartCommand | #/components/schemas/MessageCommand | #/components/schemas/InterruptCommand | #/components/schemas/StopCommand | #/components/schemas/RetireCommand
```

### #/components/schemas/CreateCommand

```typescript
// Make the agent's home folder.
{
  // Report the command by this id once it is taken.
  id: string //minLength: 1 //maxLength: 128
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  kind: enum[create]
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
}
```

### #/components/schemas/StartCommand

```typescript
{
  // Report the command by this id once it is taken.
  id: string //minLength: 1 //maxLength: 128
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  kind: enum[start]
  // Assigned by the service when it queues the session's `start`.
  sessionId: string //format: uuid
  // True to carry on the agent's last conversation (`--continue`), false to begin one.
  resume: boolean
  // The session's first message, when it has one.
  text?: string //minLength: 1 //maxLength: 16384
  // Files to write into the agent's own Claude Code folder before it starts, replacing the last context's: `skills/...` as files, and a `CLAUDE.md` after the host's own rules. Absent, the last context and documents written stand.
  context: {
    key: string
    version: integer
    files: {
      path: string
      content: string
      executable: boolean
    }[]
  }
  documents: {
    key: string
    version: integer
    files: {
      path: string
      content: string
      executable: boolean
    }[]
  }[]
  // Present when the whole context is too large for a socket message: the path of `getSessionContext` for this session. A host reads it, with the stage's token, and writes what it answers in place of `context` and `documents`, which then hold only what fitted. A host that cannot read it writes them.
  contextUrl?: string
  // Set in the session's environment: the addresses of the services it is given. Never a secret.
  env: {
    [key: string]: string
  }
  credentials?: string[] //pattern: ^[a-z0-9][a-z0-9-]{0,63}$ //maxItems: 16
  ownCredentials?: string[] //pattern: ^[a-z0-9][a-z0-9-]{0,63}$ //maxItems: 16
  // The tokens of `credentials`, by variable, read as the command is pushed to the host's socket and never stored, so a listed or replayed command holds none and a rotated secret reaches the next start. The host writes them to a file in the agent's folder that only it can read, and the session's environment is set from that file, never from a command line.
  secrets: {
    [key: string]: string
  }
}
```

### #/components/schemas/MessageCommand

```typescript
// Deliver `text` at the session's next turn.
{
  // Report the command by this id once it is taken.
  id: string //minLength: 1 //maxLength: 128
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  kind: enum[message]
  text: string //minLength: 1 //maxLength: 16384
}
```

### #/components/schemas/InterruptCommand

```typescript
{
  // Report the command by this id once it is taken.
  id: string //minLength: 1 //maxLength: 128
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  kind: enum[interrupt]
  // Sent to the agent once the current turn has stopped.
  text?: string //minLength: 1 //maxLength: 16384
}
```

### #/components/schemas/StopCommand

```typescript
// End the session; the agent becomes idle.
{
  // Report the command by this id once it is taken.
  id: string //minLength: 1 //maxLength: 128
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  kind: enum[stop]
}
```

### #/components/schemas/RetireCommand

```typescript
// Stop any session and take the agent off the host. Its home folder is kept.
{
  // Report the command by this id once it is taken.
  id: string //minLength: 1 //maxLength: 128
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  kind: enum[retire]
}
```

### #/components/schemas/AgentPush

```typescript
// To viewers, whenever an agent changes.
{
  type: enum[agent]
  agent: {
    // Assigned by the service when the agent is created.
    id: string //format: uuid
    // Unique among agents not retired. Names its home folder and tmux session on its host.
    name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
    // What the agent named itself for its work, with `setAgentTitle`, or the person with `renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.
    title: string | null
    // A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none.
    label: string | null
    // The work item it was started on, as given when it was made; null for none.
    item: string | null //minLength: 1 //maxLength: 64
    // The role it was made from, as given when it was made; null for one made without.
    role: string | null //pattern: ^[a-z][a-z0-9-]{0,39}$
    // Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
    tokens: {
      // Input tokens not read from or written to the prompt cache.
      inputTokens: integer //minimum: 0 //maximum: 9007199254740991
      // Output tokens.
      outputTokens: integer //minimum: 0 //maximum: 9007199254740991
      // Input tokens written to the prompt cache.
      cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
      // Input tokens read from the prompt cache.
      cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    }
    // The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none.
    createdBy: string | null
    // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
    whenDone: enum[keep, stop, retire]
    documents: string[]
    // The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.
    credentials: array | null
    hostId: string //pattern: ^[A-Za-z0-9._-]{1,64}$
    // `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.
    state: enum[idle, working, waiting, interrupted, retired]
    // The live session, or null for none.
    session: object | null
    createdAt: string //format: date-time
    // When its host last reported a change to it; null until its host first reports it.
    reportedAt: string | null //format: date-time
    // What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `setAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `setAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.
    status: enum[working, idle, waiting, review, done, ] | null
    // One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.
    summary: string | null
    // A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.
    headline: string | null
    // When `summary` was said; null when there is none.
    saidAt: string | null //format: date-time
    // What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.
    activity: object | null
    // Background tasks and subagents its live session has open, as its host last reported; 0 without one.
    tasks: integer //minimum: 0
    // Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.
    told: boolean | null
    // Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.
    hostStatus: enum[connected, disconnected, lost]
  }
}
```

### #/components/schemas/Agent

```typescript
{
  // Assigned by the service when the agent is created.
  id: string //format: uuid
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // What the agent named itself for its work, with `setAgentTitle`, or the person with `renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.
  title: string | null
  // A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none.
  label: string | null
  // The work item it was started on, as given when it was made; null for none.
  item: string | null //minLength: 1 //maxLength: 64
  // The role it was made from, as given when it was made; null for one made without.
  role: string | null //pattern: ^[a-z][a-z0-9-]{0,39}$
  // Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
  tokens: {
    // Input tokens not read from or written to the prompt cache.
    inputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Output tokens.
    outputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens written to the prompt cache.
    cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    // Input tokens read from the prompt cache.
    cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
  }
  // The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none.
  createdBy: string | null
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  documents: string[]
  // The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.
  credentials: array | null
  hostId: string //pattern: ^[A-Za-z0-9._-]{1,64}$
  // `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.
  state: enum[idle, working, waiting, interrupted, retired]
  // The live session, or null for none.
  session: object | null
  createdAt: string //format: date-time
  // When its host last reported a change to it; null until its host first reports it.
  reportedAt: string | null //format: date-time
  // What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `setAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `setAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.
  status: enum[working, idle, waiting, review, done, ] | null
  // One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.
  summary: string | null
  // A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.
  headline: string | null
  // When `summary` was said; null when there is none.
  saidAt: string | null //format: date-time
  // What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.
  activity: object | null
  // Background tasks and subagents its live session has open, as its host last reported; 0 without one.
  tasks: integer //minimum: 0
  // Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.
  told: boolean | null
  // Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.
  hostStatus: enum[connected, disconnected, lost]
}
```

### #/components/schemas/Tokens

```typescript
// Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
{
  // Input tokens not read from or written to the prompt cache.
  inputTokens: integer //minimum: 0 //maximum: 9007199254740991
  // Output tokens.
  outputTokens: integer //minimum: 0 //maximum: 9007199254740991
  // Input tokens written to the prompt cache.
  cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
  // Input tokens read from the prompt cache.
  cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
}
```

### #/components/schemas/LinesPush

```typescript
// To viewers, as lines arrive.
{
  type: enum[lines]
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  lines: {
    // Line number per agent, from 0, continuing across its sessions.
    seq: integer //minimum: 0
    at: string //format: date-time
    // Assigned by the service when it queues the session's `start`.
    sessionId: string //format: uuid
    // `instruction`: a message sent to the agent.
    from: enum[agent, tool, instruction]
    // Whole up to 65536 characters. A text cut short, by its host to fit a socket message or here, ends `… [cut: N of M characters]`: N kept of the M there were.
    text: string
    // On an `instruction` line that is a command's text as the session took it (a `message`, a `start`'s first message, an `interrupt`'s text): that command's id. Absent on any other line.
    commandId?: string //minLength: 1 //maxLength: 128
  }[]
}
```

### #/components/schemas/TranscriptLine

```typescript
{
  // Line number per agent, from 0, continuing across its sessions.
  seq: integer //minimum: 0
  at: string //format: date-time
  // Assigned by the service when it queues the session's `start`.
  sessionId: string //format: uuid
  // `instruction`: a message sent to the agent.
  from: enum[agent, tool, instruction]
  // Whole up to 65536 characters. A text cut short, by its host to fit a socket message or here, ends `… [cut: N of M characters]`: N kept of the M there were.
  text: string
  // On an `instruction` line that is a command's text as the session took it (a `message`, a `start`'s first message, an `interrupt`'s text): that command's id. Absent on any other line.
  commandId?: string //minLength: 1 //maxLength: 128
}
```

### #/components/schemas/SentPush

```typescript
// To viewers, when a command carrying `text` (a `message`, a `start` or an `interrupt`) is queued, and each time its `delivery` changes, but for a time-based `withdrawn`, which a read of `listAgentCommands` says.
{
  type: enum[sent]
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  sent: {
    // discriminator: kind
    command: #/components/schemas/CreateCommand | #/components/schemas/StartCommand | #/components/schemas/MessageCommand | #/components/schemas/InterruptCommand | #/components/schemas/StopCommand | #/components/schemas/RetireCommand
    queuedAt: string //format: date-time
    // `queued`: not yet reported by the host. `written`: its text is in the agent's session, which has not yet taken it (it takes it at its next step); a session that ends first makes it `rejected`. `withdrawn`: never to be sent, because it went unreported for 300 seconds (`create` and `retire` excepted) or its agent was force-stopped. `done` / `rejected`: the host reported it, done (a text: taken) or not.
    delivery: enum[queued, written, withdrawn, done, rejected]
    // When the host last reported it; null until then.
    reportedAt: string | null //format: date-time
    // The host's words when it could not do the command; null otherwise.
    error: string | null
  }
}
```

### #/components/schemas/SentCommand

```typescript
{
  // discriminator: kind
  command: #/components/schemas/CreateCommand | #/components/schemas/StartCommand | #/components/schemas/MessageCommand | #/components/schemas/InterruptCommand | #/components/schemas/StopCommand | #/components/schemas/RetireCommand
  queuedAt: string //format: date-time
  // `queued`: not yet reported by the host. `written`: its text is in the agent's session, which has not yet taken it (it takes it at its next step); a session that ends first makes it `rejected`. `withdrawn`: never to be sent, because it went unreported for 300 seconds (`create` and `retire` excepted) or its agent was force-stopped. `done` / `rejected`: the host reported it, done (a text: taken) or not.
  delivery: enum[queued, written, withdrawn, done, rejected]
  // When the host last reported it; null until then.
  reportedAt: string | null //format: date-time
  // The host's words when it could not do the command; null otherwise.
  error: string | null
}
```

### #/components/schemas/HostPush

```typescript
// To viewers, on every heartbeat.
{
  type: enum[host]
  host: {
    id: string //pattern: ^[A-Za-z0-9._-]{1,64}$
    heartbeatAt: string //format: date-time
    // The agent-host build of its last heartbeat.
    version: string | null
    // Computed from `heartbeatAt` when the response was made, never stored. `connected`: silent at most 60 seconds. `disconnected`: at most 300. `lost`: longer.
    status: enum[connected, disconnected, lost]
    labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
    // How many sessions the host will run at once; null if it has never said.
    capacity: integer | null //minimum: 0 //maximum: 256
    // How many more sessions it will take now: `capacity` minus its agents with a live session. Null when `capacity` is.
    available: integer | null //minimum: 0 //maximum: 256
  }
}
```

### #/components/schemas/Host

```typescript
{
  id: string //pattern: ^[A-Za-z0-9._-]{1,64}$
  heartbeatAt: string //format: date-time
  // The agent-host build of its last heartbeat.
  version: string | null
  // Computed from `heartbeatAt` when the response was made, never stored. `connected`: silent at most 60 seconds. `disconnected`: at most 300. `lost`: longer.
  status: enum[connected, disconnected, lost]
  labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
  // How many sessions the host will run at once; null if it has never said.
  capacity: integer | null //minimum: 0 //maximum: 256
  // How many more sessions it will take now: `capacity` minus its agents with a live session. Null when `capacity` is.
  available: integer | null //minimum: 0 //maximum: 256
}
```

### #/components/schemas/UsagePush

```typescript
// To viewers, when a report brings a newer reading of the account's usage.
{
  type: enum[usage]
  // How much of the Claude account's 5-hour and weekly allowance is used, as last reported.
  usage: {
    // The newest of the windows' `readAt`; null when nothing has been reported.
    readAt: string | null //format: date-time
    // The 5-hour window's newest reading; null when none has been reported.
    fiveHour: object | null
    sevenDay: #/components/schemas/UsageWindow & 
  }
}
```

### #/components/schemas/Usage

```typescript
// How much of the Claude account's 5-hour and weekly allowance is used, as last reported.
{
  // The newest of the windows' `readAt`; null when nothing has been reported.
  readAt: string | null //format: date-time
  // The 5-hour window's newest reading; null when none has been reported.
  fiveHour: object | null
  sevenDay: #/components/schemas/UsageWindow & 
}
```

### #/components/schemas/UsageWindow

```typescript
// The 5-hour window's newest reading; null when none has been reported.
object | null
```

### #/components/schemas/SocketError

```typescript
// To the socket whose message could not be handled, saying why.
{
  type: enum[error]
  error: string
}
```

### #/components/schemas/Skill

```typescript
{
  // Whose skills these are: `agent-service`.
  key: string
  // The deployed tree's commit count, 0 when deployed from outside git.
  version: integer
  // The deployed commit, ending `-dirty` when deployed with uncommitted changes.
  commit: string
  files: {
    // Under the agent's Claude Code folder: `skills/<name>/bin/…` or `skills/<name>/reference/…`.
    path: string
    content: string
    executable: boolean
  }[]
}
```

### #/components/schemas/Error

```typescript
{
  error: string
}
```

### #/components/schemas/HeartbeatResponse

```typescript
{
  // Seconds until the host should send its next heartbeat.
  heartbeatInterval: integer //exclusiveMinimum: 0
  // Where to open the host's socket: `<socketUrl>?hostId=<id>` with this token as `Authorization: Bearer`. Commands and reports go by the socket alone, so on a server with none (null) no command reaches the host.
  socketUrl: string | null
}
```

### #/components/schemas/Heartbeat

```typescript
{
  // The agent-host build that sent the heartbeat.
  version: string //maxLength: 64
  labels?: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$ //maxItems: 64
  // How many sessions the host will run at once. Absent, capacity is unknown.
  capacity?: integer //minimum: 0 //maximum: 256
}
```

### #/components/schemas/HostList

```typescript
{
  hosts: {
    id: string //pattern: ^[A-Za-z0-9._-]{1,64}$
    heartbeatAt: string //format: date-time
    // The agent-host build of its last heartbeat.
    version: string | null
    // Computed from `heartbeatAt` when the response was made, never stored. `connected`: silent at most 60 seconds. `disconnected`: at most 300. `lost`: longer.
    status: enum[connected, disconnected, lost]
    labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
    // How many sessions the host will run at once; null if it has never said.
    capacity: integer | null //minimum: 0 //maximum: 256
    // How many more sessions it will take now: `capacity` minus its agents with a live session. Null when `capacity` is.
    available: integer | null //minimum: 0 //maximum: 256
  }[]
}
```

### #/components/schemas/RoleList

```typescript
{
  roles: {
    // A role's name, such as `reviewer`: what kind of agent it makes.
    name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
    documents: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
    // The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.
    credentials: array | null //maxItems: 16
    // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
    whenDone: enum[keep, stop, retire]
    // A short tag shown beside the agent's name, so sessions can be told apart.
    label: string //minLength: 1 //maxLength: 40
    // What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.
    description: string | null //minLength: 1 //maxLength: 16384
    // Of two requests waiting to start, the higher starts first.
    priority: integer //minimum: 0 //maximum: 1000
    // The first message of an agent made from it with no `brief` of its own; null when the caller must give one.
    brief: string | null //minLength: 1 //maxLength: 16384
    // When it was last written; null for a role as the stage was seeded with it.
    updatedAt: string | null //format: date-time
  }[]
}
```

### #/components/schemas/Role

```typescript
{
  // A role's name, such as `reviewer`: what kind of agent it makes.
  name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  documents: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
  // The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.
  credentials: array | null //maxItems: 16
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone: enum[keep, stop, retire]
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label: string //minLength: 1 //maxLength: 40
  // What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.
  description: string | null //minLength: 1 //maxLength: 16384
  // Of two requests waiting to start, the higher starts first.
  priority: integer //minimum: 0 //maximum: 1000
  // The first message of an agent made from it with no `brief` of its own; null when the caller must give one.
  brief: string | null //minLength: 1 //maxLength: 16384
  // When it was last written; null for a role as the stage was seeded with it.
  updatedAt: string | null //format: date-time
}
```

### #/components/schemas/NewRole

```typescript
{
  // A role's name, such as `reviewer`: what kind of agent it makes.
  name: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  documents?: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
  // Absent, null: the stage's defaults.
  credentials?: array | null //maxItems: 16
  // Absent, `keep`.
  whenDone?: enum[keep, stop, retire]
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label: string //minLength: 1 //maxLength: 40
  // Absent, null.
  description?: string | null //minLength: 1 //maxLength: 16384
  // Absent, 0.
  priority?: integer //minimum: 0 //maximum: 1000
  // Absent, null.
  brief?: string | null //minLength: 1 //maxLength: 16384
}
```

### #/components/schemas/RoleChange

```typescript
{
  documents?: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
  // The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.
  credentials?: array | null //maxItems: 16
  // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
  whenDone?: enum[keep, stop, retire]
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label?: string //minLength: 1 //maxLength: 40
  // What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.
  description?: string | null //minLength: 1 //maxLength: 16384
  // Of two requests waiting to start, the higher starts first.
  priority?: integer //minimum: 0 //maximum: 1000
  // The first message of an agent made from it with no `brief` of its own; null when the caller must give one.
  brief?: string | null //minLength: 1 //maxLength: 16384
}
```

### #/components/schemas/AgentRequest

```typescript
{
  // Assigned by the service; also the id of the agent it starts.
  id: string //format: uuid
  // A role's name, such as `reviewer`: what kind of agent it makes.
  role: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  // The first message; null to start on the role's own.
  brief: string | null
  // A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
  item: string | null //minLength: 1 //maxLength: 64
  // What it is for when that is no work item; null for none.
  subject: string | null
  // In place of the role's label; null for the role's.
  label: string | null
  labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
  // In place of the role's, by name; null for the role's. Never a token.
  credentials: array | null
  // The `claimed-by` header it was made with, unverified; null for none.
  requester: string | null
  // `waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.
  state: enum[waiting, started, withdrawn]
  // While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.
  why: string | null
  // Its role's, now.
  priority: integer //minimum: 0 //maximum: 1000
  // Where it stands among those waiting, 1 starting next; null once it is not waiting.
  position: integer | null //minimum: 1
  createdAt: string //format: date-time
  startedAt: string | null //format: date-time
  // The agent it started; null until it has.
  agentId: string | null //format: uuid
  withdrawnAt: string | null //format: date-time
}
```

### #/components/schemas/NewAgentRequest

```typescript
{
  // A role's name, such as `reviewer`: what kind of agent it makes.
  role: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  // The first message. Absent, the role's own; a role without one needs it.
  brief?: string //minLength: 1 //maxLength: 16384
  // A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
  item?: string //minLength: 1 //maxLength: 64
  // What it is for when that is no work item, such as `PR #41` or `judgment 3f…`: shown, never read.
  subject?: string //minLength: 1 //maxLength: 200
  // Absent, the role's.
  label?: string //minLength: 1 //maxLength: 40
  labels?: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$ //maxItems: 64
  credentials?: Partial(string) & Partial(   // A name with a token of the caller's, given this agent in place of the name's shared secret.
{
     name: string //pattern: ^[a-z0-9][a-z0-9-]{0,63}$
     token: string //minLength: 1 //maxLength: 4096
   })[] //maxItems: 16
  // A name with a token of the caller's, given this agent in place of the name's shared secret.
  tokens: {
    name: string //pattern: ^[a-z0-9][a-z0-9-]{0,63}$
    token: string //minLength: 1 //maxLength: 4096
  }[] //minItems: 1 //maxItems: 16
}
```

### #/components/schemas/AgentRequestList

```typescript
{
  requests: {
    // Assigned by the service; also the id of the agent it starts.
    id: string //format: uuid
    // A role's name, such as `reviewer`: what kind of agent it makes.
    role: string //pattern: ^[a-z][a-z0-9-]{0,39}$
    // The first message; null to start on the role's own.
    brief: string | null
    // A work-tracker item's id: the epic, story or task the agent was started on. Never changes.
    item: string | null //minLength: 1 //maxLength: 64
    // What it is for when that is no work item; null for none.
    subject: string | null
    // In place of the role's label; null for the role's.
    label: string | null
    labels: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$
    // In place of the role's, by name; null for the role's. Never a token.
    credentials: array | null
    // The `claimed-by` header it was made with, unverified; null for none.
    requester: string | null
    // `waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.
    state: enum[waiting, started, withdrawn]
    // While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.
    why: string | null
    // Its role's, now.
    priority: integer //minimum: 0 //maximum: 1000
    // Where it stands among those waiting, 1 starting next; null once it is not waiting.
    position: integer | null //minimum: 1
    createdAt: string //format: date-time
    startedAt: string | null //format: date-time
    // The agent it started; null until it has.
    agentId: string | null //format: uuid
    withdrawnAt: string | null //format: date-time
  }[]
}
```

### #/components/schemas/NewAgent

```typescript
{
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // The role it is made from (`listRoles`): its `documents`, `credentials`, `whenDone`, `label` and `brief` are the agent's, each unless given here, which overrides the role's. A role this stage does not have is refused.
  role?: string //pattern: ^[a-z][a-z0-9-]{0,39}$
  // Where it lives. Absent, the service places it on a `connected` host with room (`available` above 0), the one with the most first, carrying every one of `labels`.
  hostId?: string //pattern: ^[A-Za-z0-9._-]{1,64}$
  labels?: string[] //pattern: ^[a-z0-9][a-z0-9:._-]{0,63}$ //maxItems: 64
  // The first session's first message. Absent, the role's, if it has one; otherwise no session starts.
  brief?: string //minLength: 1 //maxLength: 16384
  // Absent, the role's, or without one none.
  label?: string //minLength: 1 //maxLength: 40
  // The work item it is started on, kept for its life so `listAgents` with `item` finds it. Absent, none.
  item?: string //minLength: 1 //maxLength: 64
  // Absent, the role's, or without one `keep`.
  whenDone?: enum[keep, stop, retire]
  credentials?: Partial(string) & Partial(   // A name with a token of the caller's, given this agent in place of the name's shared secret.
{
     name: string //pattern: ^[a-z0-9][a-z0-9-]{0,63}$
     token: string //minLength: 1 //maxLength: 4096
   })[] //maxItems: 16
  documents?: string[] //maxLength: 100 //pattern: ^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$ //maxItems: 8
}
```

### #/components/schemas/AgentList

```typescript
{
  agents: {
    // Assigned by the service when the agent is created.
    id: string //format: uuid
    // Unique among agents not retired. Names its home folder and tmux session on its host.
    name: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
    // What the agent named itself for its work, with `setAgentTitle`, or the person with `renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.
    title: string | null
    // A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none.
    label: string | null
    // The work item it was started on, as given when it was made; null for none.
    item: string | null //minLength: 1 //maxLength: 64
    // The role it was made from, as given when it was made; null for one made without.
    role: string | null //pattern: ^[a-z][a-z0-9-]{0,39}$
    // Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.
    tokens: {
      // Input tokens not read from or written to the prompt cache.
      inputTokens: integer //minimum: 0 //maximum: 9007199254740991
      // Output tokens.
      outputTokens: integer //minimum: 0 //maximum: 9007199254740991
      // Input tokens written to the prompt cache.
      cacheCreationInputTokens: integer //minimum: 0 //maximum: 9007199254740991
      // Input tokens read from the prompt cache.
      cacheReadInputTokens: integer //minimum: 0 //maximum: 9007199254740991
    }
    // The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none.
    createdBy: string | null
    // What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.
    whenDone: enum[keep, stop, retire]
    documents: string[]
    // The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.
    credentials: array | null
    hostId: string //pattern: ^[A-Za-z0-9._-]{1,64}$
    // `idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.
    state: enum[idle, working, waiting, interrupted, retired]
    // The live session, or null for none.
    session: object | null
    createdAt: string //format: date-time
    // When its host last reported a change to it; null until its host first reports it.
    reportedAt: string | null //format: date-time
    // What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `setAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `setAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.
    status: enum[working, idle, waiting, review, done, ] | null
    // One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.
    summary: string | null
    // A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.
    headline: string | null
    // When `summary` was said; null when there is none.
    saidAt: string | null //format: date-time
    // What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.
    activity: object | null
    // Background tasks and subagents its live session has open, as its host last reported; 0 without one.
    tasks: integer //minimum: 0
    // Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.
    told: boolean | null
    // Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.
    hostStatus: enum[connected, disconnected, lost]
  }[]
}
```

### #/components/schemas/Accepted

```typescript
{
  // Follow it in `listAgentCommands`. Null when nothing was sent to the host.
  commandId: string | null
}
```

### #/components/schemas/Message

```typescript
{
  // Required unless `interrupt` is true.
  text?: string //minLength: 1 //maxLength: 16384
  // `true` stops the current turn before `text` is sent.
  interrupt?: boolean
}
```

### #/components/schemas/Stop

```typescript
{
  // `true` ends it on record without waiting for the host, even one still connected.
  force?: boolean
}
```

### #/components/schemas/AgentRename

```typescript
{
  // Unique among agents not retired. Names its home folder and tmux session on its host.
  name?: string //pattern: ^[a-z0-9][a-z0-9-]{0,39}$
  // What the agent is there to do, in a few words.
  title?: string | null //minLength: 1 //maxLength: 40
  // A short tag shown beside the agent's name, so sessions can be told apart.
  label?: string | null //minLength: 1 //maxLength: 40
}
```

### #/components/schemas/AgentStatus

```typescript
{
  status: enum[working, waiting, review, done]
  // One line: what it is doing, while `waiting` what it needs from the person, in `review` what it submitted, or when `done` the result.
  summary: string //minLength: 1 //maxLength: 280
  // The summary in a few words a person can scan in a list, e.g. "Needs merge OK". Omitted, it is null.
  headline?: string //minLength: 1 //maxLength: 29
}
```

### #/components/schemas/AgentTitle

```typescript
{
  // What the agent is there to do, in a few words.
  title: string //minLength: 1 //maxLength: 40
}
```

### #/components/schemas/Transcript

```typescript
{
  lines: {
    // Line number per agent, from 0, continuing across its sessions.
    seq: integer //minimum: 0
    at: string //format: date-time
    // Assigned by the service when it queues the session's `start`.
    sessionId: string //format: uuid
    // `instruction`: a message sent to the agent.
    from: enum[agent, tool, instruction]
    // Whole up to 65536 characters. A text cut short, by its host to fit a socket message or here, ends `… [cut: N of M characters]`: N kept of the M there were.
    text: string
    // On an `instruction` line that is a command's text as the session took it (a `message`, a `start`'s first message, an `interrupt`'s text): that command's id. Absent on any other line.
    commandId?: string //minLength: 1 //maxLength: 128
  }[]
  // Pass as `after` to read what follows. Unchanged when nothing does yet.
  next: string //minLength: 1 //maxLength: 512
}
```

### #/components/schemas/Cursor

```typescript
// Pass as `after` to read what follows. Unchanged when nothing does yet.
string //minLength: 1 //maxLength: 512
```

### #/components/schemas/SessionList

```typescript
{
  sessions: {
    // Assigned by the service when it queues the session's `start`.
    id: string //format: uuid
    // Assigned by the service when the agent is created.
    agentId: string //format: uuid
    // When its `start` was queued.
    startedAt: string //format: date-time
    endedAt: string | null //format: date-time
    // `stopped`: told to stop, or its host ended it cleanly. `interrupted`: it died. Null while live.
    ended: enum[stopped, interrupted, ] | null
    // The `workplace/global` it started with, from honed; null when it was given none.
    context: object | null
    documents: {
      key: string
      version: integer
    }[]
    skills: {
      key: string
      version: integer
      commit: string
    }[]
    // Why it was given no context, or why a document it was made with, or a service's skill, was left out.
    contextNote: string | null
  }[]
}
```

### #/components/schemas/Session

```typescript
{
  // Assigned by the service when it queues the session's `start`.
  id: string //format: uuid
  // Assigned by the service when the agent is created.
  agentId: string //format: uuid
  // When its `start` was queued.
  startedAt: string //format: date-time
  endedAt: string | null //format: date-time
  // `stopped`: told to stop, or its host ended it cleanly. `interrupted`: it died. Null while live.
  ended: enum[stopped, interrupted, ] | null
  // The `workplace/global` it started with, from honed; null when it was given none.
  context: object | null
  documents: {
    key: string
    version: integer
  }[]
  skills: {
    key: string
    version: integer
    commit: string
  }[]
  // Why it was given no context, or why a document it was made with, or a service's skill, was left out.
  contextNote: string | null
}
```

### #/components/schemas/SessionContext

```typescript
{
  // Written as a start's `context` is; null when there is none to give.
  context: object | null
  documents: {
    key: string
    version: integer
    files: {
      path: string
      content: string
      executable: boolean
    }[]
  }[]
}
```

### #/components/schemas/AgentCommands

```typescript
{
  commands: {
    // discriminator: kind
    command: #/components/schemas/CreateCommand | #/components/schemas/StartCommand | #/components/schemas/MessageCommand | #/components/schemas/InterruptCommand | #/components/schemas/StopCommand | #/components/schemas/RetireCommand
    queuedAt: string //format: date-time
    // `queued`: not yet reported by the host. `written`: its text is in the agent's session, which has not yet taken it (it takes it at its next step); a session that ends first makes it `rejected`. `withdrawn`: never to be sent, because it went unreported for 300 seconds (`create` and `retire` excepted) or its agent was force-stopped. `done` / `rejected`: the host reported it, done (a text: taken) or not.
    delivery: enum[queued, written, withdrawn, done, rejected]
    // When the host last reported it; null until then.
    reportedAt: string | null //format: date-time
    // The host's words when it could not do the command; null otherwise.
    error: string | null
  }[]
}
```

### #/components/schemas/SocketTicket

```typescript
{
  ticket: string
  socketUrl: string
  expiresAt: string //format: date-time
}
```