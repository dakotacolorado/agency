# agent-service API reference

API version 2026-11-12

Runs lasting Claude Code **agents** on a fleet of hosts. Each agent lives on one host and runs in **sessions**; a **role** says what it starts with.

- **Create** an agent on a host, or **request** one in a role, started once Claude usage and a host's room allow. Admission starts the highest role `priority` first, then the oldest.
- **Talk to it** with `SendMessage`, which starts a session when none is live; `StopAgent`, `ResumeAgent` and `RetireAgent` end, carry on and end it for good.
- **Follow it**: its `status` is `working`, `idle`, `waiting` (on the person), `review` or `done`, which it says of itself with `PutAgentStatus`; `ListTranscriptLines` reads what it said, after a cursor.
- **Hosts** run agent-host, which sends heartbeats and takes commands on a WebSocket at `socketUrl`, through the *Host protocol* calls. You don't call those. A page watches live with a ticket from `CreateSocketTicket`.

**Auth:** `Authorization: Bearer <token>` with the stage's token, or the admin token, which also writes roles, on everything but `GetHealth` and the docs.

**Errors:** `{code, message}`, where `code` is an AWS-style exception name such as `ValidationException` or `ResourceNotFoundException`.

## Operations

- [CreateAgent](#createagent): Create an agent
- [CreateRequest](#createrequest): Create a request
- [CreateRole](#createrole): Create a role
- [CreateSocketTicket](#createsocketticket): Create a socket ticket
- [DeleteHost](#deletehost): Delete a host
- [GetAgent](#getagent): Get an agent
- [GetHealth](#gethealth): Get health
- [GetRequest](#getrequest): Get a request
- [GetRole](#getrole): Get a role
- [GetSessionContext](#getsessioncontext): Get a session's context
- [GetSkill](#getskill): Get the agents' clients
- [GetUsage](#getusage): Get usage
- [ListAgents](#listagents): List agents
- [ListCommands](#listcommands): List commands
- [ListHosts](#listhosts): List hosts
- [ListRequests](#listrequests): List requests
- [ListRoles](#listroles): List roles
- [ListSessions](#listsessions): List sessions
- [ListTranscriptLines](#listtranscriptlines): List transcript lines
- [PutAgentStatus](#putagentstatus): Put an agent's status
- [PutAgentTitle](#putagenttitle): Put an agent's title
- [ResumeAgent](#resumeagent): Resume an agent
- [RetireAgent](#retireagent): Retire an agent
- [SendHeartbeat](#sendheartbeat): Send a heartbeat
- [SendMessage](#sendmessage): Send a message
- [StopAgent](#stopagent): Stop an agent
- [UpdateAgent](#updateagent): Update an agent
- [UpdateRole](#updaterole): Update a role
- [WithdrawRequest](#withdrawrequest): Withdraw a request

## Data types

- [Accepted](#accepted)
- [Agent](#agent)
- [AgentCommands](#agentcommands)
- [AgentList](#agentlist)
- [AgentPush](#agentpush)
- [AgentRename](#agentrename)
- [AgentReport](#agentreport)
- [AgentRequest](#agentrequest)
- [AgentRequestList](#agentrequestlist)
- [AgentStatus](#agentstatus)
- [AgentTitle](#agenttitle)
- [Command](#command)
- [CommandPush](#commandpush)
- [CommandReport](#commandreport)
- [CreateCommand](#createcommand)
- [Cursor](#cursor)
- [Error](#error)
- [Heartbeat](#heartbeat)
- [Host](#host)
- [HostList](#hostlist)
- [HostPush](#hostpush)
- [InterruptCommand](#interruptcommand)
- [LineReport](#linereport)
- [LinesPush](#linespush)
- [Message](#message)
- [MessageCommand](#messagecommand)
- [NewAgent](#newagent)
- [NewAgentRequest](#newagentrequest)
- [NewRole](#newrole)
- [RetireCommand](#retirecommand)
- [Role](#role)
- [RoleChange](#rolechange)
- [RoleList](#rolelist)
- [SentCommand](#sentcommand)
- [SentPush](#sentpush)
- [Session](#session)
- [SessionContext](#sessioncontext)
- [SessionList](#sessionlist)
- [SessionTokensReport](#sessiontokensreport)
- [Skill](#skill)
- [SocketError](#socketerror)
- [SocketInbound](#socketinbound)
- [SocketOutbound](#socketoutbound)
- [SocketPing](#socketping)
- [SocketReport](#socketreport)
- [SocketTicket](#socketticket)
- [StartCommand](#startcommand)
- [Stop](#stop)
- [StopCommand](#stopcommand)
- [Tokens](#tokens)
- [Transcript](#transcript)
- [TranscriptLine](#transcriptline)
- [Usage](#usage)
- [UsagePush](#usagepush)
- [UsageReport](#usagereport)
- [UsageWindow](#usagewindow)
- [UsageWindowReport](#usagewindowreport)

---

## CreateAgent

Records the agent `idle` and queues `create` for its host, which makes its home. With a `brief`, also queues a `start` whose first message is the brief, and the agent is `working` at once. Without a `hostId`, the service chooses a connected host with room.

### Request syntax

```http
POST /agents HTTP/1.1
Authorization: Bearer token
claimed-by: string
Content-type: application/json

{
   "name": "string",
   "role": "string",
   "hostId": "string",
   "labels": [ "string" ],
   "brief": "string",
   "label": "string",
   "item": "string",
   "whenDone": "keep | stop | retire",
   "credentials": [ "string" ],
   "documents": [ "string" ]
}
```

### Request headers

**claimed-by**  
Who is making the agent: a person's name, or a service's own, such as `approval-service`. Recorded as `createdBy`, as said and not checked, since every caller holds the same token.  
Type: String. Length: 1 to 200. Required: No.

### Request body

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`. Required: Yes.

**role**  
The role it is made from (`ListRoles`): its `documents`, `credentials`, `whenDone`, `label` and `brief` are the agent's, each unless given here, which overrides the role's. A role this stage does not have is refused.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: No.

**hostId**  
Where it lives. Absent, the service places it on a `connected` host with room (`available` above 0), the one with the most first, carrying every one of `labels`.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`. Required: No.

**labels**  
Without `hostId`, what the host it is placed on must all carry.  
Type: Array of strings. At most 64 items. Required: No.

**brief**  
The first session's first message. Absent, the role's, if it has one; otherwise no session starts.  
Type: String. Length: 1 to 16384. Required: No.

**label**  
Absent, the role's, or without one none.  
Type: String. Length: 1 to 40. Required: No.

**item**  
The work item it is started on, kept for its life so `ListAgents` with `item` finds it. Absent, none.  
Type: String. Length: 1 to 64. Required: No.

**whenDone**  
Absent, the role's, or without one `keep`.  
Type: String. Valid values: `keep` | `stop` | `retire`. Required: No.

**credentials**  
The services each session is given an address and token for, by name: `agent-service` and each its services file names, such as `waypoint` and `honed`. A name it does not have is refused. Absent, the role's, or without one all of them. Only the names are kept on record; each token is read at each start. `{name, token}` gives this agent the caller's token in place of the name's shared one: kept apart from its record, never returned by any read, and deleted when the agent is retired.  
Type: Array of strings. At most 16 items. Required: No.

**documents**  
Given after `workplace/global` at each start, at their current version. A skill honed does not have is refused here. Absent, the role's, or without one only `workplace/global`.  
Type: Array of strings. At most 8 items. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "id": "string",
   "name": "string",
   "title": "string",
   "label": "string",
   "item": "string",
   "role": "string",
   "tokens": {
      "inputTokens": number,
      "outputTokens": number,
      "cacheCreationInputTokens": number,
      "cacheReadInputTokens": number
   },
   "createdBy": "string",
   "whenDone": "keep | stop | retire",
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "hostId": "string",
   "state": "idle | working | waiting | interrupted | retired",
   "session": {
      "id": "string",
      "startedAt": "string"
   },
   "createdAt": "string",
   "reportedAt": "string",
   "status": "working | idle | waiting | review | done | ",
   "summary": "string",
   "headline": "string",
   "saidAt": "string",
   "activity": {
      "text": "string",
      "at": "string"
   },
   "tasks": number,
   "told": boolean,
   "hostStatus": "connected | disconnected | lost"
}
```

### Response elements

**id**  
Assigned by the service when the agent is created.  
Type: String.

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`.

**title**  
What the agent named itself for its work, with `PutAgentTitle`, or the person with `UpdateAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.  
Type: String. Nullable: Yes.

**label**  
A short tag given when it was made or with `UpdateAgent`, shown beside its name. Null for none.  
Type: String. Nullable: Yes.

**item**  
The work item it was started on, as given when it was made; null for none.  
Type: String. Length: 1 to 64. Nullable: Yes.

**role**  
The role it was made from, as given when it was made; null for one made without.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Nullable: Yes.

**tokens**  
Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.  
Type: [Tokens](#tokens) object.

**createdBy**  
The `claimed-by` header of the `CreateAgent` call that made it, unverified. Null when it had none.  
Type: String. Nullable: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`.

**documents**  
The honed skills each session is given after `workplace/global`, by name.  
Type: Array of strings.

**credentials**  
The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.  
Type: Array of strings. Nullable: Yes.

**hostId**  
The host it lives on.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`.

**state**  
`idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.  
Type: String. Valid values: `idle` | `working` | `waiting` | `interrupted` | `retired`.

**session**  
The live session, or null for none.  
Type: Object. Nullable: Yes.

**createdAt**  
When it was made.  
Type: String.

**reportedAt**  
When its host last reported a change to it; null until its host first reports it.  
Type: String. Nullable: Yes.

**status**  
What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `PutAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `PutAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.  
Type: String. Valid values: `working` | `idle` | `waiting` | `review` | `done` | `null`. Nullable: Yes.

**summary**  
One line it, or approval-service, last said with `PutAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.  
Type: String. Nullable: Yes.

**headline**  
A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.  
Type: String. Nullable: Yes.

**saidAt**  
When `summary` was said; null when there is none.  
Type: String. Nullable: Yes.

**activity**  
What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.  
Type: Object. Nullable: Yes.

**tasks**  
Background tasks and subagents its live session has open, as its host last reported; 0 without one.  
Type: Integer. Range: 0 to any.

**told**  
Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.  
Type: Boolean. Nullable: Yes.

**hostStatus**  
Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.  
Type: String. Valid values: `connected` | `disconnected` | `lost`.

### Errors

**ValidationException**  
The request failed validation, `role` is not one this stage has, a credential is not one this stage has, or honed has no skill named in `documents`.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No host has the id `hostId`.  
HTTP status: 404

**ConflictException**  
Nothing was queued: an agent not retired already has `name`, the host is `lost`, or it is full and a `brief` was given.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured, or no `hostId` was given and no connected host fits and has room.  
HTTP status: 503

---

## CreateRequest

Records the request `waiting`, then admits what it can at once. A request starts once both usage windows read under 90% (from a reading under 15 minutes old, or one whose window has since reset) and a connected host carrying its `labels` has a free slot; of those waiting, the highest role `priority` first, then the oldest. Admission runs when a request is made and on every host's heartbeat, every 30 seconds while any host is connected, which is when a host's capacity and usage are next known. A reading older than that, of a window not since reset, still admits one request at a time while both windows read under 70%: one starts once none has since that reading, or none in the last 15 minutes, so the agent it starts gives the next reading. Admitted, the agent is made from its role as `CreateAgent` with `role` would, with this request's id as its own and a name of the service's choosing (`<role>-<first 8 of its id>`), placed on a host of the service's choosing; `agentId` names it. A request names no host or agent name.

### Request syntax

```http
POST /requests HTTP/1.1
Authorization: Bearer token
claimed-by: string
Content-type: application/json

{
   "role": "string",
   "brief": "string",
   "item": "string",
   "subject": "string",
   "label": "string",
   "labels": [ "string" ],
   "credentials": [ "string" ],
   "tokens": [ {
      "name": "string",
      "token": "string"
   } ]
}
```

### Request headers

**claimed-by**  
Who is making the agent: a person's name, or a service's own, such as `approval-service`. Recorded as `createdBy`, as said and not checked, since every caller holds the same token.  
Type: String. Length: 1 to 200. Required: No.

### Request body

**role**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: Yes.

**brief**  
The first message. Absent, the role's own; a role without one needs it.  
Type: String. Length: 1 to 16384. Required: No.

**item**  
A work-tracker item's id: the epic, story or task the agent was started on. Never changes.  
Type: String. Length: 1 to 64. Required: No.

**subject**  
What it is for when that is no work item, such as `PR #41` or `judgment 3f…`: shown, never read.  
Type: String. Length: 1 to 200. Required: No.

**label**  
Absent, the role's.  
Type: String. Length: 1 to 40. Required: No.

**labels**  
What the host it is placed on must all carry. Absent, none.  
Type: Array of strings. At most 64 items. Required: No.

**credentials**  
In place of the role's, as `CreateAgent` takes them; a `{name, token}` is kept for the agent it starts from now, and deleted if it is withdrawn.  
Type: Array of strings. At most 16 items. Required: No.

**tokens**  
Tokens of the caller's, each given the agent in place of that service's shared secret, for services it is given anyway: its role's, or `credentials`. The agent keeps its role's services, so a caller with a token of its own for one need not name them all. Kept as `credentials`' are; refused for a service the agent would not be given, or one `credentials` gives a token for.  
Type: Array of Object. At most 16 items. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "id": "string",
   "role": "string",
   "brief": "string",
   "item": "string",
   "subject": "string",
   "label": "string",
   "labels": [ "string" ],
   "credentials": [ "string" ],
   "requester": "string",
   "state": "waiting | started | withdrawn",
   "why": "string",
   "priority": number,
   "position": number,
   "createdAt": "string",
   "startedAt": "string",
   "agentId": "string",
   "withdrawnAt": "string"
}
```

### Response elements

**id**  
Assigned by the service; also the id of the agent it starts.  
Type: String.

**role**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`.

**brief**  
The first message; null to start on the role's own.  
Type: String. Nullable: Yes.

**item**  
A work-tracker item's id: the epic, story or task the agent was started on. Never changes.  
Type: String. Length: 1 to 64. Nullable: Yes.

**subject**  
What it is for when that is no work item; null for none.  
Type: String. Nullable: Yes.

**label**  
In place of the role's label; null for the role's.  
Type: String. Nullable: Yes.

**labels**  
What the host it is placed on must all carry.  
Type: Array of strings.

**credentials**  
In place of the role's, by name; null for the role's. Never a token.  
Type: Array of strings. Nullable: Yes.

**requester**  
The `claimed-by` header it was made with, unverified; null for none.  
Type: String. Nullable: Yes.

**state**  
`waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.  
Type: String. Valid values: `waiting` | `started` | `withdrawn`.

**why**  
While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.  
Type: String. Nullable: Yes.

**priority**  
Its role's, now.  
Type: Integer. Range: 0 to 1000.

**position**  
Where it stands among those waiting, 1 starting next; null once it is not waiting.  
Type: Integer. Range: 1 to any. Nullable: Yes.

**createdAt**  
When it was asked for.  
Type: String.

**startedAt**  
When its agent was made; null until then.  
Type: String. Nullable: Yes.

**agentId**  
The agent it started; null until it has.  
Type: String. Nullable: Yes.

**withdrawnAt**  
When it was withdrawn; null unless it was.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation, the stage has no such role, neither it nor its role has a brief, a credential is not one this stage has, or a token is for a service the agent would not be given.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ServiceUnavailableException**  
No API token is configured, or a token of its own could not be kept.  
HTTP status: 503

---

## CreateRole

Takes the stage's admin token. An agent made from it afterwards gets what it names; one made before keeps what it was given.

### Request syntax

```http
POST /roles HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "name": "string",
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "whenDone": "keep | stop | retire",
   "label": "string",
   "description": "string",
   "priority": number,
   "brief": "string"
}
```

### Request body

**name**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: Yes.

**documents**  
Absent, only `workplace/global`.  
Type: Array of strings. At most 8 items. Required: No.

**credentials**  
Absent, null: the stage's defaults.  
Type: Array of strings. At most 16 items. Nullable: Yes. Required: No.

**whenDone**  
Absent, `keep`.  
Type: String. Valid values: `keep` | `stop` | `retire`. Required: No.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40. Required: Yes.

**description**  
Absent, null.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: No.

**priority**  
Absent, 0.  
Type: Integer. Range: 0 to 1000. Required: No.

**brief**  
Absent, null.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "name": "string",
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "whenDone": "keep | stop | retire",
   "label": "string",
   "description": "string",
   "priority": number,
   "brief": "string",
   "updatedAt": "string"
}
```

### Response elements

**name**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`.

**documents**  
The honed skills each session of an agent made from it is given after `workplace/global`, by name, in this order.  
Type: Array of strings. At most 8 items.

**credentials**  
The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.  
Type: Array of strings. At most 16 items. Nullable: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40.

**description**  
What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.  
Type: String. Length: 1 to 16384. Nullable: Yes.

**priority**  
Of two requests waiting to start, the higher starts first.  
Type: Integer. Range: 0 to 1000.

**brief**  
The first message of an agent made from it with no `brief` of its own; null when the caller must give one.  
Type: String. Length: 1 to 16384. Nullable: Yes.

**updatedAt**  
When it was last written; null for a role as the stage was seeded with it.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation, a credential is not one this stage has, or honed has no skill named in `documents`.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**AccessDeniedException**  
Writing a role takes the stage's admin token.  
HTTP status: 403

**ConflictException**  
A role has this name already.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## CreateSocketTicket

A browser cannot set a header on a WebSocket, and a long-lived token must never go in a URL, so a page opens `<socketUrl>?ticket=<ticket>` instead. Good once, for 60 seconds. The socket then receives `SocketOutbound` messages: `agent`, `lines` and `host`.

### Request syntax

```http
POST /socket-tickets HTTP/1.1
Authorization: Bearer token
```

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "ticket": "string",
   "socketUrl": "string",
   "expiresAt": "string"
}
```

### Response elements

**ticket**  
Pass as `?ticket=` on the socket; good once.  
Type: String.

**socketUrl**  
The socket's address.  
Type: String.

**expiresAt**  
When it is no longer good.  
Type: String.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ServiceUnavailableException**  
No API token is configured, or this server has no socket.  
HTTP status: 503

---

## DeleteHost

Deletes the host's record, which is how a host leaves `ListHosts`. Its agents, their transcripts and the commands sent to them stay on record, and its agents read as on a `lost` host. The next heartbeat from this id registers it again, and its socket is sent whatever is still queued for it.

### Request syntax

```http
DELETE /hosts/{id} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`. Required: Yes.

### Response syntax

```http
HTTP/1.1 204
```

Deregistered.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No host has this id.  
HTTP status: 404

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## GetAgent

Get one agent.

### Request syntax

```http
GET /agents/{id} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "name": "string",
   "title": "string",
   "label": "string",
   "item": "string",
   "role": "string",
   "tokens": {
      "inputTokens": number,
      "outputTokens": number,
      "cacheCreationInputTokens": number,
      "cacheReadInputTokens": number
   },
   "createdBy": "string",
   "whenDone": "keep | stop | retire",
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "hostId": "string",
   "state": "idle | working | waiting | interrupted | retired",
   "session": {
      "id": "string",
      "startedAt": "string"
   },
   "createdAt": "string",
   "reportedAt": "string",
   "status": "working | idle | waiting | review | done | ",
   "summary": "string",
   "headline": "string",
   "saidAt": "string",
   "activity": {
      "text": "string",
      "at": "string"
   },
   "tasks": number,
   "told": boolean,
   "hostStatus": "connected | disconnected | lost"
}
```

### Response elements

**id**  
Assigned by the service when the agent is created.  
Type: String.

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`.

**title**  
What the agent named itself for its work, with `PutAgentTitle`, or the person with `UpdateAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.  
Type: String. Nullable: Yes.

**label**  
A short tag given when it was made or with `UpdateAgent`, shown beside its name. Null for none.  
Type: String. Nullable: Yes.

**item**  
The work item it was started on, as given when it was made; null for none.  
Type: String. Length: 1 to 64. Nullable: Yes.

**role**  
The role it was made from, as given when it was made; null for one made without.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Nullable: Yes.

**tokens**  
Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.  
Type: [Tokens](#tokens) object.

**createdBy**  
The `claimed-by` header of the `CreateAgent` call that made it, unverified. Null when it had none.  
Type: String. Nullable: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`.

**documents**  
The honed skills each session is given after `workplace/global`, by name.  
Type: Array of strings.

**credentials**  
The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.  
Type: Array of strings. Nullable: Yes.

**hostId**  
The host it lives on.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`.

**state**  
`idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.  
Type: String. Valid values: `idle` | `working` | `waiting` | `interrupted` | `retired`.

**session**  
The live session, or null for none.  
Type: Object. Nullable: Yes.

**createdAt**  
When it was made.  
Type: String.

**reportedAt**  
When its host last reported a change to it; null until its host first reports it.  
Type: String. Nullable: Yes.

**status**  
What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `PutAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `PutAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.  
Type: String. Valid values: `working` | `idle` | `waiting` | `review` | `done` | `null`. Nullable: Yes.

**summary**  
One line it, or approval-service, last said with `PutAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.  
Type: String. Nullable: Yes.

**headline**  
A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.  
Type: String. Nullable: Yes.

**saidAt**  
When `summary` was said; null when there is none.  
Type: String. Nullable: Yes.

**activity**  
What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.  
Type: Object. Nullable: Yes.

**tasks**  
Background tasks and subagents its live session has open, as its host last reported; 0 without one.  
Type: Integer. Range: 0 to any.

**told**  
Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.  
Type: Boolean. Nullable: Yes.

**hostStatus**  
Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.  
Type: String. Valid values: `connected` | `disconnected` | `lost`.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## GetHealth

Whether it is up, and the version and commit it runs.

### Request syntax

```http
GET /health HTTP/1.1
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "ok": "true",
   "version": "string",
   "commit": "string"
}
```

### Response elements

**ok**  
Type: Boolean.

**version**  
The package's version.  
Type: String.

**commit**  
The commit it was built from, ending `-dirty` when built with uncommitted changes.  
Type: String.

---

## GetRequest

Get one request for an agent.

### Request syntax

```http
GET /requests/{id} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Assigned by the service; also the id of the agent it starts.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "role": "string",
   "brief": "string",
   "item": "string",
   "subject": "string",
   "label": "string",
   "labels": [ "string" ],
   "credentials": [ "string" ],
   "requester": "string",
   "state": "waiting | started | withdrawn",
   "why": "string",
   "priority": number,
   "position": number,
   "createdAt": "string",
   "startedAt": "string",
   "agentId": "string",
   "withdrawnAt": "string"
}
```

### Response elements

**id**  
Assigned by the service; also the id of the agent it starts.  
Type: String.

**role**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`.

**brief**  
The first message; null to start on the role's own.  
Type: String. Nullable: Yes.

**item**  
A work-tracker item's id: the epic, story or task the agent was started on. Never changes.  
Type: String. Length: 1 to 64. Nullable: Yes.

**subject**  
What it is for when that is no work item; null for none.  
Type: String. Nullable: Yes.

**label**  
In place of the role's label; null for the role's.  
Type: String. Nullable: Yes.

**labels**  
What the host it is placed on must all carry.  
Type: Array of strings.

**credentials**  
In place of the role's, by name; null for the role's. Never a token.  
Type: Array of strings. Nullable: Yes.

**requester**  
The `claimed-by` header it was made with, unverified; null for none.  
Type: String. Nullable: Yes.

**state**  
`waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.  
Type: String. Valid values: `waiting` | `started` | `withdrawn`.

**why**  
While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.  
Type: String. Nullable: Yes.

**priority**  
Its role's, now.  
Type: Integer. Range: 0 to 1000.

**position**  
Where it stands among those waiting, 1 starting next; null once it is not waiting.  
Type: Integer. Range: 1 to any. Nullable: Yes.

**createdAt**  
When it was asked for.  
Type: String.

**startedAt**  
When its agent was made; null until then.  
Type: String. Nullable: Yes.

**agentId**  
The agent it started; null until it has.  
Type: String. Nullable: Yes.

**withdrawnAt**  
When it was withdrawn; null unless it was.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No request has this id.  
HTTP status: 404

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## GetRole

Get one role.

### Request syntax

```http
GET /roles/{name} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**name**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "name": "string",
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "whenDone": "keep | stop | retire",
   "label": "string",
   "description": "string",
   "priority": number,
   "brief": "string",
   "updatedAt": "string"
}
```

### Response elements

**name**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`.

**documents**  
The honed skills each session of an agent made from it is given after `workplace/global`, by name, in this order.  
Type: Array of strings. At most 8 items.

**credentials**  
The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.  
Type: Array of strings. At most 16 items. Nullable: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40.

**description**  
What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.  
Type: String. Length: 1 to 16384. Nullable: Yes.

**priority**  
Of two requests waiting to start, the higher starts first.  
Type: Integer. Range: 0 to 1000.

**brief**  
The first message of an agent made from it with no `brief` of its own; null when the caller must give one.  
Type: String. Length: 1 to 16384. Nullable: Yes.

**updatedAt**  
When it was last written; null for a role as the stage was seeded with it.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No role has this name.  
HTTP status: 404

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## GetSessionContext

Read at the moment it is asked, as a start's is, and recorded on the session in place of what its start carried, so the session's `contextNote` says what it was given.

### Request syntax

```http
GET /agents/{id}/sessions/{sessionId}/context HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**sessionId**  
Assigned by the service when it queues the session's `start`.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "context": {
      "key": "string",
      "version": number,
      "files": [ {
         "path": "string",
         "content": "string",
         "executable": boolean
      } ]
   },
   "documents": [ {
      "key": "string",
      "version": number,
      "files": [ {
         "path": "string",
         "content": "string",
         "executable": boolean
      } ]
   } ]
}
```

### Response elements

**context**  
Written as a start's `context` is; null when there is none to give.  
Type: Object. Nullable: Yes.

**documents**  
Written after it, as a start's `documents` are.  
Type: Array of Object.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ConflictException**  
The session is not the agent's live one.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## GetSkill

The `page` and `title` skills, `SKILL.md`, `bin/` and `reference/`, as this deployment was built with them. Every start lays them, and each other service's `GET /skill` (its `bin/` and `reference/` alone), over `workplace/global`'s files at the same paths, so an agent calls the API that is deployed.

### Request syntax

```http
GET /skill HTTP/1.1
Authorization: Bearer token
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "key": "string",
   "version": number,
   "commit": "string",
   "files": [ {
      "path": "string",
      "content": "string",
      "executable": boolean
   } ]
}
```

### Response elements

**key**  
Whose skills these are: `agent-service`.  
Type: String.

**version**  
The deployed tree's commit count, 0 when deployed from outside git.  
Type: Integer.

**commit**  
The deployed commit, ending `-dirty` when deployed with uncommitted changes.  
Type: String.

**files**  
Every file, as each session is given them.  
Type: Array of Object.

### Errors

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## GetUsage

The newest reading of each window any host has reported. A window whose `resetsAt` has passed has since started again from 0; the reading says only what was true at `readAt`. With nothing reported yet, every field is null.

### Request syntax

```http
GET /usage HTTP/1.1
Authorization: Bearer token
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "readAt": "string",
   "fiveHour": {
      "utilization": number,
      "resetsAt": "string",
      "readAt": "string",
      "hostId": "string"
   },
   "sevenDay": {
      "utilization": number,
      "resetsAt": "string",
      "readAt": "string",
      "hostId": "string"
   }
}
```

### Response elements

**readAt**  
The newest of the windows' `readAt`; null when nothing has been reported.  
Type: String. Nullable: Yes.

**fiveHour**  
The 5-hour window's newest reading; null when none has been reported.  
Type: [UsageWindow](#usagewindow) object.

**sevenDay**  
The weekly window's newest reading; null when none has been reported.  
Type: [UsageWindow](#usagewindow) object.

### Errors

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## ListAgents

Retired agents are listed only with `all=true`, or with `item`. With `createdBy`, only the agents made by that `claimed-by`, so a service can list its own. With `item`, only those started on that work item, retired ones included, so what they used is still there once they have gone. With `role`, only those made from that role.

### Request syntax

```http
GET /agents?createdBy=createdBy&item=item&role=role&all=all HTTP/1.1
Authorization: Bearer token
```

### Query parameters

**createdBy**  
Type: String. Length: 1 to 200. Required: No.

**item**  
A work-tracker item's id: the epic, story or task the agent was started on. Never changes.  
Type: String. Length: 1 to 64. Required: No.

**role**  
Only the agents made from this role.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: No.

**all**  
`true` includes retired agents.  
Type: String. Valid values: `true` | `false`. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "agents": [ {
      "id": "string",
      "name": "string",
      "title": "string",
      "label": "string",
      "item": "string",
      "role": "string",
      "tokens": {
         "inputTokens": number,
         "outputTokens": number,
         "cacheCreationInputTokens": number,
         "cacheReadInputTokens": number
      },
      "createdBy": "string",
      "whenDone": "keep | stop | retire",
      "documents": [ "string" ],
      "credentials": [ "string" ],
      "hostId": "string",
      "state": "idle | working | waiting | interrupted | retired",
      "session": {
         "id": "string",
         "startedAt": "string"
      },
      "createdAt": "string",
      "reportedAt": "string",
      "status": "working | idle | waiting | review | done | ",
      "summary": "string",
      "headline": "string",
      "saidAt": "string",
      "activity": {
         "text": "string",
         "at": "string"
      },
      "tasks": number,
      "told": boolean,
      "hostStatus": "connected | disconnected | lost"
   } ]
}
```

### Response elements

**agents**  
The agents, oldest first.  
Type: Array of [Agent](#agent) objects.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## ListCommands

Each is kept 7 days from when it was queued, then deleted.

### Request syntax

```http
GET /agents/{id}/commands HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "commands": [ {
      "command": value,
      "queuedAt": "string",
      "delivery": "queued | written | withdrawn | done | rejected",
      "reportedAt": "string",
      "error": "string"
   } ]
}
```

### Response elements

**commands**  
Its commands, oldest first.  
Type: Array of [SentCommand](#sentcommand) objects.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## ListHosts

Every host that has sent a heartbeat since it was last deregistered with `DeleteHost`, however long it has been `lost`. With `status`, only the hosts with one of those statuses.

### Request syntax

```http
GET /hosts?status=status HTTP/1.1
Authorization: Bearer token
```

### Query parameters

**status**  
Comma-separated, any of `connected`, `disconnected`, `lost`.  
Type: String. Pattern: `^(connected|disconnected|lost)(,(connected|disconnected|lost))*$`. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "hosts": [ {
      "id": "string",
      "heartbeatAt": "string",
      "version": "string",
      "status": "connected | disconnected | lost",
      "labels": [ "string" ],
      "capacity": number,
      "available": number
   } ]
}
```

### Response elements

**hosts**  
The hosts.  
Type: Array of [Host](#host) objects.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## ListRequests

Those `waiting`, in the order they would start, each with why it waits. With `all=true`, every one, the waiting first in that order and then the rest newest first. A request starts once both usage windows read under 90% (from a reading under 15 minutes old, or one whose window has since reset) and a connected host carrying its `labels` has a free slot; of those waiting, the highest role `priority` first, then the oldest. Admission runs when a request is made and on every host's heartbeat, every 30 seconds while any host is connected, which is when a host's capacity and usage are next known. A reading older than that, of a window not since reset, still admits one request at a time while both windows read under 70%: one starts once none has since that reading, or none in the last 15 minutes, so the agent it starts gives the next reading.

### Request syntax

```http
GET /requests?all=all&requester=requester&item=item HTTP/1.1
Authorization: Bearer token
```

### Query parameters

**all**  
`true` includes those started and withdrawn.  
Type: String. Valid values: `true` | `false`. Required: No.

**requester**  
Only those made with this `claimed-by`.  
Type: String. Length: 1 to 200. Required: No.

**item**  
Only those for this work item.  
Type: String. Length: 1 to 64. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "requests": [ {
      "id": "string",
      "role": "string",
      "brief": "string",
      "item": "string",
      "subject": "string",
      "label": "string",
      "labels": [ "string" ],
      "credentials": [ "string" ],
      "requester": "string",
      "state": "waiting | started | withdrawn",
      "why": "string",
      "priority": number,
      "position": number,
      "createdAt": "string",
      "startedAt": "string",
      "agentId": "string",
      "withdrawnAt": "string"
   } ]
}
```

### Response elements

**requests**  
The requests: the waiting in start order, then the rest newest first.  
Type: Array of [AgentRequest](#agentrequest) objects.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## ListRoles

Every role an agent can be made from, highest `priority` first. A stage starts with `planner`, `reviewer`, `conflict`, `investigator`, `judge` and `implementer`, as their callers made them before roles; one written with `CreateRole` or `UpdateRole` is served as written.

### Request syntax

```http
GET /roles HTTP/1.1
Authorization: Bearer token
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "roles": [ {
      "name": "string",
      "documents": [ "string" ],
      "credentials": [ "string" ],
      "whenDone": "keep | stop | retire",
      "label": "string",
      "description": "string",
      "priority": number,
      "brief": "string",
      "updatedAt": "string"
   } ]
}
```

### Response elements

**roles**  
Every role, highest `priority` first.  
Type: Array of [Role](#role) objects.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## ListSessions

List an agent's sessions, oldest first.

### Request syntax

```http
GET /agents/{id}/sessions HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "sessions": [ {
      "id": "string",
      "agentId": "string",
      "startedAt": "string",
      "endedAt": "string",
      "ended": "stopped | interrupted | ",
      "context": {
         "key": "string",
         "version": number
      },
      "documents": [ {
         "key": "string",
         "version": number
      } ],
      "skills": [ {
         "key": "string",
         "version": number,
         "commit": "string"
      } ],
      "contextNote": "string"
   } ]
}
```

### Response elements

**sessions**  
Its sessions, oldest first.  
Type: Array of [Session](#session) objects.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## ListTranscriptLines

Poll with the returned `next`, or take `lines` on a socket, to follow it as it grows.

### Request syntax

```http
GET /agents/{id}/transcript?after=after&limit=limit HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Query parameters

**after**  
The `next` from the previous read. Absent reads from the start.  
Type: [Cursor](#cursor) object. Length: 1 to 512. Required: No.

**limit**  
Type: Integer. Range: 1 to 1000. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "lines": [ {
      "seq": number,
      "at": "string",
      "sessionId": "string",
      "from": "agent | tool | instruction",
      "text": "string",
      "commandId": "string"
   } ],
   "next": "string"
}
```

### Response elements

**lines**  
The lines after `after`, oldest first.  
Type: Array of [TranscriptLine](#transcriptline) objects.

**next**  
Pass as `after` to read what follows. Unchanged when nothing does yet.  
Type: [Cursor](#cursor) object. Length: 1 to 512.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## PutAgentStatus

Called by the agent itself, from its `page` skill, and by approval-service for the agent whose change it took or shipped. `waiting` says the agent needs the person; it stands until the person messages it. `working` only says what it is doing: whether it reads `working` or `idle` is its host's turns. `review` says its change is submitted to approval-service and `done` that it finished, or its change shipped; each needs no live session. Not sent to its host. Once the agent is in `review` or `done` and no turn or background task of its runs, `whenDone` is carried out: `stop` stops its session, and `retire` retires it once `done` (in `review` it is stopped, never retired, so a send-back reaches it).

### Request syntax

```http
PUT /agents/{id}/status HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "status": "working | waiting | review | done",
   "summary": "string",
   "headline": "string"
}
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Request body

**status**  
`working` or `waiting` (on the person) while its session is live; `review` once its change is submitted, `done` once it has finished.  
Type: String. Valid values: `working` | `waiting` | `review` | `done`. Required: Yes.

**summary**  
One line: what it is doing, while `waiting` what it needs from the person, in `review` what it submitted, or when `done` the result.  
Type: String. Length: 1 to 280. Required: Yes.

**headline**  
The summary in a few words a person can scan in a list, e.g. "Needs merge OK". Omitted, it is null.  
Type: String. Length: 1 to 29. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "name": "string",
   "title": "string",
   "label": "string",
   "item": "string",
   "role": "string",
   "tokens": {
      "inputTokens": number,
      "outputTokens": number,
      "cacheCreationInputTokens": number,
      "cacheReadInputTokens": number
   },
   "createdBy": "string",
   "whenDone": "keep | stop | retire",
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "hostId": "string",
   "state": "idle | working | waiting | interrupted | retired",
   "session": {
      "id": "string",
      "startedAt": "string"
   },
   "createdAt": "string",
   "reportedAt": "string",
   "status": "working | idle | waiting | review | done | ",
   "summary": "string",
   "headline": "string",
   "saidAt": "string",
   "activity": {
      "text": "string",
      "at": "string"
   },
   "tasks": number,
   "told": boolean,
   "hostStatus": "connected | disconnected | lost"
}
```

### Response elements

**id**  
Assigned by the service when the agent is created.  
Type: String.

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`.

**title**  
What the agent named itself for its work, with `PutAgentTitle`, or the person with `UpdateAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.  
Type: String. Nullable: Yes.

**label**  
A short tag given when it was made or with `UpdateAgent`, shown beside its name. Null for none.  
Type: String. Nullable: Yes.

**item**  
The work item it was started on, as given when it was made; null for none.  
Type: String. Length: 1 to 64. Nullable: Yes.

**role**  
The role it was made from, as given when it was made; null for one made without.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Nullable: Yes.

**tokens**  
Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.  
Type: [Tokens](#tokens) object.

**createdBy**  
The `claimed-by` header of the `CreateAgent` call that made it, unverified. Null when it had none.  
Type: String. Nullable: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`.

**documents**  
The honed skills each session is given after `workplace/global`, by name.  
Type: Array of strings.

**credentials**  
The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.  
Type: Array of strings. Nullable: Yes.

**hostId**  
The host it lives on.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`.

**state**  
`idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.  
Type: String. Valid values: `idle` | `working` | `waiting` | `interrupted` | `retired`.

**session**  
The live session, or null for none.  
Type: Object. Nullable: Yes.

**createdAt**  
When it was made.  
Type: String.

**reportedAt**  
When its host last reported a change to it; null until its host first reports it.  
Type: String. Nullable: Yes.

**status**  
What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `PutAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `PutAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.  
Type: String. Valid values: `working` | `idle` | `waiting` | `review` | `done` | `null`. Nullable: Yes.

**summary**  
One line it, or approval-service, last said with `PutAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.  
Type: String. Nullable: Yes.

**headline**  
A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.  
Type: String. Nullable: Yes.

**saidAt**  
When `summary` was said; null when there is none.  
Type: String. Nullable: Yes.

**activity**  
What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.  
Type: Object. Nullable: Yes.

**tasks**  
Background tasks and subagents its live session has open, as its host last reported; 0 without one.  
Type: Integer. Range: 0 to any.

**told**  
Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.  
Type: Boolean. Nullable: Yes.

**hostStatus**  
Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.  
Type: String. Valid values: `connected` | `disconnected` | `lost`.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ConflictException**  
The agent is retired, or has no live session to be `working` or `waiting`.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## PutAgentTitle

Called by the agent itself, early in its first session, once it knows what it is there to do. Set once: after that only the person changes it, with `UpdateAgent`.

### Request syntax

```http
PUT /agents/{id}/title HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "title": "string"
}
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Request body

**title**  
What the agent is there to do, in a few words.  
Type: String. Length: 1 to 40. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "name": "string",
   "title": "string",
   "label": "string",
   "item": "string",
   "role": "string",
   "tokens": {
      "inputTokens": number,
      "outputTokens": number,
      "cacheCreationInputTokens": number,
      "cacheReadInputTokens": number
   },
   "createdBy": "string",
   "whenDone": "keep | stop | retire",
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "hostId": "string",
   "state": "idle | working | waiting | interrupted | retired",
   "session": {
      "id": "string",
      "startedAt": "string"
   },
   "createdAt": "string",
   "reportedAt": "string",
   "status": "working | idle | waiting | review | done | ",
   "summary": "string",
   "headline": "string",
   "saidAt": "string",
   "activity": {
      "text": "string",
      "at": "string"
   },
   "tasks": number,
   "told": boolean,
   "hostStatus": "connected | disconnected | lost"
}
```

### Response elements

**id**  
Assigned by the service when the agent is created.  
Type: String.

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`.

**title**  
What the agent named itself for its work, with `PutAgentTitle`, or the person with `UpdateAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.  
Type: String. Nullable: Yes.

**label**  
A short tag given when it was made or with `UpdateAgent`, shown beside its name. Null for none.  
Type: String. Nullable: Yes.

**item**  
The work item it was started on, as given when it was made; null for none.  
Type: String. Length: 1 to 64. Nullable: Yes.

**role**  
The role it was made from, as given when it was made; null for one made without.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Nullable: Yes.

**tokens**  
Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.  
Type: [Tokens](#tokens) object.

**createdBy**  
The `claimed-by` header of the `CreateAgent` call that made it, unverified. Null when it had none.  
Type: String. Nullable: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`.

**documents**  
The honed skills each session is given after `workplace/global`, by name.  
Type: Array of strings.

**credentials**  
The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.  
Type: Array of strings. Nullable: Yes.

**hostId**  
The host it lives on.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`.

**state**  
`idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.  
Type: String. Valid values: `idle` | `working` | `waiting` | `interrupted` | `retired`.

**session**  
The live session, or null for none.  
Type: Object. Nullable: Yes.

**createdAt**  
When it was made.  
Type: String.

**reportedAt**  
When its host last reported a change to it; null until its host first reports it.  
Type: String. Nullable: Yes.

**status**  
What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `PutAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `PutAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.  
Type: String. Valid values: `working` | `idle` | `waiting` | `review` | `done` | `null`. Nullable: Yes.

**summary**  
One line it, or approval-service, last said with `PutAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.  
Type: String. Nullable: Yes.

**headline**  
A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.  
Type: String. Nullable: Yes.

**saidAt**  
When `summary` was said; null when there is none.  
Type: String. Nullable: Yes.

**activity**  
What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.  
Type: Object. Nullable: Yes.

**tasks**  
Background tasks and subagents its live session has open, as its host last reported; 0 without one.  
Type: Integer. Range: 0 to any.

**told**  
Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.  
Type: Boolean. Nullable: Yes.

**hostStatus**  
Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.  
Type: String. Valid values: `connected` | `disconnected` | `lost`.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ConflictException**  
The agent is retired, or has a title already.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## ResumeAgent

Queues a `start` with `resume: true`, or `false` for an agent that has never had a session.

### Request syntax

```http
POST /agents/{id}/resume HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 202
Content-type: application/json

{
   "commandId": "string"
}
```

### Response elements

**commandId**  
Follow it in `ListCommands`. Null when nothing was sent to the host.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ConflictException**  
Nothing was queued: the agent is retired or has a live session, or its host is `lost` or full.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## RetireAgent

Records it `retired` at once, ends any session, frees its name, and queues a `stop` if it had a live session and then `retire`, which is offered until its host takes it. Its transcript, sessions and home folder are kept.

### Request syntax

```http
DELETE /agents/{id} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 202
Content-type: application/json

{
   "commandId": "string"
}
```

### Response elements

**commandId**  
Follow it in `ListCommands`. Null when nothing was sent to the host.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ConflictException**  
Nothing was queued: the agent is retired already.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## SendHeartbeat

Liveness and what the host offers, nothing more: commands come down the host's socket at `socketUrl`, and reports go up it. The host chooses its id; the first heartbeat from an id registers it. Only a heartbeat keeps a host `connected`.

### Request syntax

```http
POST /hosts/{id}/heartbeat HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "version": "string",
   "labels": [ "string" ],
   "capacity": number
}
```

### URI request parameters

**id**  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`. Required: Yes.

### Request body

**version**  
The agent-host build that sent the heartbeat.  
Type: String. Length: 0 to 64. Required: Yes.

**labels**  
What the host offers, as its owner configured it. A full snapshot; absent, the host's last labels stand (none for a new host).  
Type: Array of strings. At most 64 items. Required: No.

**capacity**  
How many sessions the host will run at once. Absent, capacity is unknown.  
Type: Integer. Range: 0 to 256. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "heartbeatInterval": number,
   "socketUrl": "string"
}
```

### Response elements

**heartbeatInterval**  
Seconds until the host should send its next heartbeat.  
Type: Integer.

**socketUrl**  
Where to open the host's socket: `<socketUrl>?hostId=<id>` with this token as `Authorization: Bearer`. Commands and reports go by the socket alone, so on a server with none (null) no command reaches the host.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## SendMessage

To an agent with a live session, `text` is a `message`, delivered at its next turn; with `interrupt: true` it is an `interrupt`, stopping the current turn first, and with no `text` it only interrupts. To an `idle` or `interrupted` agent, it queues a `start` with `text` as its first message, resuming its last conversation if it has had one. 202 means queued, not delivered.

### Request syntax

```http
POST /agents/{id}/messages HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "text": "string",
   "interrupt": boolean
}
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Request body

**text**  
Required unless `interrupt` is true.  
Type: String. Length: 1 to 16384. Required: No.

**interrupt**  
`true` stops the current turn before `text` is sent.  
Type: Boolean. Required: No.

### Response syntax

```http
HTTP/1.1 202
Content-type: application/json

{
   "commandId": "string"
}
```

### Response elements

**commandId**  
Follow it in `ListCommands`. Null when nothing was sent to the host.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ConflictException**  
Nothing was queued: the agent is retired, has no session to interrupt, or its host is `lost` or full.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## StopAgent

Queues a `stop`; the session ends and the agent is `idle` once its host reports doing it. When its host is `lost` or deregistered, and so cannot be told, or with `force: true`, the session is ended and the agent `idle` at once, and everything queued for it but `create` is withdrawn; nothing is sent. If its host later reports that session still running, it is sent a `stop`. A caller need not send `force`: the service decides it from the host.

### Request syntax

```http
POST /agents/{id}/stop HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "force": boolean
}
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Request body

**force**  
`true` ends it on record without waiting for the host, even one still connected.  
Type: Boolean. Required: No.

### Response syntax

```http
HTTP/1.1 202
Content-type: application/json

{
   "commandId": "string"
}
```

### Response elements

**commandId**  
Follow it in `ListCommands`. Null when nothing was sent to the host.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ConflictException**  
Nothing was queued: the agent has no live session.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## UpdateAgent

A new `name` is taken and the old one freed at once. Only the record changes: its host keeps the folder and session it made under the name it was created with. `title` replaces the agent's, or with null clears it, whether or not the agent gave it. `label` likewise.

### Request syntax

```http
PATCH /agents/{id} HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "name": "string",
   "title": "string",
   "label": "string"
}
```

### URI request parameters

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

### Request body

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`. Required: No.

**title**  
What the agent is there to do, in a few words.  
Type: String. Length: 1 to 40. Nullable: Yes. Required: No.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40. Nullable: Yes. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "name": "string",
   "title": "string",
   "label": "string",
   "item": "string",
   "role": "string",
   "tokens": {
      "inputTokens": number,
      "outputTokens": number,
      "cacheCreationInputTokens": number,
      "cacheReadInputTokens": number
   },
   "createdBy": "string",
   "whenDone": "keep | stop | retire",
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "hostId": "string",
   "state": "idle | working | waiting | interrupted | retired",
   "session": {
      "id": "string",
      "startedAt": "string"
   },
   "createdAt": "string",
   "reportedAt": "string",
   "status": "working | idle | waiting | review | done | ",
   "summary": "string",
   "headline": "string",
   "saidAt": "string",
   "activity": {
      "text": "string",
      "at": "string"
   },
   "tasks": number,
   "told": boolean,
   "hostStatus": "connected | disconnected | lost"
}
```

### Response elements

**id**  
Assigned by the service when the agent is created.  
Type: String.

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`.

**title**  
What the agent named itself for its work, with `PutAgentTitle`, or the person with `UpdateAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.  
Type: String. Nullable: Yes.

**label**  
A short tag given when it was made or with `UpdateAgent`, shown beside its name. Null for none.  
Type: String. Nullable: Yes.

**item**  
The work item it was started on, as given when it was made; null for none.  
Type: String. Length: 1 to 64. Nullable: Yes.

**role**  
The role it was made from, as given when it was made; null for one made without.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Nullable: Yes.

**tokens**  
Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.  
Type: [Tokens](#tokens) object.

**createdBy**  
The `claimed-by` header of the `CreateAgent` call that made it, unverified. Null when it had none.  
Type: String. Nullable: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`.

**documents**  
The honed skills each session is given after `workplace/global`, by name.  
Type: Array of strings.

**credentials**  
The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.  
Type: Array of strings. Nullable: Yes.

**hostId**  
The host it lives on.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`.

**state**  
`idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.  
Type: String. Valid values: `idle` | `working` | `waiting` | `interrupted` | `retired`.

**session**  
The live session, or null for none.  
Type: Object. Nullable: Yes.

**createdAt**  
When it was made.  
Type: String.

**reportedAt**  
When its host last reported a change to it; null until its host first reports it.  
Type: String. Nullable: Yes.

**status**  
What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `PutAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `PutAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.  
Type: String. Valid values: `working` | `idle` | `waiting` | `review` | `done` | `null`. Nullable: Yes.

**summary**  
One line it, or approval-service, last said with `PutAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.  
Type: String. Nullable: Yes.

**headline**  
A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.  
Type: String. Nullable: Yes.

**saidAt**  
When `summary` was said; null when there is none.  
Type: String. Nullable: Yes.

**activity**  
What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.  
Type: Object. Nullable: Yes.

**tasks**  
Background tasks and subagents its live session has open, as its host last reported; 0 without one.  
Type: Integer. Range: 0 to any.

**told**  
Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.  
Type: Boolean. Nullable: Yes.

**hostStatus**  
Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.  
Type: String. Valid values: `connected` | `disconnected` | `lost`.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No agent has this id.  
HTTP status: 404

**ConflictException**  
Nothing was queued: the agent is retired, or an agent not retired already has `name`.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## UpdateRole

Takes the stage's admin token. Each field given replaces the role's; one absent is kept. Agents made from it before keep what they were given; those made after get what it names now.

### Request syntax

```http
PATCH /roles/{name} HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "whenDone": "keep | stop | retire",
   "label": "string",
   "description": "string",
   "priority": number,
   "brief": "string"
}
```

### URI request parameters

**name**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: Yes.

### Request body

**documents**  
The honed skills each session of an agent made from it is given after `workplace/global`, by name, in this order.  
Type: Array of strings. At most 8 items. Required: No.

**credentials**  
The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.  
Type: Array of strings. At most 16 items. Nullable: Yes. Required: No.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`. Required: No.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40. Required: No.

**description**  
What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: No.

**priority**  
Of two requests waiting to start, the higher starts first.  
Type: Integer. Range: 0 to 1000. Required: No.

**brief**  
The first message of an agent made from it with no `brief` of its own; null when the caller must give one.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "name": "string",
   "documents": [ "string" ],
   "credentials": [ "string" ],
   "whenDone": "keep | stop | retire",
   "label": "string",
   "description": "string",
   "priority": number,
   "brief": "string",
   "updatedAt": "string"
}
```

### Response elements

**name**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`.

**documents**  
The honed skills each session of an agent made from it is given after `workplace/global`, by name, in this order.  
Type: Array of strings. At most 8 items.

**credentials**  
The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.  
Type: Array of strings. At most 16 items. Nullable: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40.

**description**  
What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.  
Type: String. Length: 1 to 16384. Nullable: Yes.

**priority**  
Of two requests waiting to start, the higher starts first.  
Type: Integer. Range: 0 to 1000.

**brief**  
The first message of an agent made from it with no `brief` of its own; null when the caller must give one.  
Type: String. Length: 1 to 16384. Nullable: Yes.

**updatedAt**  
When it was last written; null for a role as the stage was seeded with it.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation, a credential is not one this stage has, or honed has no skill named in `documents`.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**AccessDeniedException**  
Writing a role takes the stage's admin token.  
HTTP status: 403

**ResourceNotFoundException**  
No role has this name.  
HTTP status: 404

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

## WithdrawRequest

Withdraw a waiting request, so it never starts.

### Request syntax

```http
DELETE /requests/{id} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
Assigned by the service; also the id of the agent it starts.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "role": "string",
   "brief": "string",
   "item": "string",
   "subject": "string",
   "label": "string",
   "labels": [ "string" ],
   "credentials": [ "string" ],
   "requester": "string",
   "state": "waiting | started | withdrawn",
   "why": "string",
   "priority": number,
   "position": number,
   "createdAt": "string",
   "startedAt": "string",
   "agentId": "string",
   "withdrawnAt": "string"
}
```

### Response elements

**id**  
Assigned by the service; also the id of the agent it starts.  
Type: String.

**role**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`.

**brief**  
The first message; null to start on the role's own.  
Type: String. Nullable: Yes.

**item**  
A work-tracker item's id: the epic, story or task the agent was started on. Never changes.  
Type: String. Length: 1 to 64. Nullable: Yes.

**subject**  
What it is for when that is no work item; null for none.  
Type: String. Nullable: Yes.

**label**  
In place of the role's label; null for the role's.  
Type: String. Nullable: Yes.

**labels**  
What the host it is placed on must all carry.  
Type: Array of strings.

**credentials**  
In place of the role's, by name; null for the role's. Never a token.  
Type: Array of strings. Nullable: Yes.

**requester**  
The `claimed-by` header it was made with, unverified; null for none.  
Type: String. Nullable: Yes.

**state**  
`waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.  
Type: String. Valid values: `waiting` | `started` | `withdrawn`.

**why**  
While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.  
Type: String. Nullable: Yes.

**priority**  
Its role's, now.  
Type: Integer. Range: 0 to 1000.

**position**  
Where it stands among those waiting, 1 starting next; null once it is not waiting.  
Type: Integer. Range: 1 to any. Nullable: Yes.

**createdAt**  
When it was asked for.  
Type: String.

**startedAt**  
When its agent was made; null until then.  
Type: String. Nullable: Yes.

**agentId**  
The agent it started; null until it has.  
Type: String. Nullable: Yes.

**withdrawnAt**  
When it was withdrawn; null unless it was.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
Missing or incorrect bearer token.  
HTTP status: 401

**ResourceNotFoundException**  
No request has this id.  
HTTP status: 404

**ConflictException**  
It has started, or was withdrawn already.  
HTTP status: 409

**ServiceUnavailableException**  
No API token is configured.  
HTTP status: 503

---

# Data types

## Accepted

### Contents

**commandId**  
Follow it in `ListCommands`. Null when nothing was sent to the host.  
Type: String. Nullable: Yes. Required: Yes.

## Agent

### Contents

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`. Required: Yes.

**title**  
What the agent named itself for its work, with `PutAgentTitle`, or the person with `UpdateAgent`. Kept across sessions; null until one is given. Unlike `name`, it names nothing on its host.  
Type: String. Nullable: Yes. Required: Yes.

**label**  
A short tag given when it was made or with `UpdateAgent`, shown beside its name. Null for none.  
Type: String. Nullable: Yes. Required: Yes.

**item**  
The work item it was started on, as given when it was made; null for none.  
Type: String. Length: 1 to 64. Nullable: Yes. Required: Yes.

**role**  
The role it was made from, as given when it was made; null for one made without.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Nullable: Yes. Required: Yes.

**tokens**  
Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.  
Type: [Tokens](#tokens) object. Required: Yes.

**createdBy**  
The `claimed-by` header of the `CreateAgent` call that made it, unverified. Null when it had none.  
Type: String. Nullable: Yes. Required: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`. Required: Yes.

**documents**  
The honed skills each session is given after `workplace/global`, by name.  
Type: Array of strings. Required: Yes.

**credentials**  
The services each session is given, by name; null for the stage's defaults. Never a token, nor whether one was the caller's own.  
Type: Array of strings. Nullable: Yes. Required: Yes.

**hostId**  
The host it lives on.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`. Required: Yes.

**state**  
`idle`: has a home and no live session. `working`, `waiting`: a live session, in a turn or between turns, as its host last reported it (`working` too from the moment a `start` or a message is queued). `interrupted`: its session ended without a stop, and it can be resumed. `retired`: no longer on the team; its home folder is kept on the host.  
Type: String. Valid values: `idle` | `working` | `waiting` | `interrupted` | `retired`. Required: Yes.

**session**  
The live session, or null for none.  
Type: Object. Nullable: Yes. Required: Yes.

**createdAt**  
When it was made.  
Type: String. Required: Yes.

**reportedAt**  
When its host last reported a change to it; null until its host first reports it.  
Type: String. Nullable: Yes. Required: Yes.

**status**  
What it is doing, as its host sees its turns and as it last said. `working`: a turn of its, or a background task or subagent it started, is running. `idle`: its session is live and neither is, as after it replied; this never needs the person. `waiting`: it said with `PutAgentStatus` that it needs the person, and stays so until the person messages it (a turn it begins by itself does not end it). `review`: its change is submitted to approval-service, said by the agent or by approval-service, and it waits on the reviewer until the change ships or is sent back. `done`: it finished what it was made for, or its change shipped. `review` and `done` are kept once its session ends, and no turn changes them; only a message from the person, or `PutAgentStatus`, does. Otherwise null without a live session. Only `waiting` should notify the person.  
Type: String. Valid values: `working` | `idle` | `waiting` | `review` | `done` | `null`. Nullable: Yes. Required: Yes.

**summary**  
One line it, or approval-service, last said with `PutAgentStatus`: what it is doing, while `waiting` what it needs from the person. Cleared by a message from the person.  
Type: String. Nullable: Yes. Required: Yes.

**headline**  
A few words said with its `summary` and gone with it, for a list of agents. Null when none was given.  
Type: String. Nullable: Yes. Required: Yes.

**saidAt**  
When `summary` was said; null when there is none.  
Type: String. Nullable: Yes. Required: Yes.

**activity**  
What its latest transcript line says it was doing, and when: a Bash call's description (never its command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by `at` and `saidAt`. Null until it has done something.  
Type: Object. Nullable: Yes. Required: Yes.

**tasks**  
Background tasks and subagents its live session has open, as its host last reported; 0 without one.  
Type: Integer. Range: 0 to any. Required: Yes.

**told**  
Whether its live session's current or last turn began with a message delivered to it (the person's, or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a turn that was told is a reply. Null without a live session, or when its host has not said.  
Type: Boolean. Nullable: Yes. Required: Yes.

**hostStatus**  
Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.  
Type: String. Valid values: `connected` | `disconnected` | `lost`. Required: Yes.

## AgentCommands

### Contents

**commands**  
Its commands, oldest first.  
Type: Array of [SentCommand](#sentcommand) objects. Required: Yes.

## AgentList

### Contents

**agents**  
The agents, oldest first.  
Type: Array of [Agent](#agent) objects. Required: Yes.

## AgentPush

To viewers, whenever an agent changes.

### Contents

**type**  
Which message this is.  
Type: String. Valid values: `agent`. Required: Yes.

**agent**  
Type: [Agent](#agent) object. Required: Yes.

## AgentRename

### Contents

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`. Required: No.

**title**  
What the agent is there to do, in a few words.  
Type: String. Length: 1 to 40. Nullable: Yes. Required: No.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40. Nullable: Yes. Required: No.

## AgentReport

### Contents

**id**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**state**  
`idle`: no session running. `working`: its session is taking a turn (from Claude Code's `system` `init` to its `result`). `waiting`: its session is running and between turns. `interrupted`: a session the service started is not running, and was not stopped (a crash, a restart, or a session it does not know).  
Type: String. Valid values: `idle` | `working` | `waiting` | `interrupted`. Required: Yes.

**sessionId**  
The session running, or null for none.  
Type: String. Nullable: Yes. Required: Yes.

**tasks**  
Background tasks and subagents its session has open, as Claude Code's latest `background_tasks_changed` lists them, whether or not a turn is running; 0 once its session ends. Absent from a host that does not say, read as 0.  
Type: Integer. Range: 0 to 1000. Required: No.

**told**  
Whether the turn running, or the last one, began with a message the host delivered (its echo came back in that turn), rather than by itself, as a turn a background task's end begins does. Absent from a host that does not say, read as unknown.  
Type: Boolean. Required: No.

## AgentRequest

### Contents

**id**  
Assigned by the service; also the id of the agent it starts.  
Type: String. Required: Yes.

**role**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: Yes.

**brief**  
The first message; null to start on the role's own.  
Type: String. Nullable: Yes. Required: Yes.

**item**  
A work-tracker item's id: the epic, story or task the agent was started on. Never changes.  
Type: String. Length: 1 to 64. Nullable: Yes. Required: Yes.

**subject**  
What it is for when that is no work item; null for none.  
Type: String. Nullable: Yes. Required: Yes.

**label**  
In place of the role's label; null for the role's.  
Type: String. Nullable: Yes. Required: Yes.

**labels**  
What the host it is placed on must all carry.  
Type: Array of strings. Required: Yes.

**credentials**  
In place of the role's, by name; null for the role's. Never a token.  
Type: Array of strings. Nullable: Yes. Required: Yes.

**requester**  
The `claimed-by` header it was made with, unverified; null for none.  
Type: String. Nullable: Yes. Required: Yes.

**state**  
`waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start.  
Type: String. Valid values: `waiting` | `started` | `withdrawn`. Required: Yes.

**why**  
While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting.  
Type: String. Nullable: Yes. Required: Yes.

**priority**  
Its role's, now.  
Type: Integer. Range: 0 to 1000. Required: Yes.

**position**  
Where it stands among those waiting, 1 starting next; null once it is not waiting.  
Type: Integer. Range: 1 to any. Nullable: Yes. Required: Yes.

**createdAt**  
When it was asked for.  
Type: String. Required: Yes.

**startedAt**  
When its agent was made; null until then.  
Type: String. Nullable: Yes. Required: Yes.

**agentId**  
The agent it started; null until it has.  
Type: String. Nullable: Yes. Required: Yes.

**withdrawnAt**  
When it was withdrawn; null unless it was.  
Type: String. Nullable: Yes. Required: Yes.

## AgentRequestList

### Contents

**requests**  
The requests: the waiting in start order, then the rest newest first.  
Type: Array of [AgentRequest](#agentrequest) objects. Required: Yes.

## AgentStatus

### Contents

**status**  
`working` or `waiting` (on the person) while its session is live; `review` once its change is submitted, `done` once it has finished.  
Type: String. Valid values: `working` | `waiting` | `review` | `done`. Required: Yes.

**summary**  
One line: what it is doing, while `waiting` what it needs from the person, in `review` what it submitted, or when `done` the result.  
Type: String. Length: 1 to 280. Required: Yes.

**headline**  
The summary in a few words a person can scan in a list, e.g. "Needs merge OK". Omitted, it is null.  
Type: String. Length: 1 to 29. Required: No.

## AgentTitle

### Contents

**title**  
What the agent is there to do, in a few words.  
Type: String. Length: 1 to 40. Required: Yes.

## Command

### Contents

## CommandPush

To every socket of the command's host, the moment it is queued; and to a host's socket once it is open, every command still pending for that host, oldest first. That replay follows the first message the host sends on it (its full report on connecting), and leaves out commands that message reports. A command is pending until a report names it, or until it is withdrawn; a host may see one more than once, and knows it by `id`.

### Contents

**type**  
Which message this is.  
Type: String. Valid values: `command`. Required: Yes.

**command**  
Type: [Command](#command) object. Required: Yes.

## CommandReport

### Contents

**commandId**  
The command reported on, by its `id`.  
Type: String. Length: 1 to 128. Required: Yes.

**ok**  
False when the host could not do the command.  
Type: Boolean. Required: Yes.

**error**  
Why not, when `ok` is false, in the host's words.  
Type: String. Length: 0 to 4096. Required: No.

**taken**  
`false` with `ok` true: a command with text, written to its agent's session but not yet taken by it. The command is off the queue (`written`), and its host reports it once more, `ok` true once the session takes it, false if it never will. Absent or true: settled.  
Type: Boolean. Required: No.

## CreateCommand

Make the agent's home folder.

### Contents

**id**  
Report the command by this id once it is taken.  
Type: String. Length: 1 to 128. Required: Yes.

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**kind**  
Which command this is.  
Type: String. Valid values: `create`. Required: Yes.

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`. Required: Yes.

## Cursor

Pass as `after` to read what follows. Unchanged when nothing does yet.

### Contents

## Error

Every error's body.

### Contents

**code**  
Exception name.  
Type: String. Valid values: `ValidationException` | `UnauthorizedException` | `AccessDeniedException` | `ResourceNotFoundException` | `ConflictException` | `InternalServerException` | `ServiceUnavailableException`. Required: Yes.

**message**  
What went wrong.  
Type: String. Required: Yes.

## Heartbeat

### Contents

**version**  
The agent-host build that sent the heartbeat.  
Type: String. Length: 0 to 64. Required: Yes.

**labels**  
What the host offers, as its owner configured it. A full snapshot; absent, the host's last labels stand (none for a new host).  
Type: Array of strings. At most 64 items. Required: No.

**capacity**  
How many sessions the host will run at once. Absent, capacity is unknown.  
Type: Integer. Range: 0 to 256. Required: No.

## Host

### Contents

**id**  
As the host names itself.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`. Required: Yes.

**heartbeatAt**  
When its last heartbeat came.  
Type: String. Required: Yes.

**version**  
The agent-host build of its last heartbeat.  
Type: String. Nullable: Yes. Required: Yes.

**status**  
Computed from `heartbeatAt` when the response was made, never stored. `connected`: silent at most 60 seconds. `disconnected`: at most 300. `lost`: longer.  
Type: String. Valid values: `connected` | `disconnected` | `lost`. Required: Yes.

**labels**  
As the host last declared them.  
Type: Array of strings. Required: Yes.

**capacity**  
How many sessions the host will run at once; null if it has never said.  
Type: Integer. Range: 0 to 256. Nullable: Yes. Required: Yes.

**available**  
How many more sessions it will take now: `capacity` minus its agents with a live session. Null when `capacity` is.  
Type: Integer. Range: 0 to 256. Nullable: Yes. Required: Yes.

## HostList

### Contents

**hosts**  
The hosts.  
Type: Array of [Host](#host) objects. Required: Yes.

## HostPush

To viewers, on every heartbeat.

### Contents

**type**  
Which message this is.  
Type: String. Valid values: `host`. Required: Yes.

**host**  
Type: [Host](#host) object. Required: Yes.

## InterruptCommand

### Contents

**id**  
Report the command by this id once it is taken.  
Type: String. Length: 1 to 128. Required: Yes.

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**kind**  
Which command this is.  
Type: String. Valid values: `interrupt`. Required: Yes.

**text**  
Sent to the agent once the current turn has stopped.  
Type: String. Length: 1 to 16384. Required: No.

## LineReport

### Contents

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**sessionId**  
Assigned by the service when it queues the session's `start`.  
Type: String. Required: Yes.

**seq**  
Deduplicated by (`agentId`, `seq`), so resending is safe.  
Type: Integer. Range: 0 to any. Required: Yes.

**at**  
When it was said.  
Type: String. Required: Yes.

**from**  
`instruction`: a message sent to the agent.  
Type: String. Valid values: `agent` | `tool` | `instruction`. Required: Yes.

**text**  
Kept whole up to 65536 characters, and past that cut rather than refused, so the rest of its report is not lost with it. A text cut short, by its host to fit a socket message or here, ends `… [cut: N of M characters]`: N kept of the M there were.  
Type: String. Required: Yes.

**commandId**  
On an `instruction` line that is a command's text as the session took it (a `message`, a `start`'s first message, an `interrupt`'s text): that command's id. Absent on any other line.  
Type: String. Length: 1 to 128. Required: No.

## LinesPush

To viewers, as lines arrive.

### Contents

**type**  
Which message this is.  
Type: String. Valid values: `lines`. Required: Yes.

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**lines**  
New lines, oldest first.  
Type: Array of [TranscriptLine](#transcriptline) objects. Required: Yes.

## Message

### Contents

**text**  
Required unless `interrupt` is true.  
Type: String. Length: 1 to 16384. Required: No.

**interrupt**  
`true` stops the current turn before `text` is sent.  
Type: Boolean. Required: No.

## MessageCommand

Deliver `text` at the session's next turn.

### Contents

**id**  
Report the command by this id once it is taken.  
Type: String. Length: 1 to 128. Required: Yes.

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**kind**  
Which command this is.  
Type: String. Valid values: `message`. Required: Yes.

**text**  
Delivered to the agent at its session's next turn.  
Type: String. Length: 1 to 16384. Required: Yes.

## NewAgent

### Contents

**name**  
Unique among agents not retired. Names its home folder and tmux session on its host.  
Type: String. Pattern: `^[a-z0-9][a-z0-9-]{0,39}$`. Required: Yes.

**role**  
The role it is made from (`ListRoles`): its `documents`, `credentials`, `whenDone`, `label` and `brief` are the agent's, each unless given here, which overrides the role's. A role this stage does not have is refused.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: No.

**hostId**  
Where it lives. Absent, the service places it on a `connected` host with room (`available` above 0), the one with the most first, carrying every one of `labels`.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`. Required: No.

**labels**  
Without `hostId`, what the host it is placed on must all carry.  
Type: Array of strings. At most 64 items. Required: No.

**brief**  
The first session's first message. Absent, the role's, if it has one; otherwise no session starts.  
Type: String. Length: 1 to 16384. Required: No.

**label**  
Absent, the role's, or without one none.  
Type: String. Length: 1 to 40. Required: No.

**item**  
The work item it is started on, kept for its life so `ListAgents` with `item` finds it. Absent, none.  
Type: String. Length: 1 to 64. Required: No.

**whenDone**  
Absent, the role's, or without one `keep`.  
Type: String. Valid values: `keep` | `stop` | `retire`. Required: No.

**credentials**  
The services each session is given an address and token for, by name: `agent-service` and each its services file names, such as `waypoint` and `honed`. A name it does not have is refused. Absent, the role's, or without one all of them. Only the names are kept on record; each token is read at each start. `{name, token}` gives this agent the caller's token in place of the name's shared one: kept apart from its record, never returned by any read, and deleted when the agent is retired.  
Type: Array of strings. At most 16 items. Required: No.

**documents**  
Given after `workplace/global` at each start, at their current version. A skill honed does not have is refused here. Absent, the role's, or without one only `workplace/global`.  
Type: Array of strings. At most 8 items. Required: No.

## NewAgentRequest

### Contents

**role**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: Yes.

**brief**  
The first message. Absent, the role's own; a role without one needs it.  
Type: String. Length: 1 to 16384. Required: No.

**item**  
A work-tracker item's id: the epic, story or task the agent was started on. Never changes.  
Type: String. Length: 1 to 64. Required: No.

**subject**  
What it is for when that is no work item, such as `PR #41` or `judgment 3f…`: shown, never read.  
Type: String. Length: 1 to 200. Required: No.

**label**  
Absent, the role's.  
Type: String. Length: 1 to 40. Required: No.

**labels**  
What the host it is placed on must all carry. Absent, none.  
Type: Array of strings. At most 64 items. Required: No.

**credentials**  
In place of the role's, as `CreateAgent` takes them; a `{name, token}` is kept for the agent it starts from now, and deleted if it is withdrawn.  
Type: Array of strings. At most 16 items. Required: No.

**tokens**  
Tokens of the caller's, each given the agent in place of that service's shared secret, for services it is given anyway: its role's, or `credentials`. The agent keeps its role's services, so a caller with a token of its own for one need not name them all. Kept as `credentials`' are; refused for a service the agent would not be given, or one `credentials` gives a token for.  
Type: Array of Object. At most 16 items. Required: No.

## NewRole

### Contents

**name**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: Yes.

**documents**  
Absent, only `workplace/global`.  
Type: Array of strings. At most 8 items. Required: No.

**credentials**  
Absent, null: the stage's defaults.  
Type: Array of strings. At most 16 items. Nullable: Yes. Required: No.

**whenDone**  
Absent, `keep`.  
Type: String. Valid values: `keep` | `stop` | `retire`. Required: No.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40. Required: Yes.

**description**  
Absent, null.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: No.

**priority**  
Absent, 0.  
Type: Integer. Range: 0 to 1000. Required: No.

**brief**  
Absent, null.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: No.

## RetireCommand

Stop any session and take the agent off the host. Its home folder is kept.

### Contents

**id**  
Report the command by this id once it is taken.  
Type: String. Length: 1 to 128. Required: Yes.

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**kind**  
Which command this is.  
Type: String. Valid values: `retire`. Required: Yes.

## Role

### Contents

**name**  
A role's name, such as `reviewer`: what kind of agent it makes.  
Type: String. Pattern: `^[a-z][a-z0-9-]{0,39}$`. Required: Yes.

**documents**  
The honed skills each session of an agent made from it is given after `workplace/global`, by name, in this order.  
Type: Array of strings. At most 8 items. Required: Yes.

**credentials**  
The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.  
Type: Array of strings. At most 16 items. Nullable: Yes. Required: Yes.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`. Required: Yes.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40. Required: Yes.

**description**  
What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: Yes.

**priority**  
Of two requests waiting to start, the higher starts first.  
Type: Integer. Range: 0 to 1000. Required: Yes.

**brief**  
The first message of an agent made from it with no `brief` of its own; null when the caller must give one.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: Yes.

**updatedAt**  
When it was last written; null for a role as the stage was seeded with it.  
Type: String. Nullable: Yes. Required: Yes.

## RoleChange

### Contents

**documents**  
The honed skills each session of an agent made from it is given after `workplace/global`, by name, in this order.  
Type: Array of strings. At most 8 items. Required: No.

**credentials**  
The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`.  
Type: Array of strings. At most 16 items. Nullable: Yes. Required: No.

**whenDone**  
What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again.  
Type: String. Valid values: `keep` | `stop` | `retire`. Required: No.

**label**  
A short tag shown beside the agent's name, so sessions can be told apart.  
Type: String. Length: 1 to 40. Required: No.

**description**  
What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: No.

**priority**  
Of two requests waiting to start, the higher starts first.  
Type: Integer. Range: 0 to 1000. Required: No.

**brief**  
The first message of an agent made from it with no `brief` of its own; null when the caller must give one.  
Type: String. Length: 1 to 16384. Nullable: Yes. Required: No.

## RoleList

### Contents

**roles**  
Every role, highest `priority` first.  
Type: Array of [Role](#role) objects. Required: Yes.

## SentCommand

### Contents

**command**  
Type: [Command](#command) object. Required: Yes.

**queuedAt**  
When it was queued for its host.  
Type: String. Required: Yes.

**delivery**  
`queued`: not yet reported by the host. `written`: its text is in the agent's session, which has not yet taken it (it takes it at its next step); a session that ends first makes it `rejected`. `withdrawn`: never to be sent, because it went unreported for 300 seconds (`create` and `retire` excepted) or its agent was force-stopped. `done` / `rejected`: the host reported it, done (a text: taken) or not.  
Type: String. Valid values: `queued` | `written` | `withdrawn` | `done` | `rejected`. Required: Yes.

**reportedAt**  
When the host last reported it; null until then.  
Type: String. Nullable: Yes. Required: Yes.

**error**  
The host's words when it could not do the command; null otherwise.  
Type: String. Nullable: Yes. Required: Yes.

## SentPush

To viewers, when a command carrying `text` (a `message`, a `start` or an `interrupt`) is queued, and each time its `delivery` changes, but for a time-based `withdrawn`, which a read of `ListCommands` says.

### Contents

**type**  
Which message this is.  
Type: String. Valid values: `sent`. Required: Yes.

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**sent**  
Type: [SentCommand](#sentcommand) object. Required: Yes.

## Session

### Contents

**id**  
Assigned by the service when it queues the session's `start`.  
Type: String. Required: Yes.

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**startedAt**  
When its `start` was queued.  
Type: String. Required: Yes.

**endedAt**  
When it ended; null while it is live.  
Type: String. Nullable: Yes. Required: Yes.

**ended**  
`stopped`: told to stop, or its host ended it cleanly. `interrupted`: it died. Null while live.  
Type: String. Valid values: `stopped` | `interrupted` | `null`. Nullable: Yes. Required: Yes.

**context**  
The `workplace/global` it started with, from honed; null when it was given none.  
Type: Object. Nullable: Yes. Required: Yes.

**documents**  
The documents it started with beside `context`, in order.  
Type: Array of Object. Required: Yes.

**skills**  
The clients it started with, each read from its service's `GET /skill` for this stage and written over `context`'s files at the same paths.  
Type: Array of Object. Required: Yes.

**contextNote**  
Why it was given no context, or why a document it was made with, or a service's skill, was left out.  
Type: String. Nullable: Yes. Required: Yes.

## SessionContext

### Contents

**context**  
Written as a start's `context` is; null when there is none to give.  
Type: Object. Nullable: Yes. Required: Yes.

**documents**  
Written after it, as a start's `documents` are.  
Type: Array of Object. Required: Yes.

## SessionList

### Contents

**sessions**  
Its sessions, oldest first.  
Type: Array of [Session](#session) objects. Required: Yes.

## SessionTokensReport

A session's running total of tokens so far, not what was used since the last report. The service keeps the highest of each count reported for the session, so a total sent again, or late, never adds twice.

### Contents

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**sessionId**  
Assigned by the service when it queues the session's `start`.  
Type: String. Required: Yes.

**inputTokens**  
Input tokens not read from or written to the prompt cache.  
Type: Integer. Range: 0 to 9007199254740991. Required: Yes.

**outputTokens**  
Output tokens.  
Type: Integer. Range: 0 to 9007199254740991. Required: Yes.

**cacheCreationInputTokens**  
Input tokens written to the prompt cache.  
Type: Integer. Range: 0 to 9007199254740991. Required: Yes.

**cacheReadInputTokens**  
Input tokens read from the prompt cache.  
Type: Integer. Range: 0 to 9007199254740991. Required: Yes.

## Skill

### Contents

**key**  
Whose skills these are: `agent-service`.  
Type: String. Required: Yes.

**version**  
The deployed tree's commit count, 0 when deployed from outside git.  
Type: Integer. Required: Yes.

**commit**  
The deployed commit, ending `-dirty` when deployed with uncommitted changes.  
Type: String. Required: Yes.

**files**  
Every file, as each session is given them.  
Type: Array of Object. Required: Yes.

## SocketError

To the socket whose message could not be handled, saying why.

### Contents

**type**  
Which message this is.  
Type: String. Valid values: `error`. Required: Yes.

**error**  
Why the message up was refused.  
Type: String. Required: Yes.

## SocketInbound

### Contents

## SocketOutbound

### Contents

## SocketPing

Either side's keep-alive, beside the server's WebSocket pings, which close a socket that misses one.

### Contents

**type**  
Which message this is.  
Type: String. Valid values: `ping`. Required: Yes.

## SocketReport

Host to service, the only way a host reports: whenever something changes, and in full (every agent, every line and result not yet sent) whenever its socket connects. Pushed on to viewers. Idempotent: lines by (`agentId`, `seq`), results by `commandId`. Does not count as a heartbeat. A socket message is at most 128 KB, sent in frames of 32 KB at most, so lines that would not fit go in the reports after it.

### Contents

**type**  
Which message this is.  
Type: String. Valid values: `report`. Required: Yes.

**agents**  
Agents on the host and what each is doing. One not named is unchanged.  
Type: Array of [AgentReport](#agentreport) objects. At most 256 items. Required: No.

**lines**  
Transcript lines not yet sent on a socket that took them.  
Type: Array of [LineReport](#linereport) objects. At most 1000 items. Required: No.

**commandResults**  
One per command taken since it was last reported. A reported command is delivered, and is neither pushed again nor replayed to a socket that connects.  
Type: Array of [CommandReport](#commandreport) objects. At most 1000 items. Required: No.

**tokens**  
Running token totals of sessions whose count has grown since it was last reported.  
Type: Array of [SessionTokensReport](#sessiontokensreport) objects. At most 256 items. Required: No.

**usage**  
The account's usage, when a session's stream has said it since the last report.  
Type: [UsageReport](#usagereport) object. Required: No.

## SocketTicket

### Contents

**ticket**  
Pass as `?ticket=` on the socket; good once.  
Type: String. Required: Yes.

**socketUrl**  
The socket's address.  
Type: String. Required: Yes.

**expiresAt**  
When it is no longer good.  
Type: String. Required: Yes.

## StartCommand

### Contents

**id**  
Report the command by this id once it is taken.  
Type: String. Length: 1 to 128. Required: Yes.

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**kind**  
Which command this is.  
Type: String. Valid values: `start`. Required: Yes.

**sessionId**  
Assigned by the service when it queues the session's `start`.  
Type: String. Required: Yes.

**resume**  
True to carry on the agent's last conversation (`--continue`), false to begin one.  
Type: Boolean. Required: Yes.

**text**  
The session's first message, when it has one.  
Type: String. Length: 1 to 16384. Required: No.

**context**  
Files to write into the agent's own Claude Code folder before it starts, replacing the last context's: `skills/...` as files, and a `CLAUDE.md` after the host's own rules. Absent, the last context and documents written stand.  
Type: Object. Required: No.

**documents**  
Written after `context`, as it is, each with its own files and its `CLAUDE.md` after the one before; they replace the last start's. No two write the same file under `skills/`. Only with a `context`; absent with one, there are none.  
Type: Array of Object. Required: No.

**contextUrl**  
Present when the whole context is too large for a socket message: the path of `GetSessionContext` for this session. A host reads it, with the stage's token, and writes what it answers in place of `context` and `documents`, which then hold only what fitted. A host that cannot read it writes them.  
Type: String. Required: No.

**env**  
Set in the session's environment: the addresses of the services it is given. Never a secret.  
Type: Object. Required: No.

**credentials**  
The services the session is given, by name, as kept on record. Their tokens are in `secrets`.  
Type: Array of strings. At most 16 items. Required: No.

**ownCredentials**  
Of `credentials`, those the agent was given a token of its own for, read in place of the shared one.  
Type: Array of strings. At most 16 items. Required: No.

**secrets**  
The tokens of `credentials`, by variable, read as the command is pushed to the host's socket and never stored, so a listed or replayed command holds none and a rotated secret reaches the next start. The host writes them to a file in the agent's folder that only it can read, and the session's environment is set from that file, never from a command line.  
Type: Object. Required: No.

**mcpServers**  
The MCP servers the session may call, by service, as Claude Code's `mcpServers` takes them: each given service that serves one, its address and token written as `${URL_VAR}` and `${TOKEN_VAR}`, which the session's own environment fills, so the command holds no token. The host passes them to Claude Code with `--mcp-config`.  
Type: Object. Required: No.

## Stop

### Contents

**force**  
`true` ends it on record without waiting for the host, even one still connected.  
Type: Boolean. Required: No.

## StopCommand

End the session; the agent becomes idle.

### Contents

**id**  
Report the command by this id once it is taken.  
Type: String. Length: 1 to 128. Required: Yes.

**agentId**  
Assigned by the service when the agent is created.  
Type: String. Required: Yes.

**kind**  
Which command this is.  
Type: String. Valid values: `stop`. Required: Yes.

## Tokens

Tokens its sessions have used, summed, as its host reported each session's running total; every count 0 until one is reported. A live session's count still grows.

### Contents

**inputTokens**  
Input tokens not read from or written to the prompt cache.  
Type: Integer. Range: 0 to 9007199254740991. Required: Yes.

**outputTokens**  
Output tokens.  
Type: Integer. Range: 0 to 9007199254740991. Required: Yes.

**cacheCreationInputTokens**  
Input tokens written to the prompt cache.  
Type: Integer. Range: 0 to 9007199254740991. Required: Yes.

**cacheReadInputTokens**  
Input tokens read from the prompt cache.  
Type: Integer. Range: 0 to 9007199254740991. Required: Yes.

## Transcript

### Contents

**lines**  
The lines after `after`, oldest first.  
Type: Array of [TranscriptLine](#transcriptline) objects. Required: Yes.

**next**  
Pass as `after` to read what follows. Unchanged when nothing does yet.  
Type: [Cursor](#cursor) object. Length: 1 to 512. Required: Yes.

## TranscriptLine

### Contents

**seq**  
Line number per agent, from 0, continuing across its sessions.  
Type: Integer. Range: 0 to any. Required: Yes.

**at**  
When it was said.  
Type: String. Required: Yes.

**sessionId**  
Assigned by the service when it queues the session's `start`.  
Type: String. Required: Yes.

**from**  
`instruction`: a message sent to the agent.  
Type: String. Valid values: `agent` | `tool` | `instruction`. Required: Yes.

**text**  
Whole up to 65536 characters. A text cut short, by its host to fit a socket message or here, ends `… [cut: N of M characters]`: N kept of the M there were.  
Type: String. Required: Yes.

**commandId**  
On an `instruction` line that is a command's text as the session took it (a `message`, a `start`'s first message, an `interrupt`'s text): that command's id. Absent on any other line.  
Type: String. Length: 1 to 128. Required: No.

## Usage

How much of the Claude account's 5-hour and weekly allowance is used, as last reported.

### Contents

**readAt**  
The newest of the windows' `readAt`; null when nothing has been reported.  
Type: String. Nullable: Yes. Required: Yes.

**fiveHour**  
The 5-hour window's newest reading; null when none has been reported.  
Type: [UsageWindow](#usagewindow) object. Required: Yes.

**sevenDay**  
The weekly window's newest reading; null when none has been reported.  
Type: [UsageWindow](#usagewindow) object. Required: Yes.

## UsagePush

To viewers, when a report brings a newer reading of the account's usage.

### Contents

**type**  
Which message this is.  
Type: String. Valid values: `usage`. Required: Yes.

**usage**  
How much of the Claude account's 5-hour and weekly allowance is used, as last reported.  
Type: [Usage](#usage) object. Required: Yes.

## UsageReport

The account's usage, when a session's stream has said it since the last report.

### Contents

**readAt**  
When the session's stream said it: its `rate_limit_event`'s time.  
Type: String. Required: Yes.

**fiveHour**  
The 5-hour window; absent when the event did not carry it.  
Type: [UsageWindowReport](#usagewindowreport) object. Required: No.

**sevenDay**  
The weekly window; absent when the event did not carry it.  
Type: [UsageWindowReport](#usagewindowreport) object. Required: No.

## UsageWindow

The 5-hour window's newest reading; null when none has been reported.

### Contents

**utilization**  
How much of the window's allowance is used, 0 to 1 (1 is all of it).  
Type: Number. Range: 0 to any. Required: Yes.

**resetsAt**  
When the window starts again from 0. Once past, the reading no longer holds.  
Type: String. Required: Yes.

**readAt**  
When this reading was taken: how stale it is.  
Type: String. Required: Yes.

**hostId**  
The host that reported it.  
Type: String. Pattern: `^[A-Za-z0-9._-]{1,64}$`. Required: Yes.

## UsageWindowReport

The 5-hour window; absent when the event did not carry it.

### Contents

**utilization**  
How much of the window's allowance is used, 0 to 1 (1 is all of it).  
Type: Number. Range: 0 to any. Required: Yes.

**resetsAt**  
When the window starts again from 0.  
Type: String. Required: Yes.

