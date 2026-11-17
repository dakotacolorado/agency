import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  DELIVERIES,
  HEADLINE_LIMIT,
  HEARTBEAT_INTERVAL,
  HOST_STATUSES,
  LABEL_LIMIT,
  ITEM_LIMIT,
  MAKER_LIMIT,
  KEPT_FOR,
  LINE_LIMIT,
  LOST_AFTER,
  REPORTED_STATES,
  END_REASONS,
  ACTIVITY_LIMIT,
  SAID,
  STATUSES,
  SUMMARY_LIMIT,
  TEXT_LIMIT,
  TITLE_LIMIT,
  WHEN_DONE,
  AGENT_STATES,
  HOST_RUNTIME_LABEL,
  RUNTIMES,
} from "./domain.ts";
import { FRESH_FOR_MS, REQUEST_STATES, STALE_UNDER, USAGE_LIMIT } from "./admission.ts";
import { CAPABILITIES, DEFAULT_CAPABILITIES, DEFAULT_CAPABILITY, EFFORTS } from "./capabilities.ts";

/** Validates every request and generates `openapi.json`, so neither can drift. */

const HostId = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/)
  .openapi({ example: "dakotas-macbook" });

// Ids are left unnamed in the document: a named schema made nullable loses its
// null on the way to openapi 3.1, and a generated client would then never see it.

const AgentId = z
  .uuid()
  .describe("Assigned by the service when the agent is created.")
  .openapi({ example: "3b0f6c1e-9a52-4c1d-8f43-2a6e1c7d9b10" });

const SessionId = z
  .uuid()
  .describe("Assigned by the service when it queues the session's `start`.")
  .openapi({ example: "9d6a1f0e-4b7c-4e21-a3f8-0c5d2e7b4a19" });

const AgentName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
  .describe("Unique among agents not deleted. Names its home folder and tmux session on its host.")
  .openapi({ example: "frontend-1" });

const AgentTitle = z
  .string()
  .trim()
  .min(1)
  .max(TITLE_LIMIT)
  .describe("What the agent is there to do, in a few words.")
  .openapi({ example: "Short status headline" });

/** As honed names its skills: a name, with its group prefix if it has one. */
const SkillName = z
  .string()
  .max(100)
  .regex(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .openapi({ example: "agent-roles/planner" });

const Skills = z
  .array(SkillName)
  .max(8)
  .refine((keys) => new Set(keys).size === keys.length, "Name each skill once.")
  .describe(
    "The honed skills each session is given, by name, at their current version, in this order, " +
      "each laid whole as a Claude Code skill at `skills/<the name's last segment>/`.",
  );

const ContextSchema = z.object({
  key: z.string(),
  version: z.number().int(),
  files: z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() })),
});

const CredentialName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const CredentialNames = z
  .array(CredentialName)
  .max(16)
  .refine((names) => new Set(names).size === names.length, "Name each credential once.")
  .openapi({ example: ["work-tracker", "agency"] });

const Credentials = CredentialNames;

const RUNNING_WHERE =
  "Agents run in containers by default. With `runtime:host` among its `labels`, it runs on the host instead, for host " +
  "work such as installs, `/etc`, podman builds or the host's systemd; a host agent may not have full functionality, " +
  "since the host may lack the tools, logins or environment a container gets. Its `runtime` says which, for its life.";

const Runtime = z
  .enum(RUNTIMES)
  .describe(
    "Where its sessions run. `container`: in a container on its host, with the tools, logins and environment " +
      `agents are given. \`host\`: on the host itself, for host work such as installs, \`/etc\`, podman builds or the ` +
      "host's systemd; a host agent may not have full functionality, since the host may lack the tools, logins or " +
      `environment a container gets. Chosen when it is made, \`host\` when its labels include \`${HOST_RUNTIME_LABEL}\` and ` +
      "otherwise agency's default (`container`, unless `AGENCY_DEFAULT_RUNTIME` says otherwise), and kept for its life. An agent made before runtimes were chosen is `host`.",
  );

const WhenDone = z
  .enum(WHEN_DONE)
  .describe(
    "What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; " +
      "`stop`, its session is stopped; `delete`, it is stopped and deleted, as by `DeleteAgent`. On `review`, " +
      "`stop` and `delete` both only stop its session, so a send-back can still start it again. Whatever it is, " +
      "an agent `done` with no session for longer than agency's `--retire-closed-after` days (14 unless set) is deleted by its hourly sweep.",
  );

const Capability = z
  .number()
  .int()
  .min(1)
  .max(3)
  .describe(
    "How capable a model the agent runs on, 1 to 3, as `ListCapabilities` maps each to a model: 3 is today's default " +
      "and the ceiling, 2 and 1 a step and two down, for easier work. A caller names a capability, never a model, so " +
      "nothing can run an agent above capability 3's model. A number outside 1-3 is refused.",
  )
  .openapi({ example: 2 });

const ModelName = z.string().describe("A Claude model id, as Claude Code's `--model` takes it.").openapi({ example: "claude-sonnet-5-5" });

const Effort = z
  .enum(EFFORTS)
  .describe("Claude Code's `--effort` for the model.");

const ItemId = z
  .string()
  .min(1)
  .max(ITEM_LIMIT)
  .describe("A work-tracker item's id: the epic, story or task the agent was started on. Never changes.")
  .openapi({ example: "ca147da6-9a30-4d59-b508-e404d21b9dfd" });

const AgentLabel = z
  .string()
  .trim()
  .min(1)
  .max(LABEL_LIMIT)
  .describe("A short tag shown beside the agent's name, so sessions can be told apart.")
  .openapi({ example: "approval: PR #18" });

const RoleName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/)
  .describe("A role's name, such as `reviewer`: what kind of agent it makes.")
  .openapi({ example: "reviewer" });

/** Hono reads headers lower-cased, so the key must be too. */
const ClaimHeader = z.object({
  "claimed-by": z
    .string()
    .trim()
    .min(1)
    .max(MAKER_LIMIT)
    .optional()
    .describe(
      "Who is making the agent: a person's name, or a service's own, such as `approval-service`. Recorded " +
        "as `createdBy`, as said and not checked, since every caller holds the same token.",
    ),
});

/**
 * Opaque: carried to the host as it came, and never read, trimmed or filled
 * in here. What an agent should be told is for whoever tells it.
 */
const Text = z
  .string()
  .min(1)
  .max(TEXT_LIMIT, {
    error: `A message is at most ${TEXT_LIMIT} characters; this one is longer, and is refused rather than cut.`,
  });

const Cursor = z
  .string()
  .min(1)
  .max(512)
  // A position after an item, not an offset, so items arriving later do not move it.
  .describe("Opaque. A position after the last item read; new items do not shift it.")
  .openapi("Cursor", { example: "c3E9MTI4" });

/** What an agent a usage limit stopped is told once the limit resets. */
export const RESUME_TEXT = "Your usage limit has reset. Carry on from where you were stopped.";

const Instant = z.iso.datetime().openapi({ example: "2026-10-27T12:00:00.000Z" });

const Label = z
  .string()
  .regex(/^[a-z0-9][a-z0-9:._-]{0,63}$/)
  .openapi({ example: "gpu" });

const Labels = z.array(Label).max(64);

const Capacity = z.number().int().min(0).max(256);

const SocketUrl = z
  .string()
  .nullable()
  .describe("The WebSocket API's `wss://` address; null on a server with none, such as `npm run dev`.")
  .openapi({ example: "wss://abc123.execute-api.us-east-1.amazonaws.com/live" });

// --- what a host reports ----------------------------------------------------

const Seq = z
  .number()
  .int()
  .min(0)
  .describe("Line number per agent, from 0, continuing across its sessions.");

const From = z
  .enum(["agent", "tool", "instruction"])
  .describe("`instruction`: a message sent to the agent.");

const CUT =
  "A text cut short, by its host to fit a socket message or here, ends `… [cut: N of M characters]`: " +
  "N kept of the M there were.";

const LineText = z
  .string()
  .describe(`Whole up to ${LINE_LIMIT} characters. ${CUT}`);

const LineCommandId = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe(
    "On an `instruction` line that is a command's text as the session took it (a `message`, a " +
      "`start`'s first message, an `interrupt`'s text): that command's id. Absent on any other line.",
  );

export const TranscriptLineSchema = z
  .object({ seq: Seq, at: Instant.describe("When it was said."), sessionId: SessionId, from: From, text: LineText, commandId: LineCommandId })
  .openapi("TranscriptLine");

