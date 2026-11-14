# agency's MCP server

<!-- Generated from src/mcp.ts by `npm run spec`; do not edit. -->

agency runs your agents across your computers. Its MCP server is how an agent, or your own Claude Code, starts agents, talks to them and follows what they do, each tool one call of agency's API.

Streamable HTTP at `/mcp`, stateless, answering JSON. Every request takes the bearer token, as the API does,
and may send `claimed-by`: each tool is one API operation made with them, so it is refused, recorded and
answered as that request would be. A refusal comes back as the tool's error, with the API's status and words.
Each tool is its operation's `operationId` in snake_case, its input the operation's parameters and body.

```json
{
  "mcpServers": {
    "agency": {
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

> agency: Agents at your command, across all your computers. It runs lasting Claude Code agents, each living on one host and run in sessions.
>
> - An agent is made on a host (create_agent), or asked for in a role (create_request), which starts it once Claude usage and a host's room allow.
> - A role names the honed skills each session reads, the services it is given and what becomes of it once done (list_roles).
> - send_message talks to an agent: it starts a session carrying on its conversation when none is live. stop_agent ends its live session and keeps it, for send_message to start again. delete_agent ends the agent for good.
> - An agent's status is working, idle, waiting (on the person), review or done; put_agent_status is how an agent says it of itself.
> - list_transcript_lines reads what an agent and its tools said, after a cursor: call it again from next.
> - Every tool takes the token this server was connected with, and is refused as the API would refuse it. The host protocol (heartbeats, the socket, a session's context) is the hosts', not tools.

## Tools

| Tool | Does | Reads only |
| --- | --- | --- |
| [`create_agent`](#create_agent) | Create an agent |  |
| [`create_request`](#create_request) | Create a request |  |
| [`delete_agent`](#delete_agent) | Delete an agent |  |
| [`delete_host`](#delete_host) | Delete a host |  |
| [`get_agent`](#get_agent) | Get an agent | yes |
| [`get_request`](#get_request) | Get a request | yes |
| [`get_role`](#get_role) | Get a role | yes |
| [`get_usage`](#get_usage) | Get usage | yes |
| [`list_agents`](#list_agents) | List agents | yes |
| [`list_hosts`](#list_hosts) | List hosts | yes |
| [`list_requests`](#list_requests) | List requests | yes |
| [`list_roles`](#list_roles) | List roles | yes |
| [`list_transcript_lines`](#list_transcript_lines) | List transcript lines | yes |
| [`put_agent_status`](#put_agent_status) | Put an agent's status |  |
| [`put_agent_title`](#put_agent_title) | Put an agent's title |  |
| [`send_message`](#send_message) | Send a message |  |
| [`stop_agent`](#stop_agent) | Stop an agent |  |
| [`update_agent`](#update_agent) | Update an agent |  |
| [`withdraw_request`](#withdraw_request) | Withdraw a request |  |

### create_agent

Records the agent `idle` and queues `create` for its host, which makes its home. With a `brief`, also queues a `start` whose first message is the brief, and the agent is `working` at once. Without a `hostId`, the service chooses a connected host with room.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `name` | string | yes | Unique among agents not deleted. Names its home folder and tmux session on its host. |
| `role` | string |  | The role it is made from (`ListRoles`): its `skills`, `credentials`, `whenDone`, `label` and `brief` are the agent's, each unless given here, which overrides the role's. A role this stage does not have is refused. |
| `hostId` | string |  | Where it lives. Absent, the service places it on a `connected` host with room (`available` above 0), the one with the most first, carrying every one of `labels`. |
| `labels` | string[] |  | Without `hostId`, what the host it is placed on must all carry. |
| `brief` | string |  | The first session's first message. Absent, the role's, if it has one; otherwise no session starts. |
| `label` | string |  | Absent, the role's, or without one none. |
| `item` | string |  | The work item it is started on, kept for its life so `ListAgents` with `item` finds it. Absent, none. |
| `whenDone` | `keep`, `stop`, `delete` |  | Absent, the role's, or without one `keep`. |
| `credentials` | string[] |  | The services each session is given an address and token for, by name: `agency` (or `agent-service`, its former name) and each its services file names, such as `waypoint` and `honed`. A name it does not have is refused. Absent, the role's, or without one all of them. Only the names are kept on record; each token is read at each start. |
| `skills` | string[] |  | Given at each start, at their current version. A skill honed does not have is refused here. Absent, the role's, or without one none. |

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
| `credentials` | string[] |  | In place of the role's, as `CreateAgent` takes them. |

### delete_agent

Records it `deleted` at once, ends any session, frees its name, and queues a `stop` if it had a live session and then `delete`, which is offered until its host takes it. Its transcript, sessions and home folder are kept.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |

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

Get one role, as `ListRoles` gives it.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `name` | string | yes | A role's name, such as `reviewer`: what kind of agent it makes. |

### get_usage

The newest reading of each window any host has reported. A window whose `resetsAt` has passed has since started again from 0; the reading says only what was true at `readAt`. With nothing reported yet, every field is null.

No input.

### list_agents

Deleted agents are listed only with `all=true`, or with `item`. With `createdBy`, only the agents made by that `claimed-by`, so a service can list its own. With `item`, only those started on that work item, deleted ones included, so what they used is still there once they have gone. With `role`, only those made from that role.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `createdBy` | string |  |  |
| `item` | string |  | A work-tracker item's id: the epic, story or task the agent was started on. Never changes. |
| `role` | string |  | Only the agents made from this role. |
| `all` | `true`, `false` |  | `true` includes deleted agents. |

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

Every role an agent can be made from, highest `priority` first: each skill in honed's `agent-roles/` group, read now, or as last read when honed does not answer. A role is changed in honed, never here.

No input.

### list_transcript_lines

Poll with the returned `next`, or take `lines` on a socket, to follow it as it grows.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `after` | string |  | The `next` from the previous read. Absent reads from the start. |
| `limit` | integer |  |  |

### put_agent_status

Called by the agent itself, from its `page` skill, and by approval-service for the agent whose change it took or shipped. `waiting` says the agent needs the person; it stands until the person messages it. `working` only says what it is doing: whether it reads `working` or `idle` is its host's turns. `review` says its change is submitted to approval-service and `done` that it finished, or its change shipped; each needs no live session. Not sent to its host. Once the agent is in `review` or `done` and no turn or background task of its runs, `whenDone` is carried out: `stop` stops its session, and `delete` deletes it once `done` (in `review` it is stopped, never deleted, so a send-back reaches it).

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `status` | `working`, `waiting`, `review`, `done` | yes | `working` or `waiting` (on the person) while its session is live; `review` once its change is submitted, `done` once it has finished. |
| `summary` | string | yes | One line: what it is doing, while `waiting` what it needs from the person, in `review` what it submitted, or when `done` the result. |
| `headline` | string |  | The summary in a few words a person can scan in a list, e.g. "Needs merge OK". Omitted, it is null. |

### put_agent_title

Called by the agent itself, early in its first session, once it knows what it is there to do. Set once: after that only the person changes it, with `UpdateAgent`.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `title` | string | yes | What the agent is there to do, in a few words. |

### send_message

To an agent with a live session, `text` is a `message`, delivered at its next turn; with `interrupt: true` it is an `interrupt`, stopping the current turn first, and with no `text` it only interrupts. To an `idle` or `interrupted` agent, it queues a `start` with `text` as its first message, resuming its last conversation if it has had one. 202 means queued, not delivered.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `text` | string |  | Required unless `interrupt` is true. |
| `interrupt` | boolean |  | `true` stops the current turn before `text` is sent. |

### stop_agent

Ends the agent's live session and keeps the agent: it is recorded `idle` at once, its session ended `stopped`, and a `stop` is queued to its host. What it said in `review` or `done` is kept, as when any session ends. `SendMessage` starts it again, carrying on its conversation.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |

### update_agent

A new `name` is taken and the old one freed at once. Only the record changes: its host keeps the folder and session it made under the name it was created with. `title` replaces the agent's, or with null clears it, whether or not the agent gave it. `label` likewise.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service when the agent is created. |
| `name` | string |  | Unique among agents not deleted. Names its home folder and tmux session on its host. |
| `title` | string or null |  | What the agent is there to do, in a few words. |
| `label` | string or null |  | A short tag shown beside the agent's name, so sessions can be told apart. |

### withdraw_request

Withdraw a waiting request, so it never starts.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | Assigned by the service; also the id of the agent it starts. |
