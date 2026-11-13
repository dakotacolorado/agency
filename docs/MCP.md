# agent-service's MCP server

<!-- Generated from src/mcp.ts by `npm run spec`; do not edit. -->

Streamable HTTP at `/mcp`, stateless, answering JSON. Every request takes the bearer token, as the API does,
and may send `claimed-by`: each tool is one API operation made with them, so it is refused, recorded and
answered as that request would be. A refusal comes back as the tool's error, with the API's status and words.
Each tool is its operation's `operationId` in snake_case, its input the operation's parameters and body.

```json
{
  "mcpServers": {
    "agent-service": {
      "type": "http",
      "url": "http://127.0.0.1:4600/mcp",
      "headers": {
        "Authorization": "Bearer <AUTH_TOKEN>"
      }
    }
  }
}
```

## Instructions

What the server tells an agent when it connects:

> agent-service runs agents: lasting Claude Code agents, each living on one host and run in sessions.
>
> - An agent is made on a host (create_agent), or asked for in a role (create_request), which starts it once Claude usage and a host's room allow.
> - A role names the honed skills each session reads, the services it is given and what becomes of it once done (list_roles).
> - send_message talks to an agent: it starts a session when none is live. stop_agent ends one; resume_agent starts one carrying on the last conversation; retire_agent ends the agent for good.
> - An agent's status is working, idle, waiting (on the person), review or done; put_agent_status is how an agent says it of itself.
> - list_transcript_lines reads what an agent and its tools said, after a cursor: call it again from next.
> - Every tool takes the token this server was connected with, and is refused as the API would refuse it. The host protocol (heartbeats, the socket, a session's context) is the hosts', not tools.

## Tools

| Tool | Does | Reads only |
| --- | --- | --- |
| [`create_agent`](#create_agent) | Create an agent on a host |  |
| [`create_request`](#create_request) | Ask for an agent in a role, to start when usage and a host allow |  |
| [`create_role`](#create_role) | Create a role |  |
| [`delete_host`](#delete_host) | Deregister a host |  |
| [`get_agent`](#get_agent) | Get one agent | yes |
| [`get_request`](#get_request) | Get one request for an agent | yes |
| [`get_role`](#get_role) | Get one role | yes |
| [`get_usage`](#get_usage) | Read how much of the Claude account's 5-hour and weekly allowance is used | yes |
| [`list_agents`](#list_agents) | List agents | yes |
| [`list_commands`](#list_commands) | List the commands sent to an agent, oldest first, with their delivery | yes |
| [`list_hosts`](#list_hosts) | List hosts | yes |
| [`list_requests`](#list_requests) | List requests for agents | yes |
| [`list_roles`](#list_roles) | List roles | yes |
| [`list_sessions`](#list_sessions) | List an agent's sessions, oldest first | yes |
| [`list_transcript_lines`](#list_transcript_lines) | List an agent's transcript lines after a cursor, oldest first, across its sessions | yes |
| [`put_agent_status`](#put_agent_status) | Say whether the agent needs the person, is in review or done, and what on |  |
| [`put_agent_title`](#put_agent_title) | Name the agent for its work, once |  |
| [`resume_agent`](#resume_agent) | Start a session continuing the agent's last conversation |  |
| [`retire_agent`](#retire_agent) | Retire an agent |  |
| [`send_message`](#send_message) | Send an agent a message, or interrupt it |  |
| [`stop_agent`](#stop_agent) | Stop an agent's session, or force it idle |  |
| [`update_agent`](#update_agent) | Rename an agent, or change or clear its title or label |  |
| [`update_role`](#update_role) | Change a role |  |
| [`withdraw_request`](#withdraw_request) | Withdraw a waiting request, so it never starts |  |

### create_agent

Records the agent `idle` and queues `create` for its host, which makes its home. With a `brief`, also queues a `start` whose first message is the brief, and the agent is `working` at once. Without a `hostId`, the service chooses a connected host with room.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `name` | string | yes | Unique among agents not retired. Names its home folder and tmux session on its host. |
| `role` | string |  | The role it is made from (`ListRoles`): its `documents`, `credentials`, `whenDone`, `label` and `brief` are the agent's, each unless given here, which overrides the role's. A role this stage does not have is refused. |
| `hostId` | string |  | Where it lives. Absent, the service places it on a `connected` host with room (`available` above 0), the one with the most first, carrying every one of `labels`. |
| `labels` | string[] |  | Without `hostId`, what the host it is placed on must all carry. |
| `brief` | string |  | The first session's first message. Absent, the role's, if it has one; otherwise no session starts. |
| `label` | string |  | Absent, the role's, or without one none. |
| `item` | string |  | The work item it is started on, kept for its life so `ListAgents` with `item` finds it. Absent, none. |
| `whenDone` | `keep`, `stop`, `retire` |  | Absent, the role's, or without one `keep`. |
| `credentials` | string or object[] |  | The services each session is given an address and token for, by name: `agent-service` and each its services file names, such as `waypoint` and `honed`. A name it does not have is refused. Absent, the role's, or without one all of them. Only the names are kept on record; each token is read at each start. `{name, token}` gives this agent the caller's token in place of the name's shared one: kept apart from its record, never returned by any read, and deleted when the agent is retired. |
| `documents` | string[] |  | Given after `workplace/global` at each start, at their current version. A skill honed does not have is refused here. Absent, the role's, or without one only `workplace/global`. |

### create_request

Records the request `waiting`, then admits what it can at once. A request starts once both usage windows read under 90% (from a reading under 15 minutes old, or one whose window has since reset) and a connected host carrying its `labels` has a free slot; of those waiting, the highest role `priority` first, then the oldest. Admission runs when a request is made and on every host's heartbeat, every 30 seconds while any host is connected, which is when a host's capacity and usage are next known. A reading older than that, of a window not since reset, still admits one request at a time while both windows read under 70%: one starts once none has since that reading, or none in the last 15 minutes, so the agent it starts gives the next reading. Admitted, the agent is made from its role as `CreateAgent` with `role` would, with this request's id as its own and a name of the service's choosing (`<role>-<first 8 of its id>`), placed on a host of the service's choosing; `agentId` names it. A request names no host or agent name.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `role` | string | yes | A role's name, such as `reviewer`: what kind of agent it makes. |
| `brief` | string |  | The first message. Absent, the role's own; a role without one needs it. |
| `item` | string |  | A work-tracker item's id: the epic, story or task the agent was started on. Never changes. |
| `subject` | string |  | What it is for when that is no work item, such as `PR #41` or `judgment 3f…`: shown, never read. |
| `label` | string |  | Absent, the role's. |
| `labels` | string[] |  | What the host it is placed on must all carry. Absent, none. |
| `credentials` | string or object[] |  | In place of the role's, as `CreateAgent` takes them; a `{name, token}` is kept for the agent it starts from now, and deleted if it is withdrawn. |
| `tokens` | object[] |  | Tokens of the caller's, each given the agent in place of that service's shared secret, for services it is given anyway: its role's, or `credentials`. The agent keeps its role's services, so a caller with a token of its own for one need not name them all. Kept as `credentials`' are; refused for a service the agent would not be given, or one `credentials` gives a token for. |

### create_role

Takes the stage's admin token. An agent made from it afterwards gets what it names; one made before keeps what it was given.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `name` | string | yes | A role's name, such as `reviewer`: what kind of agent it makes. |
| `documents` | string[] |  | Absent, only `workplace/global`. |
| `credentials` | string[] or null |  | Absent, null: the stage's defaults. |
| `whenDone` | `keep`, `stop`, `retire` |  | Absent, `keep`. |
| `label` | string | yes | A short tag shown beside the agent's name, so sessions can be told apart. |
| `description` | string or null |  | Absent, null. |
| `priority` | integer |  | Absent, 0. |
| `brief` | string or null |  | Absent, null. |

### delete_host

Deletes the host's record, which is how a host leaves `ListHosts`. Its agents, their transcripts and the commands sent to them stay on record, and its agents read as on a `lost` host. The next heartbeat from this id registers it again, and its socket is sent whatever is still queued for it.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes |  |

### get_agent

Get one agent.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |

### get_request

Get one request for an agent.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service; also the id of the agent it starts. |

### get_role

Get one role.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `name` | string | yes | A role's name, such as `reviewer`: what kind of agent it makes. |

### get_usage

The newest reading of each window any host has reported. A window whose `resetsAt` has passed has since started again from 0; the reading says only what was true at `readAt`. With nothing reported yet, every field is null.

No input.

### list_agents

Retired agents are listed only with `all=true`, or with `item`. With `createdBy`, only the agents made by that `claimed-by`, so a service can list its own. With `item`, only those started on that work item, retired ones included, so what they used is still there once they have gone. With `role`, only those made from that role.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `createdBy` | string |  |  |
| `item` | string |  | A work-tracker item's id: the epic, story or task the agent was started on. Never changes. |
| `role` | string |  | Only the agents made from this role. |
| `all` | `true`, `false` |  | `true` includes retired agents. |

### list_commands

Each is kept 7 days from when it was queued, then deleted.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |

### list_hosts

Every host that has sent a heartbeat since it was last deregistered with `DeleteHost`, however long it has been `lost`. With `status`, only the hosts with one of those statuses.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `status` | string |  | Comma-separated, any of `connected`, `disconnected`, `lost`. |

### list_requests

Those `waiting`, in the order they would start, each with why it waits. With `all=true`, every one, the waiting first in that order and then the rest newest first. A request starts once both usage windows read under 90% (from a reading under 15 minutes old, or one whose window has since reset) and a connected host carrying its `labels` has a free slot; of those waiting, the highest role `priority` first, then the oldest. Admission runs when a request is made and on every host's heartbeat, every 30 seconds while any host is connected, which is when a host's capacity and usage are next known. A reading older than that, of a window not since reset, still admits one request at a time while both windows read under 70%: one starts once none has since that reading, or none in the last 15 minutes, so the agent it starts gives the next reading.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `all` | `true`, `false` |  | `true` includes those started and withdrawn. |
| `requester` | string |  | Only those made with this `claimed-by`. |
| `item` | string |  | Only those for this work item. |

### list_roles

Every role an agent can be made from, highest `priority` first. A stage starts with `planner`, `reviewer`, `conflict`, `investigator`, `judge` and `implementer`, as their callers made them before roles; one written with `CreateRole` or `UpdateRole` is served as written.

No input.

### list_sessions

List an agent's sessions, oldest first.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |

### list_transcript_lines

Poll with the returned `next`, or take `lines` on a socket, to follow it as it grows.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `after` | string |  | The `next` from the previous read. Absent reads from the start. |
| `limit` | integer |  |  |

### put_agent_status

Called by the agent itself, from its `page` skill, and by approval-service for the agent whose change it took or shipped. `waiting` says the agent needs the person; it stands until the person messages it. `working` only says what it is doing: whether it reads `working` or `idle` is its host's turns. `review` says its change is submitted to approval-service and `done` that it finished, or its change shipped; each needs no live session. Not sent to its host. Once the agent is in `review` or `done` and no turn or background task of its runs, `whenDone` is carried out: `stop` stops its session, and `retire` retires it once `done` (in `review` it is stopped, never retired, so a send-back reaches it).

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `status` | `working`, `waiting`, `review`, `done` | yes |  |
| `summary` | string | yes | One line: what it is doing, while `waiting` what it needs from the person, in `review` what it submitted, or when `done` the result. |
| `headline` | string |  | The summary in a few words a person can scan in a list, e.g. "Needs merge OK". Omitted, it is null. |

### put_agent_title

Called by the agent itself, early in its first session, once it knows what it is there to do. Set once: after that only the person changes it, with `UpdateAgent`.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `title` | string | yes | What the agent is there to do, in a few words. |

### resume_agent

Queues a `start` with `resume: true`, or `false` for an agent that has never had a session.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |

### retire_agent

Records it `retired` at once, ends any session, frees its name, and queues a `stop` if it had a live session and then `retire`, which is offered until its host takes it. Its transcript, sessions and home folder are kept.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |

### send_message

To an agent with a live session, `text` is a `message`, delivered at its next turn; with `interrupt: true` it is an `interrupt`, stopping the current turn first, and with no `text` it only interrupts. To an `idle` or `interrupted` agent, it queues a `start` with `text` as its first message, resuming its last conversation if it has had one. 202 means queued, not delivered.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `text` | string |  | Required unless `interrupt` is true. |
| `interrupt` | boolean |  | `true` stops the current turn before `text` is sent. |

### stop_agent

Queues a `stop`; the session ends and the agent is `idle` once its host reports doing it. When its host is `lost` or deregistered, and so cannot be told, or with `force: true`, the session is ended and the agent `idle` at once, and everything queued for it but `create` is withdrawn; nothing is sent. If its host later reports that session still running, it is sent a `stop`. A caller need not send `force`: the service decides it from the host.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `force` | boolean |  | `true` ends it on record without waiting for the host, even one still connected. |

### update_agent

A new `name` is taken and the old one freed at once. Only the record changes: its host keeps the folder and session it made under the name it was created with. `title` replaces the agent's, or with null clears it, whether or not the agent gave it. `label` likewise.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `name` | string |  | Unique among agents not retired. Names its home folder and tmux session on its host. |
| `title` | string or null |  | What the agent is there to do, in a few words. |
| `label` | string or null |  | A short tag shown beside the agent's name, so sessions can be told apart. |

### update_role

Takes the stage's admin token. Each field given replaces the role's; one absent is kept. Agents made from it before keep what they were given; those made after get what it names now.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `name` | string | yes | A role's name, such as `reviewer`: what kind of agent it makes. |
| `documents` | string[] |  | The honed skills each session of an agent made from it is given after `workplace/global`, by name, in this order. |
| `credentials` | string[] or null |  | The services each session is given, by name; null for the stage's defaults. A caller can still give one of these a token of its own, by naming it in `credentials` as `{name, token}`. |
| `whenDone` | `keep`, `stop`, `retire` |  | What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; `stop`, its session is stopped; `retire`, it is stopped and retired, as by `RetireAgent`. On `review`, `stop` and `retire` both only stop its session, so a send-back can still start it again. |
| `label` | string |  | A short tag shown beside the agent's name, so sessions can be told apart. |
| `description` | string or null |  | What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none. |
| `priority` | integer |  | Of two requests waiting to start, the higher starts first. |
| `brief` | string or null |  | The first message of an agent made from it with no `brief` of its own; null when the caller must give one. |

### withdraw_request

Withdraw a waiting request, so it never starts.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service; also the id of the agent it starts. |