export const LineReportSchema = z
  .object({
    agentId: AgentId,
    sessionId: SessionId,
    seq: Seq.describe("Deduplicated by (`agentId`, `seq`), so resending is safe."),
    at: Instant.describe("When it was said."),
    from: From,
    text: z
      .string()
      .describe(
        `Kept whole up to ${LINE_LIMIT} characters, and past that cut rather than refused, so the rest ` +
          `of its report is not lost with it. ${CUT}`,
      ),
    commandId: LineCommandId,
  })
  .openapi("LineReport");

export const AgentReportSchema = z
  .object({
    id: AgentId,
    state: z
      .enum(REPORTED_STATES)
      .describe(
        "`idle`: no session running. `working`: its session is taking a turn (from Claude Code's " +
          "`system` `init` to its `result`). `waiting`: its session is running and between turns. " +
          "`interrupted`: a session the service started is not running, and was not stopped (a " +
          "crash, a restart, or a session it does not know).",
      ),
    sessionId: SessionId.nullable().describe("The session running, or null for none."),
    tasks: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe(
        "Background tasks and subagents its session has open, as Claude Code's latest " +
          "`background_tasks_changed` lists them, whether or not a turn is running; 0 once its " +
          "session ends. Absent from a host that does not say, read as 0.",
      ),
    told: z
      .boolean()
      .optional()
      .describe(
        "Whether the turn running, or the last one, began with a message the host delivered " +
          "(its echo came back in that turn), rather than by itself, as a turn a background task's " +
          "end begins does. Absent from a host that does not say, read as unknown.",
      ),
    limitedUntil: Instant.nullable()
      .optional()
      .describe(
        "When the usage limit that ended its session's last turn resets; null or absent once a turn " +
          "has begun since, or when no limit stopped it. Absent from a host that does not say, read as null.",
      ),
    contextTokens: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        "How large its session's context is: the input, cache read and cache write tokens of the session's last " +
          "request to the model. Absent from a host that does not say, or before the session's first request; the last " +
          "size reported stands.",
      ),
    activeMs: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        "Time its live session has spent in turns so far, in ms: a running total for the session, not since the last report. " +
          "The service keeps the highest reported. Absent from a host that does not say.",
      ),
    turns: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Turns its live session has taken so far, a running total; the service keeps the highest reported. Absent from a host that does not say."),
  })
  .openapi("AgentReport");

const TokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const tokenFields = {
  inputTokens: TokenCount.describe("Input tokens not read from or written to the prompt cache."),
  outputTokens: TokenCount.describe("Output tokens."),
  cacheCreationInputTokens: TokenCount.describe("Input tokens written to the prompt cache."),
  cacheReadInputTokens: TokenCount.describe("Input tokens read from the prompt cache."),
};

export const TokensSchema = z
  .object(tokenFields)
  .describe("Tokens used, in the four counts Claude reports, its subagents' included.")
  .openapi("Tokens");

export const SessionTokensReportSchema = z
  .object({
    agentId: AgentId,
    sessionId: SessionId,
    ...tokenFields,
    byModel: z
      .record(z.string().min(1).max(100), z.object(tokenFields))
      .optional()
      .describe(
        "The same running totals split by the model that spent them, keyed by model id, subagents' on their own models. " +
          "Kept at the highest of each count per model, as the totals are. Absent from a host that does not say; the session's " +
          "tokens are then all counted on the model it started on.",
      ),
  })
  .describe(
    "A session's running total of tokens so far, not what was used since the last report. The service " +
      "keeps the highest of each count reported for the session, so a total sent again, or late, never adds twice.",
  )
  .openapi("SessionTokensReport");

export type SessionTokensReport = z.infer<typeof SessionTokensReportSchema>;

export const CommandReportSchema = z
  .object({
    commandId: z.string().min(1).max(128).describe("The command reported on, by its `id`."),
    ok: z.boolean().describe("False when the host could not do the command."),
    error: z.string().max(4096).optional().describe("Why not, when `ok` is false, in the host's words."),
  })
  .openapi("CommandReport");

const reports = {
  agents: z
    .array(AgentReportSchema)
    .max(256)
    .describe("Agents on the host and what each is doing. One not named is unchanged."),
  lines: z
    .array(LineReportSchema)
    .max(1000)
    .describe("Transcript lines not yet sent on a socket that took them."),
  commandResults: z
    .array(CommandReportSchema)
    .max(1000)
    .describe(
      "One per command taken since it was last reported. A reported command is delivered, and " +
        "is neither pushed again nor replayed to a socket that connects.",
    ),
  tokens: z
    .array(SessionTokensReportSchema)
    .max(256)
    .describe("Running token totals of sessions whose count has grown since it was last reported."),
};

const exampleAgent = "3b0f6c1e-9a52-4c1d-8f43-2a6e1c7d9b10";
const exampleSession = "9d6a1f0e-4b7c-4e21-a3f8-0c5d2e7b4a19";

/** What a host reports, on its socket alone; see `SocketReport`. */
export const ReportSchema = z.object({ ...reports, tokens: reports.tokens.optional() });

export type Report = z.infer<typeof ReportSchema>;

export const HeartbeatSchema = z
  .strictObject({
    type: z.literal("heartbeat").describe("Which message this is."),
    version: z.string().max(64).describe("The agency-host build that sent the heartbeat."),
    labels: Labels.optional().describe(
      "What the host offers, as its owner configured it. A full snapshot; absent, the host's last labels stand (none for a new host).",
    ),
    capacity: Capacity.optional().describe(
      "How many sessions the host will run at once. Absent, capacity is unknown.",
    ),
  })
  .describe(
    "Up a host's socket, after its first full report on connecting and then every 30 seconds: that it is " +
      "there and what it offers. The first from a host id registers it, and only these keep a host `connected`.",
  )
  .openapi("Heartbeat", {
    example: { type: "heartbeat", version: "0.1.0", labels: ["macos", "arm64"], capacity: 4 },
  });

export type Heartbeat = z.infer<typeof HeartbeatSchema>;

// --- what a host is told ----------------------------------------------------

const commandBase = {
  id: z.string().min(1).max(128).describe("Report the command by this id once it is taken."),
  agentId: AgentId,
};

export const CommandSchema = z
  .discriminatedUnion("kind", [
    z
      .object({ ...commandBase, kind: z.literal("create").describe("Which command this is."), name: AgentName })
      .describe("Make the agent's home folder.")
      .openapi("CreateCommand"),
    z
      .object({
        ...commandBase,
        kind: z.literal("start").describe("Which command this is."),
        sessionId: SessionId,
        resume: z
          .boolean()
          .describe("True to carry on the agent's last conversation (`--continue`), false to begin one."),
        runtime: Runtime.describe("Where the host runs the session: `container` in a container, `host` on the host itself, as the agent's `runtime` says."),
        model: ModelName.describe(
          "The model the session runs on (`--model`): its agent's `capability`'s, as `ListCapabilities` maps it at the time " +
            "of the start, a resumed session's too, so an agent whose capability changed while idle resumes on the new model.",
        ),
        effort: Effort.optional().describe(
          "The session's `--effort`, when its capability's entry gives one; absent, Claude Code's default.",
        ),
        text: Text.optional().describe("The session's first message, when it has one."),
        context: ContextSchema.optional().describe(
          "agency's own clients, `page` and `title`, as files to write into the agent's Claude Code " +
            "folder before it starts, under `skills/`, replacing the last start's.",
        ),
        documents: z
          .array(ContextSchema)
          .optional()
          .describe(
            "The honed skills the session is given, each written after `context` under `skills/<its last segment>/`, " +
              "replacing the last start's.",
          ),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Set in the session's environment: the addresses of the services it is given. Never a secret."),
        credentials: CredentialNames.optional().describe(
          "The services the session is given, by name, as kept on record. Their tokens are in `secrets`.",
        ),
        secrets: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "The tokens of `credentials`, by variable, read as the command is pushed to the host's socket and " +
              "never stored, so a listed or replayed command holds none and a rotated secret reaches the next " +
              "start. The host writes them to a file in the agent's folder that only it can read, and the " +
              "session's environment is set from that file, never from a command line.",
          ),
        mcpServers: z
          .record(
            z.string(),
            z.object({ type: z.literal("http"), url: z.string(), headers: z.record(z.string(), z.string()) }),
          )
          .optional()
          .describe(
            "The MCP servers the session may call, by service, as Claude Code's `mcpServers` takes them: each " +
              "given service that serves one, its address and token written as `${URL_VAR}` and `${TOKEN_VAR}`, " +
              "which the session's own environment fills, so the command holds no token, and an `x-actor` header " +
              "with the agent's name, so a service that records who wrote what names the agent. The host passes them " +
              "to Claude Code with `--mcp-config`.",
          ),
      })
      .openapi("StartCommand"),
    z
      .object({ ...commandBase, kind: z.literal("message").describe("Which command this is."), text: Text.describe("Delivered to the agent at its session's next turn.") })
      .describe("Deliver `text` at the session's next turn.")
      .openapi("MessageCommand"),
    z
      .object({
        ...commandBase,
        kind: z.literal("interrupt").describe("Which command this is."),
        text: Text.optional().describe("Sent to the agent once the current turn has stopped."),
      })
      .openapi("InterruptCommand"),
    z
      .object({
        ...commandBase,
        kind: z.literal("configure").describe("Which command this is."),
        model: ModelName.describe("The model the live session runs on from its next request to the model."),
        effort: Effort.nullable().describe("Its `--effort` from then; null for Claude Code's default."),
      })
      .describe(
        "Switch the agent's live session to `model` and `effort`, as the Agent SDK's `applyFlagSettings` does, from its " +
          "next request to the model. Queued by `SetAgentCapability`.",
      )
      .openapi("ConfigureCommand"),
    z
      .object({ ...commandBase, kind: z.literal("stop").describe("Which command this is.") })
      .describe("End the session; the agent becomes idle.")
      .openapi("StopCommand"),
    z
      .object({ ...commandBase, kind: z.literal("delete").describe("Which command this is.") })
      .describe("Stop any session and take the agent off the host. Its home folder is kept.")
      .openapi("DeleteCommand"),
  ])
  .openapi("Command");

export type Command = z.infer<typeof CommandSchema>;


// --- what a client reads ----------------------------------------------------

const HostStatus = z
  .enum(HOST_STATUSES)
  .describe(
    "Computed from `heartbeatAt` when the response was made, never stored. `connected`: silent at " +
      `most ${2 * HEARTBEAT_INTERVAL} seconds. \`disconnected\`: at most ${LOST_AFTER}. \`lost\`: longer.`,
  );

const Dollars = z.number().min(0).describe("US dollars at Anthropic's API list prices, as the capability map's `prices` give them.");

const PriceSchema = z
  .object({
    input: Dollars.describe("Per million input tokens not read from or written to the cache."),
    output: Dollars.describe("Per million output tokens."),
    cacheRead: Dollars.describe("Per million input tokens read from the prompt cache."),
    cacheWrite: Dollars.describe("Per million input tokens written to the prompt cache, at the 1-hour TTL Claude Code uses."),
  })
  .openapi("Price");

const PricesSchema = PriceSchema.extend({
  aboveStep: PriceSchema.nullable().describe(
    "What each token costs once the session's context is past `priceStepAt`; null for a model without a step.",
  ),
}).openapi("Prices");

const COST_NOTE =
  "An estimate at API list prices, from the stage's capability map (`ListCapabilities`): the account may be on a subscription, " +
  "which bills otherwise. agency does not know each request's context size, so a model with a price step is priced above it " +
  "for the whole session once its `peakContextTokens` went past `priceStepAt`, which errs high.";

export const SessionSchema = z
  .object({
    id: SessionId,
    agentId: AgentId,
    agentName: z.string().nullable().describe("Its agent's name as the session started; null on a record whose agent was never on record."),
    role: RoleName.nullable().describe("The role its agent was made from; null for none."),
    item: ItemId.nullable().describe("The work item its agent was started on; null for none."),
    capability: Capability.nullable().describe("Its agent's capability as it started; null on a session from before it was kept."),
    model: ModelName.nullable().describe("The model it started on; null on a session from before it was kept."),
    capabilityChanges: z
      .array(
        z.object({
          at: Instant.describe("When `SetAgentCapability` changed it."),
          from: Capability.describe("The capability before."),
          to: Capability.describe("The capability after."),
        }),
      )
      .describe("Each `SetAgentCapability` while it was live, oldest first."),
    tokens: TokensSchema.describe("Its running total, as its host reported it; on a session from before records kept it, its agent's count."),
    modelsUsed: z
      .array(
        z.object({
          model: ModelName,
          ...tokenFields,
          estimatedCostUsd: Dollars.nullable().describe("What its tokens on this model cost; null for a model with no price."),
        }),
      )
      .describe(
        "Each model's tokens, as its host reported them by model; from a host that reports none by model, all its tokens on " +
          "`model`. Empty on a session from before its model was kept.",
      ),
    estimatedCostUsd: Dollars.nullable().describe(
      `\`modelsUsed\`'s costs summed, those with no price left out. ${COST_NOTE} Null on a session from before its model was kept.`,
    ),
    startedAt: Instant.describe("When its `start` was queued."),
    endedAt: Instant.nullable().describe("When it stopped, finished or died; null while it is live."),
    activeMs: z.number().int().nullable().describe("Time it spent in turns, in ms, as its host reported; null on a session from before it was kept."),
    turns: z.number().int().nullable().describe("Turns it took, as its host reported; null on a session from before it was kept."),
    peakContextTokens: z.number().int().nullable().describe("The largest context its host reported while it was live; null until one is."),
    endReason: z
      .enum(END_REASONS)
      .nullable()
      .describe(
        "`stopped`: told to stop, deleted, or its host ended it cleanly. `interrupted`: it died. `limit`: it ended while a usage " +
          "limit held its agent. Null while live.",
      ),
    skills: z
      .array(
        z.object({
          name: z.string().describe("The honed skill."),
          version: z.number().int().describe("The version it was given."),
        }),
      )
      .describe("The honed skills it started with, in order."),
  })
  .describe("One session of an agent: who ran it on what, what it spent and how long it took. Kept after its agent is deleted.")
  .openapi("Session");

export const AgentSchema = z
  .object({
    id: AgentId,
    name: AgentName,
    title: z
      .string()
      .nullable()
      .describe(
        "What the agent named itself for its work, with `PutAgentTitle`, or the person with " +
          "`UpdateAgent`. Kept across sessions; null until one is given. Unlike `name`, it names " +
          "nothing on its host.",
      ),
    label: z
      .string()
      .nullable()
      .describe("A short tag given when it was made or with `UpdateAgent`, shown beside its name. Null for none."),
    item: ItemId.nullable().describe("The work item it was started on, as given when it was made; null for none."),
    role: RoleName.nullable().describe("The role it was made from, as given when it was made; null for one made without."),
    tokens: TokensSchema.describe(
      "Tokens its sessions have used, summed, as its host reported each session's running total; every count " +
        "0 until one is reported. A live session's count still grows.",
    ),
    createdBy: z
      .string()
      .nullable()
      .describe("The `claimed-by` header of the `CreateAgent` call that made it, unverified. Null when it had none."),
    whenDone: WhenDone,
    runtime: Runtime,
    capability: Capability.describe(
      "How capable a model it runs on, 1 to 3: the one it was made or requested with, else its role's, as " +
        "`SetAgentCapability` last changed it. An agent made before capabilities is 3.",
    ),
    model: ModelName.describe("Its capability's model, as `ListCapabilities` maps it now: what its next start, or a live session told with `configure`, runs on."),
    contextTokens: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        "How large its session's context was at its last request to the model (input plus cache read plus cache write tokens), " +
          "as its host last reported; null until one is reported.",
      ),
    overPriceStep: z
      .boolean()
      .describe(
        "True when `contextTokens` is above its model's `priceStepAt`, past which each token costs more: such a session " +
          "is worth ending or compacting. False otherwise, or when the model has no step.",
      ),
    skills: z.array(z.string()).describe("The honed skills each session is given, by name: its role's own first."),
    credentials: z
      .array(z.string())
      .nullable()
      .describe("The services each session is given, by name; null for every one the stage has. Never a token."),
    hostId: HostId.describe("The host it lives on."),
    state: z
      .enum(AGENT_STATES)
      .describe(
        "`idle`: has a home and no live session. `working`, `waiting`: a live session, " +
          "in a turn or between turns, as its host last reported it (`working` too from the moment a " +
          "`start` or a message is queued). " +
          "`interrupted`: its session ended without a stop, and it can be resumed. `deleted`: " +
          "no longer on the team; its home folder is kept on the host.",
      ),
    session: z
      .object({
        id: SessionId,
        startedAt: Instant,
        skills: z
          .array(z.object({ name: z.string().describe("The honed skill."), version: z.number().int().describe("The version it was given.") }))
          .optional()
          .describe("The honed skills it started with, in order."),
        contextNote: z.string().nullable().optional().describe("Why a skill it was made with was left out, or given from honed's last good copy; null when none was."),
      })
      .nullable()
      .describe("The live session, or null for none: when it started, and what it started with."),
    createdAt: Instant.describe("When it was made."),
    reportedAt: Instant.nullable().describe(
      "When its host last reported a change to it; null until its host first reports it.",
    ),
    status: z
      .enum(STATUSES)
      .nullable()
      .describe(
        "What it is doing, as its host sees its turns and as it last said. `working`: a turn of " +
          "its, or a background task or subagent it started, is running. `idle`: its session is live " +
          "and neither is, as after it replied; this never needs the person. `waiting`: it said with " +
          "`PutAgentStatus` that it needs the person, and stays so until the person messages it " +
          "(a turn it begins by itself does not end it). `review`: its change is submitted to " +
          "approval-service, said by the agent or by approval-service, and it waits on the reviewer " +
          "until the change ships or is sent back. `done`: it finished what it was made for, or its " +
          "change shipped. `review` and `done` are kept once its session ends, and no turn changes " +
          "them; only a message from the person, or `PutAgentStatus`, does. Otherwise null without " +
          "a live session. Only `waiting` should notify the person.",
      ),
    summary: z
      .string()
      .nullable()
      .describe(
        "One line it, or approval-service, last said with `PutAgentStatus`: what it is doing, while " +
          "`waiting` what it needs from the person. Cleared by a message from the person.",
      ),
    headline: z
      .string()
      .nullable()
      .describe("A few words said with its `summary` and gone with it, for a list of agents. Null when none was given."),
    saidAt: Instant.nullable().describe("When `summary` was said; null when there is none."),
    activity: z
      .object({
        text: z.string().max(ACTIVITY_LIMIT),
        at: Instant,
      })
      .nullable()
      .describe(
        "What its latest transcript line says it was doing, and when: a Bash call's description (never its " +
          "command), another tool's name and target (`Edit src/fleet.ts`, `Agent <its description>`), or the " +
          "first line of a reply. Never what the person said. Show whichever of it and `summary` is newer, by " +
          "`at` and `saidAt`. Null until it has done something.",
      ),
    tasks: z
      .number()
      .int()
      .min(0)
      .describe("Background tasks and subagents its live session has open, as its host last reported; 0 without one."),
    told: z
      .boolean()
      .nullable()
      .describe(
        "Whether its live session's current or last turn began with a message delivered to it (the person's, " +
          "or a brief), rather than by itself, as a turn a background task's end begins does; so `idle` after a " +
          "turn that was told is a reply. Null without a live session, or when its host has not said.",
      ),
    limitedUntil: Instant.nullable().describe(
      "When the usage limit that stopped its last turn resets, as its host reported; null when no limit " +
        "stopped it. About a minute after that time, agency sends it `" + RESUME_TEXT + "` as `SendMessage` " +
        "would (a `message` to a live session, else a `start` resuming its last conversation) and clears this, " +
        "so each limit resumes it once. A message sent to it, or a report without it, clears it too.",
    ),
    hostStatus: HostStatus.describe(
      "Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.",
    ),
    currentSession: SessionSchema.nullable().describe("Its live session's record, as `ListSessions` lists it, so far; null without a live session."),
  })
  .openapi("Agent");



export const HostSchema = z
  .object({
    id: HostId.describe("As the host names itself."),
    heartbeatAt: Instant.describe("When its last heartbeat came."),
    version: z.string().nullable().describe("The agency-host build of its last heartbeat."),
    status: HostStatus,
    labels: z.array(Label).describe("As the host last declared them."),
    capacity: Capacity.nullable().describe(
      "How many sessions the host will run at once; null if it has never said.",
    ),
    available: Capacity.nullable().describe(
      "How many more sessions it will take now: `capacity` minus its agents with a live " +
        "session. Null when `capacity` is.",
    ),
  })
  .openapi("Host");

/** Each error status's AWS-style exception name, which an error answers as its `code`. */
export const ERROR_CODES = {
  400: "ValidationException",
  401: "UnauthorizedException",
  403: "AccessDeniedException",
  404: "ResourceNotFoundException",
  409: "ConflictException",
  500: "InternalServerException",
  503: "ServiceUnavailableException",
} as const;

export type ErrorStatus = keyof typeof ERROR_CODES;

export const ErrorSchema = z
  .object({
    code: z.enum(Object.values(ERROR_CODES) as [string, ...string[]]).describe("Exception name."),
    message: z.string().describe("What went wrong."),
  })
  .describe("Every error's body.")
  .openapi("Error");

/** An error answer, described as `<code>: <cause>`, which the reference lists as AWS's do. */
const fails = (status: ErrorStatus, cause: string) => json(ErrorSchema, `${ERROR_CODES[status]}: ${cause}`);

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const FAILS = {
  400: fails(400, "The request failed validation."),
  401: fails(401, "Missing or incorrect bearer token."),
  503: fails(503, "No API token is configured."),
};

const NO_AGENT = { 404: fails(404, "No agent has this id.") };

const NO_HOST = { 404: fails(404, "No host has this id.") };

const REFUSED = (why: string) => ({ 409: fails(409, `Nothing was queued: ${why}`) });

export const AcceptedSchema = z
  .object({
    commandId: z
      .string()
      .nullable()
      .describe("Follow it in `ListCommands`. Null when nothing was sent to the host."),
  })
  .openapi("Accepted");

export const SentCommandSchema = z
  .object({
    command: CommandSchema,
    queuedAt: Instant.describe("When it was queued for its host."),
    delivery: z
      .enum(DELIVERIES)
      .describe(
        "`queued`: not yet reported by the host. `withdrawn`: never to be sent, because it went " +
          `unreported for ${LOST_AFTER} seconds (\`create\` and \`delete\` excepted). ` +
          "`done` / `rejected`: the host reported it, done (a text: delivered to the session) or not.",
      ),
    reportedAt: Instant.nullable().describe("When the host last reported it; null until then."),
    error: z
      .string()
      .nullable()
      .describe("The host's words when it could not do the command; null otherwise."),
  })
  .openapi("SentCommand");

const page = {
  after: Cursor.optional().describe("The `next` from the previous read. Absent reads from the start."),
  limit: z.coerce.number().int().min(1).max(1000).default(500).optional(),
};

// --- the account's usage -----------------------------------------------------

export const USAGE_WINDOWS = ["fiveHour", "sevenDay"] as const;
export type UsageWindowName = (typeof USAGE_WINDOWS)[number];

const Utilization = z
  .number()
  .min(0)
  .describe("How much of the window's allowance is used, 0 to 1 (1 is all of it).")
  .openapi({ example: 0.35 });

const UsageWindowReportSchema = z
  .object({
    utilization: Utilization,
    resetsAt: Instant.describe("When the window starts again from 0."),
  })
  .openapi("UsageWindowReport");

export const UsageReportSchema = z
  .object({
    readAt: Instant.describe("When the session's stream said it: its `rate_limit_event`'s time."),
    fiveHour: UsageWindowReportSchema.optional().describe("The 5-hour window; absent when the event did not carry it."),
    sevenDay: UsageWindowReportSchema.optional().describe("The weekly window; absent when the event did not carry it."),
  })
  .describe(
    "The Claude account's usage, as a session's latest `rate_limit_event` gave it. Every agent " +
      "shares one account, so each window keeps the newest reading by `readAt` from any host, and " +
      "an older one is ignored.",
  )
  .openapi("UsageReport");

export type UsageReport = z.infer<typeof UsageReportSchema>;

const UsageWindowSchema = z
  .object({
    utilization: Utilization,
    resetsAt: Instant.describe("When the window starts again from 0. Once past, the reading no longer holds."),
    readAt: Instant.describe("When this reading was taken: how stale it is."),
    hostId: HostId.describe("The host that reported it."),
  })
  .openapi("UsageWindow");

export type UsageWindow = z.infer<typeof UsageWindowSchema>;

export const UsageSchema = z
  .object({
    readAt: Instant.nullable().describe("The newest of the windows' `readAt`; null when nothing has been reported."),
    fiveHour: UsageWindowSchema.nullable().describe("The 5-hour window's newest reading; null when none has been reported."),
    sevenDay: UsageWindowSchema.nullable().describe("The weekly window's newest reading; null when none has been reported."),
  })
  .describe("How much of the Claude account's 5-hour and weekly allowance is used, as last reported.")
  .openapi("Usage");

export type Usage = z.infer<typeof UsageSchema>;

// --- the sockets ------------------------------------------------------------

export const SocketReportSchema = z
  .object({
    type: z.literal("report").describe("Which message this is."),
    agents: reports.agents.optional(),
    lines: reports.lines.optional(),
    commandResults: reports.commandResults.optional(),
    tokens: reports.tokens.optional(),
    usage: UsageReportSchema.optional().describe(
      "The account's usage, when a session's stream has said it since the last report.",
    ),
  })
  .describe(
    "Host to service, the only way a host reports: whenever something changes, and in full " +
      "(every agent, every line and result not yet sent) whenever its socket connects. Pushed " +
      "on to viewers. Idempotent: lines by (`agentId`, `seq`), results by `commandId`. Does " +
      "not count as a heartbeat. A socket message is at most 128 KB, sent in frames of 32 KB at " +
      "most, so lines that would not fit go in the reports after it.",
  )
  .openapi("SocketReport", {
    example: {
      type: "report",
      agents: [{ id: exampleAgent, state: "working", sessionId: exampleSession, tasks: 1, told: true }],
      lines: [
        {
          agentId: exampleAgent,
          sessionId: exampleSession,
          seq: 41,
          at: "2026-10-27T12:00:00.000Z",
          from: "agent",
          text: "Reading schema.ts.",
        },
      ],
      commandResults: [{ commandId: "cmd-41", ok: true }],
    },
  });

export const SocketPingSchema = z
  .object({ type: z.literal("ping").describe("Which message this is.") })
  .describe("Either side's keep-alive, beside the server's WebSocket pings, which close a socket that misses one.")
  .openapi("SocketPing");

export const SocketInboundSchema = z
  .discriminatedUnion("type", [SocketReportSchema, HeartbeatSchema, SocketPingSchema])
  .openapi("SocketInbound");

export type SocketInbound = z.infer<typeof SocketInboundSchema>;

export const SocketOutboundSchema = z
  .discriminatedUnion("type", [
    z
      .object({ type: z.literal("command").describe("Which message this is."), command: CommandSchema })
      .describe(
        "To every socket of the command's host, the moment it is queued; and to a host's socket " +
          "once it is open, every command still pending for that host, oldest first. That replay " +
          "follows the first message the host sends on it (its full report on connecting), and " +
          "leaves out commands that message reports. A command is pending until a report names it, or until it is " +
          "withdrawn; a host may see one more than once, and knows it by `id`.",
      )
      .openapi("CommandPush"),
    z
      .object({ type: z.literal("agent").describe("Which message this is."), agent: AgentSchema })
      .describe("To viewers, whenever an agent changes.")
      .openapi("AgentPush"),
    z
      .object({ type: z.literal("lines").describe("Which message this is."), agentId: AgentId, lines: z.array(TranscriptLineSchema).describe("New lines, oldest first.") })
      .describe("To viewers, as lines arrive.")
      .openapi("LinesPush"),
    z
      .object({ type: z.literal("sent").describe("Which message this is."), agentId: AgentId, sent: SentCommandSchema })
      .describe(
        "To viewers, when a command carrying `text` (a `message`, a `start` or an `interrupt`) is " +
          "queued, and each time its `delivery` changes, " +
          "but for a time-based `withdrawn`, which a read of `ListCommands` says.",
      )
      .openapi("SentPush"),
    z
      .object({ type: z.literal("host").describe("Which message this is."), host: HostSchema })
      .describe("To viewers, on every heartbeat.")
      .openapi("HostPush"),
    z
      .object({ type: z.literal("usage").describe("Which message this is."), usage: UsageSchema })
      .describe("To viewers, when a report brings a newer reading of the account's usage.")
      .openapi("UsagePush"),
    z
      .object({ type: z.literal("error").describe("Which message this is."), error: z.string().describe("Why the message up was refused.") })
      .describe("To the socket whose message could not be handled, saying why.")
      .openapi("SocketError"),
  ])
  .openapi("SocketOutbound");

export type SocketOutbound = z.infer<typeof SocketOutboundSchema>;

// --- routes -----------------------------------------------------------------

/**
 * Hosts write state and read commands; clients read state and write commands.
 * Every route is made through one of these, which fixes its tag, so the docs
 * group each operation under its audience and `schema.spec.ts` can hold the
 * line between them.
 */
/** The groups the reference sets operations out in, each its resource; the hosts' calls apart. */
export const TAGS = {
  agents: "Agents",
  capabilities: "Capabilities",
  sessions: "Sessions",
  requests: "Requests",
  roles: "Roles",
  hosts: "Hosts",
  usage: "Usage",
  pages: "Pages",
  platform: "Platform",
} as const;

/** The group an operation is in, by the resource its path names. */
const tagOf = (path: string): string => {
  const resource = path.split("/")[1];
  const found: Record<string, string> = {
    agents: TAGS.agents,
    requests: TAGS.requests,
    capabilities: TAGS.capabilities,
    sessions: TAGS.sessions,
    roles: TAGS.roles,
    hosts: TAGS.hosts,
    usage: TAGS.usage,
    "socket-tickets": TAGS.pages,
    skill: TAGS.platform,
  };
  return found[resource ?? ""] ?? TAGS.platform;
};

type Untagged = Omit<RouteConfig, "tags" | "security">;

const secured = { security: [{ bearerAuth: [] }] };

/** Reads nothing but state. */
const forClientReading = <R extends Untagged & { method: "get" }>(route: R) => createRoute({ ...route, ...secured, tags: [tagOf(route.path)] });
const forClientActing = <R extends Untagged & { method: "post" | "put" | "patch" | "delete" }>(route: R) => createRoute({ ...route, ...secured, tags: [tagOf(route.path)] });
/** Called by an agent, from its session, of itself. */
const forAgent = <R extends Untagged & { method: "put" }>(route: R) => createRoute({ ...route, ...secured, tags: [tagOf(route.path)] });

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "GetHealth",
  tags: ["Platform"],
  summary: "Get health",
  description: "Whether it is up, and the version and commit it runs.",
  responses: {
    200: json(
      z.object({
        ok: z.literal(true),
        version: z.string().describe("The package's version."),
        commit: z.string().describe("The commit it was built from, ending `-dirty` when built with uncommitted changes."),
      }),
      "Service is up.",
    ),
  },
});

export const listHostsRoute = forClientReading({
  method: "get",
  path: "/hosts",
  operationId: "ListHosts",
  summary: "List hosts",
  description:
    "Every host that has sent a heartbeat since it was last deregistered with `DeleteHost`, however " +
    "long it has been `lost`. With `status`, only the hosts with one of those statuses.",
  request: {
    query: z.object({
      status: z
        .string()
        .regex(new RegExp(`^(${HOST_STATUSES.join("|")})(,(${HOST_STATUSES.join("|")}))*$`))
        .optional()
        .describe(`Comma-separated, any of ${HOST_STATUSES.map((s) => `\`${s}\``).join(", ")}.`)
        .openapi({ example: "disconnected,lost" }),
    }),
  },
  responses: {
    200: json(z.object({ hosts: z.array(HostSchema).describe("The hosts.") }).openapi("HostList"), "The hosts listed."),
    ...FAILS,
  },
});

export const deleteHostRoute = forClientActing({
  method: "delete",
  path: "/hosts/{id}",
  operationId: "DeleteHost",
  summary: "Delete a host",
  description:
    "Deletes the host's record, which is how a host leaves `ListHosts`. Its agents, their " +
    "transcripts and the commands sent to them stay on record, and its agents read as on a " +
    "`lost` host. The next heartbeat from this id registers it again, and its socket is sent " +
    "whatever is still queued for it.",
  request: { params: z.object({ id: HostId }) },
  responses: { 204: { description: "Deregistered." }, ...NO_HOST, ...FAILS },
});

export const createAgentRoute = forClientActing({
  method: "post",
  path: "/agents",
  operationId: "CreateAgent",
  summary: "Create an agent",
  description:
    "Records the agent `idle` and queues `create` for its host, which makes its home. With a " +
    "`brief`, also queues a `start` whose first message is the brief, and the agent is `working` " +
    "at once. Without a `hostId`, the service chooses a connected host with room. " +
    RUNNING_WHERE,
  request: {
    headers: ClaimHeader,
    body: json(
      z
        .object({
          name: AgentName,
          role: RoleName.optional().describe(
            "The role it is made from (`ListRoles`): its `skills`, `credentials`, `whenDone`, `label` and `brief` " +
              "are the agent's, each unless given here, which overrides the role's. A role this stage does not have is refused.",
          ),
          hostId: HostId.optional().describe(
            "Where it lives. Absent, the service places it on a `connected` host with room (`available` above 0), " +
              "the one with the most first, carrying every one of `labels`.",
          ),
          labels: Labels.optional().describe(
            "Without `hostId`, what the host it is placed on must all carry. With `runtime:host` among them, it runs on the host " +
              "rather than in a container (see `runtime`), with or without `hostId`.",
          ),
          brief: Text.optional().describe("The first session's first message. Absent, the role's, if it has one; otherwise no session starts."),
          label: AgentLabel.optional().describe("Absent, the role's, or without one none."),
          item: ItemId.optional().describe(
            "The work item it is started on, kept for its life so `ListAgents` with `item` finds it. Absent, none.",
          ),
          whenDone: WhenDone.optional().describe("Absent, the role's, or without one `keep`."),
          capability: Capability.optional().describe(
            "How capable a model it runs on, 1 to 3 (`ListCapabilities`). Absent, the role's, or without one 3.",
          ),
          credentials: Credentials.optional().describe(
            "The services each session is given an address and token for, by name: `agency` (or `agent-service`, its former name) and each " +
              "its services file names, such as `waypoint` and `honed`. A name it does not have is refused. " +
              "Absent, the role's, or without one all of them. Only the names are kept on record; each token is read at each start.",
          ),
          skills: Skills.optional().describe(
            "Given at each start, at their current version. A skill honed does not have is refused here. " +
              "Absent, the role's, or without one none.",
          ),
        })
        .openapi("NewAgent"),
      "Who the agent is and where it lives.",
    ),
  },
  responses: {
    201: json(AgentSchema, "Created; its `create` is queued for the host."),
    404: fails(404, "No host has the id `hostId`."),
    ...REFUSED("an agent not deleted already has `name`, the host is `lost`, or it is full and a `brief` was given."),
    ...FAILS,
    503: fails(503, "No API token is configured, or no `hostId` was given and no connected host fits and has room."),
    400: fails(400, "The request failed validation (a `capability` outside 1-3 among it), `role` is not one this stage has, a credential is not one this stage has, or honed has no skill named in `skills`.",
    ),
  },
});

export const listAgentsRoute = forClientReading({
  method: "get",
  path: "/agents",
  operationId: "ListAgents",
  summary: "List agents",
  description:
    "Deleted agents are listed only with `all=true`, or with `item`. With `createdBy`, only the agents " +
    "made by that `claimed-by`, so a service can list its own. With `item`, only those started on that " +
    "work item, deleted ones included, so what they used is still there once they have gone. With `role`, only " +
    "those made from that role.",
  request: {
    query: z.object({
      createdBy: z.string().min(1).max(MAKER_LIMIT).optional(),
      item: ItemId.optional(),
      role: RoleName.optional().describe("Only the agents made from this role."),
      all: z.enum(["true", "false"]).optional().describe("`true` includes deleted agents."),
    }),
  },
  responses: {
    200: json(z.object({ agents: z.array(AgentSchema).describe("The agents, oldest first.") }).openapi("AgentList"), "Matching agents."),
    ...FAILS,
  },
});

export const getAgentRoute = forClientReading({
  method: "get",
  path: "/agents/{id}",
  operationId: "GetAgent",
  summary: "Get an agent",
  description: "Get one agent.",
  request: { params: z.object({ id: AgentId }) },
  responses: { 200: json(AgentSchema, "The agent."), ...NO_AGENT, ...FAILS },
});

const agentParam = { params: z.object({ id: AgentId }) };

export const messageAgentRoute = forClientActing({
  method: "post",
  path: "/agents/{id}/messages",
  operationId: "SendMessage",
  summary: "Send a message",
  description:
    "To an agent with a live session, `text` is a `message`, delivered at its next turn; with " +
    "`interrupt: true` it is an `interrupt`, stopping the current turn first, and with no `text` " +
    "it only interrupts. To an `idle` or `interrupted` agent, it queues a `start` with `text` as " +
    "its first message, resuming its last conversation if it has had one. 202 means queued, not " +
    "delivered.",
  request: {
    ...agentParam,
    body: {
      ...json(
        z
          // Strict, so a misspelt `interrupt` is refused rather than sent as a message.
          .strictObject({
            text: Text.optional().describe("Required unless `interrupt` is true."),
            interrupt: z.boolean().optional().describe("`true` stops the current turn before `text` is sent."),
          })
          .refine((said) => said.interrupt === true || said.text !== undefined, {
            error: "text: required unless interrupt is true.",
          })
          .openapi("Message"),
        "What to tell it.",
      ),
      required: true,
    },
  },
  responses: {
    202: json(AcceptedSchema, "Queued, and not yet delivered."),
    ...NO_AGENT,
    ...REFUSED("the agent is deleted, has no session to interrupt, or its host is `lost` or full."),
    ...FAILS,
  },
});

export const renameAgentRoute = forClientActing({
  method: "patch",
  path: "/agents/{id}",
  operationId: "UpdateAgent",
  summary: "Update an agent",
  description:
    "A new `name` is taken and the old one freed at once. Only the record changes: its host keeps the " +
    "folder and session it made under the name it was created with. `title` replaces the agent's, " +
    "or with null clears it, whether or not the agent gave it. `label` likewise.",
  request: {
    ...agentParam,
    body: json(
      z
        .object({
          name: AgentName.optional(),
          title: AgentTitle.nullable().optional(),
          label: AgentLabel.nullable().optional(),
        })
        .refine(
          (body) => body.name !== undefined || body.title !== undefined || body.label !== undefined,
          "Give a name, a title, a label or any of them.",
        )
        .openapi("AgentRename"),
      "The agent's new name, title or label.",
    ),
  },
  responses: {
    200: json(AgentSchema, "Renamed."),
    ...NO_AGENT,
    ...REFUSED("the agent is deleted, or an agent not deleted already has `name`."),
    ...FAILS,
  },
});

export const deleteAgentRoute = forClientActing({
  method: "delete",
  path: "/agents/{id}",
  operationId: "DeleteAgent",
  summary: "Delete an agent",
  description:
    "Records it `deleted` at once, ends any session, frees its name, and queues a `stop` if it had " +
    "a live session and then `delete`, which is offered until its host takes it. agency keeps its record, " +
    "sessions and transcript. Its host sets its home folder aside, without its credentials, and keeps the " +
    "newest 100 deleted agents' folders, removing older ones. agency's hourly sweep does the same to an agent " +
    "`done` with no session for longer than its `--retire-closed-after` days (14 unless set).",
  request: agentParam,
  responses: {
    202: json(AcceptedSchema, "Deleted; `commandId` is the `delete`'s."),
    ...NO_AGENT,
    ...REFUSED("the agent is deleted already."),
    ...FAILS,
  },
});

export const stopAgentRoute = forClientActing({
  method: "post",
  path: "/agents/{id}/stop",
  operationId: "StopAgent",
  summary: "Stop an agent",
  description:
    "Ends the agent's live session and keeps the agent: it is recorded `idle` at once, its session " +
    "ended `stopped`, and a `stop` is queued to its host. What it said in `review` or `done` is kept, " +
    "as when any session ends. `SendMessage` starts it again, carrying on its conversation.",
  request: agentParam,
  responses: {
    202: json(AcceptedSchema, "Stopped; `commandId` is the `stop`'s."),
    ...NO_AGENT,
    ...REFUSED("the agent is deleted, or has no live session to stop."),
    ...FAILS,
  },
});

export const transcriptRoute = forClientReading({
  method: "get",
  path: "/agents/{id}/transcript",
  operationId: "ListTranscriptLines",
  summary: "List transcript lines",
  description: "Poll with the returned `next`, or take `lines` on a socket, to follow it as it grows.",
  request: { ...agentParam, query: z.object(page) },
  responses: {
    200: json(
      z
        .object({
          lines: z.array(TranscriptLineSchema).describe("The lines after `after`, oldest first."),
          next: Cursor.describe("Pass as `after` to read what follows. Unchanged when nothing does yet."),
        })
        .openapi("Transcript"),
      "Lines after the cursor.",
    ),
    ...NO_AGENT,
    ...FAILS,
  },
});



export const setAgentStatusRoute = forAgent({
  method: "put",
  path: "/agents/{id}/status",
  operationId: "PutAgentStatus",
  summary: "Put an agent's status",
  description:
    "Called by the agent itself, from its `page` skill, and by approval-service for the agent whose change it " +
    "took or shipped. `waiting` says the agent needs the person; it stands until the person messages it. `working` " +
    "only says what it is doing: whether it reads `working` or `idle` is its host's turns. `review` says its change " +
    "is submitted to approval-service and `done` that it finished, or its change shipped; each needs no live session. " +
    "Not sent to its host. Once the agent is in `review` or `done` and no turn or background task of its runs, " +
    "`whenDone` is carried out: `stop` stops its session, and `delete` deletes it once `done` (in `review` it is " +
    "stopped, never deleted, so a send-back reaches it).",
  request: {
    ...agentParam,
    body: json(
      z
        .strictObject({
          status: z.enum(SAID).describe("`working` or `waiting` (on the person) while its session is live; `review` once its change is submitted, `done` once it has finished."),
          summary: z
            .string()
            .trim()
            .min(1)
            .max(SUMMARY_LIMIT)
            .describe(
              "One line: what it is doing, while `waiting` what it needs from the person, in `review` what it submitted, or when `done` the result.",
            ),
          headline: z
            .string()
            .trim()
            .min(1)
            .max(HEADLINE_LIMIT)
            .optional()
            .describe(
              `The summary in a few words a person can scan in a list, e.g. "Needs merge OK". Omitted, it is null.`,
            ),
        })
        .openapi("AgentStatus"),
      "What the agent says of itself.",
    ),
  },
  responses: {
    200: json(AgentSchema, "Recorded."),
    ...NO_AGENT,
    409: fails(409, "The agent is deleted, or has no live session to be `working` or `waiting`."),
    ...FAILS,
  },
});

export const setAgentTitleRoute = forAgent({
  method: "put",
  path: "/agents/{id}/title",
  operationId: "PutAgentTitle",
  summary: "Put an agent's title",
  description:
    "Called by the agent itself, early in its first session, once it knows what it is there to do. " +
    "Set once: after that only the person changes it, with `UpdateAgent`.",
  request: {
    ...agentParam,
    body: json(z.strictObject({ title: AgentTitle }).openapi("AgentTitle"), "What the agent names itself."),
  },
  responses: {
    200: json(AgentSchema, "Recorded."),
    ...NO_AGENT,
    409: fails(409, "The agent is deleted, or has a title already."),
    ...FAILS,
  },
});

export const setAgentCapabilityRoute = forClientActing({
  method: "put",
  path: "/agents/{id}/capability",
  operationId: "SetAgentCapability",
  summary: "Set an agent's capability",
  description:
    "Records the agent's new `capability`, and so its `model`. While it has a live session, queues a `configure` for its " +
    "host with the new model and effort, which the session takes from its next request to the model; otherwise its next " +
    "start, a resumed one too, carries them. Switching models costs one prompt-cache rewrite on the new model: the " +
    "session's whole context is written to the new model's cache at its next request. The same capability changes nothing.",
  request: {
    ...agentParam,
    body: json(z.strictObject({ capability: Capability }).openapi("AgentCapability"), "The agent's new capability."),
  },
  responses: {
    200: json(AgentSchema, "Recorded, and `configure` queued for a live session."),
    ...NO_AGENT,
    ...REFUSED("the agent is deleted, or its host is `lost`."),
    ...FAILS,
  },
});

export const CapabilityEntrySchema = z
  .object({
    capability: Capability,
    model: ModelName.describe("The model an agent at this capability runs on."),
    effort: Effort.nullable().describe("Its `--effort`; null for Claude Code's default, `medium`."),
    priceStepAt: z
      .number()
      .int()
      .nullable()
      .describe("The context size in tokens above which the model's price goes up, as an agent's `overPriceStep` reads it; null for none."),
    prices: PricesSchema.nullable().describe("What its tokens cost, as a session's `estimatedCostUsd` reckons them; null for a model with no price."),
  })
  .openapi("CapabilityModel");

export const listCapabilitiesRoute = forClientReading({
  method: "get",
  path: "/capabilities",
  operationId: "ListCapabilities",
  summary: "List capabilities",
  description:
    "Each capability, 1 to 3, and the model, effort and price step an agent at it runs on, as this stage maps them " +
    `(agency's \`--capabilities\` file). By default: ${CAPABILITIES.map((n) => `${n} \`${DEFAULT_CAPABILITIES[n].model}\``).join(", ")}, ` +
    `each at Claude Code's default effort, and only capability 1's model with a price step, at ${DEFAULT_CAPABILITIES[1].priceStepAt} tokens. ` +
    `${DEFAULT_CAPABILITY} is today's default and the ceiling.`,
  responses: {
    200: json(
      z.object({ capabilities: z.array(CapabilityEntrySchema).describe("Every capability, 1 first.") }).openapi("CapabilityList"),
      "The capabilities.",
    ),
    ...FAILS,
  },
});

export const SESSIONS_PAGE = 100;

export const listSessionsRoute = forClientReading({
  method: "get",
  path: "/sessions",
  operationId: "ListSessions",
  summary: "List sessions",
  description:
    "Every agent's sessions, newest first, kept after their agents are deleted or retired, for an audit of what each " +
    "task, role and model spent. Each filter narrows the list; `since` and `until` bound `startedAt`. Sessions from " +
    "before their records kept it have tokens, agent, role and item only. " +
    COST_NOTE +
    ` A page holds at most \`limit\` (${SESSIONS_PAGE} unless given); pass \`nextToken\` for the next. With \`format=csv\`, every ` +
    "matching session at once as CSV, one row each, for a spreadsheet.",
  request: {
    query: z.object({
      item: ItemId.optional().describe("Only sessions of agents started on this work item."),
      role: RoleName.optional().describe("Only sessions of agents made from this role."),
      agentId: AgentId.optional().describe("Only this agent's sessions."),
      model: ModelName.optional().describe("Only sessions that started on this model or spent tokens on it."),
      since: z
        .union([z.iso.datetime(), z.iso.date()])
        .optional()
        .describe("Only sessions started at or after this instant, or this UTC day's start."),
      until: z
        .union([z.iso.datetime(), z.iso.date()])
        .optional()
        .describe("Only sessions started before this instant, or this UTC day's start."),
      limit: z.coerce.number().int().min(1).max(1000).optional().describe(`At most this many on a page; ${SESSIONS_PAGE} unless given.`),
      nextToken: z.string().max(512).optional().describe("The `nextToken` of the page before."),
      format: z.enum(["json", "csv"]).optional().describe("`csv` for every matching session as CSV; JSON unless given."),
    }),
  },
  responses: {
    200: {
      description: "The sessions.",
      content: {
        "application/json": {
          schema: z
            .object({
              sessions: z.array(SessionSchema).describe("The sessions, newest first."),
              nextToken: z.string().nullable().describe("Pass as `nextToken` for the next page; null on the last."),
            })
            .openapi("SessionList"),
        },
        "text/csv": { schema: z.string().describe("A header row, then one row per session.") },
      },
    },
    ...FAILS,
  },
});

export const getUsageRoute = forClientReading({
  method: "get",
  path: "/usage",
  operationId: "GetUsage",
  summary: "Get usage",
  description:
    "The newest reading of each window any host has reported. A window whose `resetsAt` has " +
    "passed has since started again from 0; the reading says only what was true at `readAt`. " +
    "With nothing reported yet, every field is null.",
  responses: { 200: json(UsageSchema, "The newest reading."), 401: FAILS[401], 503: FAILS[503] },
});

// --- roles ------------------------------------------------------------------

const Priority = z.number().int().min(0).max(1000);

export const RoleSchema = z
  .object({
    name: RoleName,
    skills: z.array(z.string()).describe("The honed skills each session of an agent made from it is given: the role's own, `agent-roles/<name>`, first."),
    credentials: CredentialNames.nullable().describe("The services each session is given, by name; null for every one the stage has."),
    whenDone: WhenDone,
    label: AgentLabel,
    description: Text.nullable().describe("What an agent in it is for and who starts one: markdown, a sentence or two. Null for none."),
    priority: Priority.describe("Of two requests waiting to start, the higher starts first."),
    capability: Capability.describe("The capability an agent made from it runs at when its caller gives none: its `role.json`'s `capability`, 3 when that has none."),
    brief: Text.nullable().describe("The first message of an agent made from it with no `brief` of its own; null when the caller must give one."),
    version: z.number().int().describe("The version of its honed skill it was read at."),
  })
  .describe("A role, as its honed skill `agent-roles/<name>` defines it: its `SKILL.md` is what an agent in it is told, and its `role.json` these settings.")
  .openapi("Role");

const NO_ROLE = { 404: fails(404, "No role has this name.") };

const roleParam = { params: z.object({ name: RoleName }) };

export const listRolesRoute = forClientReading({
  method: "get",
  path: "/roles",
  operationId: "ListRoles",
  summary: "List roles",
  description:
    "Every role an agent can be made from, highest `priority` first: each skill in honed's `agent-roles/` group, read now, " +
    "or as last read when honed does not answer. A role is changed in honed, never here.",
  responses: { 200: json(z.object({ roles: z.array(RoleSchema).describe("Every role, highest `priority` first.") }).openapi("RoleList"), "The roles."), ...FAILS },
});

export const getRoleRoute = forClientReading({
  method: "get",
  path: "/roles/{name}",
  operationId: "GetRole",
  summary: "Get a role",
  description: "Get one role, as `ListRoles` gives it.",
  request: roleParam,
  responses: { 200: json(RoleSchema, "The role."), ...NO_ROLE, ...FAILS },
});

// --- requests ---------------------------------------------------------------

const RequestId = z.uuid().describe("Assigned by the service; also the id of the agent it starts.");

const Subject = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("What it is for when that is no work item, such as `PR #41` or `judgment 3f…`: shown, never read.")
  .openapi({ example: "dakotacolorado/agency#41" });

const ADMISSION =
  `A request starts once both usage windows read under ${USAGE_LIMIT * 100}% (from a reading under ` +
  `${FRESH_FOR_MS / 60_000} minutes old, or one whose window has since reset) and a connected host carrying its ` +
  "`labels` has a free slot; of those waiting, the highest role `priority` first, then the oldest. Admission " +
  "runs when a request is made and on every host's heartbeat, every 30 seconds while any host is connected, which " +
  "is when a host's capacity and usage are next known. A reading older than that, of a window not since reset, " +
  `still admits one request at a time while both windows read under ${Math.round(STALE_UNDER * 100)}%: one starts once none ` +
  `has since that reading, or none in the last ${FRESH_FOR_MS / 60_000} minutes, so the agent it starts gives the next reading.`;

export const RequestSchema = z
  .object({
    id: RequestId,
    role: RoleName,
    brief: z.string().nullable().describe("The first message; null to start on the role's own."),
    item: ItemId.nullable(),
    subject: z.string().nullable().describe("What it is for when that is no work item; null for none."),
    label: z.string().nullable().describe("In place of the role's label; null for the role's."),
    labels: z.array(Label).describe("What the host it is placed on must all carry."),
    credentials: z.array(z.string()).nullable().describe("In place of the role's, by name; null for the role's. Never a token."),
    capability: Capability.nullable().describe("In place of the role's; null for the role's, as it is when the agent is made."),
    requester: z.string().nullable().describe("The `claimed-by` header it was made with, unverified; null for none."),
    state: z
      .enum(REQUEST_STATES)
      .describe("`waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start."),
    why: z.string().nullable().describe("While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting."),
    priority: Priority.describe("Its role's, now."),
    position: z.number().int().min(1).nullable().describe("Where it stands among those waiting, 1 starting next; null once it is not waiting."),
    createdAt: Instant.describe("When it was asked for."),
    startedAt: Instant.nullable().describe("When its agent was made; null until then."),
    agentId: AgentId.nullable().describe("The agent it started; null until it has."),
    withdrawnAt: Instant.nullable().describe("When it was withdrawn; null unless it was."),
  })
  .openapi("AgentRequest");

const NO_REQUEST = { 404: fails(404, "No request has this id.") };

export const createRequestRoute = forClientActing({
  method: "post",
  path: "/requests",
  operationId: "CreateRequest",
  summary: "Create a request",
  description:
    "Records the request `waiting`, then admits what it can at once. " +
    ADMISSION +
    " Admitted, the agent is made from its role as `CreateAgent` with `role` would, with this request's id as its " +
    "own and a name of the service's choosing (`<role>-<first 8 of its id>`), placed on a host of the service's " +
    "choosing; `agentId` names it. A request names no host or agent name. One `item` gets one agent: a request for " +
    "an item that has an agent neither deleted nor `done`, a request waiting, or one started whose agent is still being " +
    "made, is refused with 409 naming them, unless it says `another: true`. The check and the record are one write, so " +
    "of two asked at once for one item only the first is recorded. " +
    RUNNING_WHERE,
  request: {
    headers: ClaimHeader,
    body: json(
      z
        .strictObject({
          role: RoleName,
          brief: Text.optional().describe("The first message. Absent, the role's own; a role without one needs it."),
          item: ItemId.optional(),
          subject: Subject.optional(),
          label: AgentLabel.optional().describe("Absent, the role's."),
          labels: Labels.optional().describe(
            "What the host it is placed on must all carry. Absent, none. With `runtime:host` among them, its agent runs on the " +
              "host rather than in a container (see the agent's `runtime`); every host carries that label.",
          ),
          credentials: Credentials.optional().describe("In place of the role's, as `CreateAgent` takes them."),
          capability: Capability.optional().describe(
            "How capable a model its agent runs on, 1 to 3 (`ListCapabilities`), such as the work item's difficulty. Absent, the role's.",
          ),
          another: z
            .boolean()
            .optional()
            .describe(
              "True to ask for one more agent on `item` though someone is on it already. Absent or false, a request for an item with an agent neither deleted nor `done`, or a request waiting or just started, is refused.",
            ),
        })
        .openapi("NewAgentRequest"),
      "What kind of agent, and what it is for.",
    ),
  },
  responses: {
    201: json(RequestSchema, "Recorded, and `started` if it was admitted at once."),
    ...FAILS,
    400: fails(400, "The request failed validation (a `capability` outside 1-3 among it), the stage has no such role, neither it nor its role has a brief, or a credential is not one this stage has."),
    409: fails(409, "Its `item` has an agent or a request on it already, and it did not say `another: true`."),
  },
});

export const listRequestsRoute = forClientReading({
  method: "get",
  path: "/requests",
  operationId: "ListRequests",
  summary: "List requests",
  description:
    "Those `waiting`, in the order they would start, each with why it waits. With `all=true`, every one, the waiting " +
    "first in that order and then the rest newest first. " +
    ADMISSION,
  request: {
    query: z.object({
      all: z.enum(["true", "false"]).optional().describe("`true` includes those started and withdrawn."),
      requester: z.string().min(1).max(MAKER_LIMIT).optional().describe("Only those made with this `claimed-by`."),
      item: ItemId.optional().describe("Only those for this work item."),
    }),
  },
  responses: { 200: json(z.object({ requests: z.array(RequestSchema).describe("The requests: the waiting in start order, then the rest newest first.") }).openapi("AgentRequestList"), "The requests."), ...FAILS },
});

export const getRequestRoute = forClientReading({
  method: "get",
  path: "/requests/{id}",
  operationId: "GetRequest",
  summary: "Get a request",
  description: "Get one request for an agent.",
  request: { params: z.object({ id: RequestId }) },
  responses: { 200: json(RequestSchema, "The request."), ...NO_REQUEST, ...FAILS },
});

export const withdrawRequestRoute = forClientActing({
  method: "delete",
  path: "/requests/{id}",
  operationId: "WithdrawRequest",
  summary: "Withdraw a request",
  description: "Withdraw a waiting request, so it never starts.",
  request: { params: z.object({ id: RequestId }) },
  responses: {
    200: json(RequestSchema, "Withdrawn."),
    ...NO_REQUEST,
    409: fails(409, "It has started, or was withdrawn already."),
    ...FAILS,
  },
});

export const TICKET_TTL = 60;

export const socketTicketRoute = forClientActing({
  method: "post",
  path: "/socket-tickets",
  operationId: "CreateSocketTicket",
  summary: "Create a socket ticket",
  description:
    "A browser cannot set a header on a WebSocket, and a long-lived token must never go in a " +
    `URL, so a page opens \`<socketUrl>?ticket=<ticket>\` instead. Good once, for ${TICKET_TTL} ` +
    "seconds. The socket then receives `SocketOutbound` messages: `agent`, `lines` and `host`.",
  responses: {
    201: json(
      z
        .object({
          ticket: z.string().describe("Pass as `?ticket=` on the socket; good once."),
          socketUrl: z.string().describe("The socket's address."),
          expiresAt: Instant.describe("When it is no longer good."),
        })
        .openapi("SocketTicket"),
      "The ticket.",
    ),
    ...FAILS,
    503: fails(503, "No API token is configured, or this server has no socket."),
  },
});

export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;
export type RoleView = z.infer<typeof RoleSchema>;
export type RequestView = z.infer<typeof RequestSchema>;
export type LineReport = z.infer<typeof LineReportSchema>;
export type AgentReport = z.infer<typeof AgentReportSchema>;
export type CommandReport = z.infer<typeof CommandReportSchema>;

