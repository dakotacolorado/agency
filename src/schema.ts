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
  SESSION_ENDINGS,
  ACTIVITY_LIMIT,
  SAID,
  STATUSES,
  SUMMARY_LIMIT,
  TEXT_LIMIT,
  TITLE_LIMIT,
  WHEN_DONE,
  AGENT_STATES,
} from "./domain.ts";
import { FRESH_FOR_MS, REQUEST_STATES, STALE_UNDER, USAGE_LIMIT } from "./admission.ts";

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
  .describe("Unique among agents not retired. Names its home folder and tmux session on its host.")
  .openapi({ example: "frontend-1" });

const AgentTitle = z
  .string()
  .trim()
  .min(1)
  .max(TITLE_LIMIT)
  .describe("What the agent is there to do, in a few words.")
  .openapi({ example: "Short status headline" });

/** As honed names its skills: a name, with its group prefix if it has one. */
const DocumentKey = z
  .string()
  .max(100)
  .regex(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .openapi({ example: "workplace/reviewer" });

const Documents = z
  .array(DocumentKey.refine((key) => key !== "workplace/global", "workplace/global is given to every agent"))
  .max(8)
  .refine((keys) => new Set(keys).size === keys.length, "Name each skill once.")
  .describe(
    "The honed skills each session is given after `workplace/global`, by name, at their current version, in this order, " +
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
  .openapi({ example: ["work-tracker", "agent-service"] });

const OwnToken = z
  .strictObject({ name: CredentialName, token: z.string().min(1).max(4096) })
  .describe("A name with a token of the caller's, given this agent in place of the name's shared secret.");

const Credentials = z
  .array(z.union([CredentialName, OwnToken]))
  .max(16)
  .refine(
    (given) => new Set(given.map((c) => (typeof c === "string" ? c : c.name))).size === given.length,
    "Name each credential once.",
  )
  .openapi({ example: ["work-tracker", { name: "waypoint", token: "…" }] });

const WhenDone = z
  .enum(WHEN_DONE)
  .describe(
    "What becomes of the agent once it says it is `done`: `keep`, it stays and a message starts it again; " +
      "`stop`, its session is stopped; `retire`, it is stopped and retired, as by `retireAgent`. On `review`, " +
      "`stop` and `retire` both only stop its session, so a send-back can still start it again.",
  );

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
  .object({ seq: Seq, at: Instant, sessionId: SessionId, from: From, text: LineText, commandId: LineCommandId })
  .openapi("TranscriptLine");

export const LineReportSchema = z
  .object({
    agentId: AgentId,
    sessionId: SessionId,
    seq: Seq.describe("Deduplicated by (`agentId`, `seq`), so resending is safe."),
    at: Instant,
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
  })
  .describe(
    "A session's running total of tokens so far, not what was used since the last report. The service " +
      "keeps the highest of each count reported for the session, so a total sent again, or late, never adds twice.",
  )
  .openapi("SessionTokensReport");

export type SessionTokensReport = z.infer<typeof SessionTokensReportSchema>;

export const CommandReportSchema = z
  .object({
    commandId: z.string().min(1).max(128),
    ok: z.boolean().describe("False when the host could not do the command."),
    error: z.string().max(4096).optional().describe("Why not, when `ok` is false, in the host's words."),
    taken: z
      .boolean()
      .optional()
      .describe(
        "`false` with `ok` true: a command with text, written to its agent's session but not yet " +
          "taken by it. The command is off the queue (`written`), and its host reports it once more, " +
          "`ok` true once the session takes it, false if it never will. Absent or true: settled.",
      ),
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

// Strict, so a host still sending reports here is refused rather than silently dropped.
export const HeartbeatSchema = z
  .strictObject({
    version: z.string().max(64).describe("The agent-host build that sent the heartbeat."),
    labels: Labels.optional().describe(
      "What the host offers, as its owner configured it. A full snapshot; absent, the host's last labels stand (none for a new host).",
    ),
    capacity: Capacity.optional().describe(
      "How many sessions the host will run at once. Absent, capacity is unknown.",
    ),
  })
  .openapi("Heartbeat", {
    example: { version: "0.1.0", labels: ["macos", "arm64"], capacity: 4 },
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
      .object({ ...commandBase, kind: z.literal("create"), name: AgentName })
      .describe("Make the agent's home folder.")
      .openapi("CreateCommand"),
    z
      .object({
        ...commandBase,
        kind: z.literal("start"),
        sessionId: SessionId,
        resume: z
          .boolean()
          .describe("True to carry on the agent's last conversation (`--continue`), false to begin one."),
        text: Text.optional().describe("The session's first message, when it has one."),
        context: ContextSchema.optional().describe(
          "Files to write into the agent's own Claude Code folder before it starts, replacing the last " +
            "context's: `skills/...` as files, and a `CLAUDE.md` after the host's own rules. Absent, the " +
            "last context and documents written stand.",
        ),
        documents: z
          .array(ContextSchema)
          .optional()
          .describe(
            "Written after `context`, as it is, each with its own files and its `CLAUDE.md` after the one " +
              "before; they replace the last start's. No two write the same file under `skills/`. Only " +
              "with a `context`; absent with one, there are none.",
          ),
        contextUrl: z
          .string()
          .optional()
          .describe(
            "Present when the whole context is too large for a socket message: the path of `getSessionContext` " +
              "for this session. A host reads it, with the stage's token, and writes what it answers in place of " +
              "`context` and `documents`, which then hold only what fitted. A host that cannot read it writes them.",
          ),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Set in the session's environment: the addresses of the services it is given. Never a secret."),
        credentials: CredentialNames.optional().describe(
          "The services the session is given, by name, as kept on record. Their tokens are in `secrets`.",
        ),
        ownCredentials: CredentialNames.optional().describe(
          "Of `credentials`, those the agent was given a token of its own for, read in place of the shared one.",
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
      })
      .openapi("StartCommand"),
    z
      .object({ ...commandBase, kind: z.literal("message"), text: Text })
      .describe("Deliver `text` at the session's next turn.")
      .openapi("MessageCommand"),
    z
      .object({
        ...commandBase,
        kind: z.literal("interrupt"),
        text: Text.optional().describe("Sent to the agent once the current turn has stopped."),
      })
      .openapi("InterruptCommand"),
    z
      .object({ ...commandBase, kind: z.literal("stop") })
      .describe("End the session; the agent becomes idle.")
      .openapi("StopCommand"),
    z
      .object({ ...commandBase, kind: z.literal("retire") })
      .describe("Stop any session and take the agent off the host. Its home folder is kept.")
      .openapi("RetireCommand"),
  ])
  .openapi("Command");

export type Command = z.infer<typeof CommandSchema>;

export const HeartbeatResponseSchema = z
  .object({
    heartbeatInterval: z
      .number()
      .int()
      .positive()
      .describe("Seconds until the host should send its next heartbeat."),
    socketUrl: SocketUrl.describe(
      "Where to open the host's socket: `<socketUrl>?hostId=<id>` with this token as " +
        "`Authorization: Bearer`. Commands and reports go by the socket alone, so on a " +
        "server with none (null) no command reaches the host.",
    ),
  })
  .openapi("HeartbeatResponse");

export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

// --- what a client reads ----------------------------------------------------

const HostStatus = z
  .enum(HOST_STATUSES)
  .describe(
    "Computed from `heartbeatAt` when the response was made, never stored. `connected`: silent at " +
      `most ${2 * HEARTBEAT_INTERVAL} seconds. \`disconnected\`: at most ${LOST_AFTER}. \`lost\`: longer.`,
  );

export const AgentSchema = z
  .object({
    id: AgentId,
    name: AgentName,
    title: z
      .string()
      .nullable()
      .describe(
        "What the agent named itself for its work, with `setAgentTitle`, or the person with " +
          "`renameAgent`. Kept across sessions; null until one is given. Unlike `name`, it names " +
          "nothing on its host.",
      ),
    label: z
      .string()
      .nullable()
      .describe("A short tag given when it was made or with `renameAgent`, shown beside its name. Null for none."),
    item: ItemId.nullable().describe("The work item it was started on, as given when it was made; null for none."),
    role: RoleName.nullable().describe("The role it was made from, as given when it was made; null for one made without."),
    tokens: TokensSchema.describe(
      "Tokens its sessions have used, summed, as its host reported each session's running total; every count " +
        "0 until one is reported. A live session's count still grows.",
    ),
    createdBy: z
      .string()
      .nullable()
      .describe("The `claimed-by` header of the `createAgent` call that made it, unverified. Null when it had none."),
    whenDone: WhenDone,
    documents: z.array(z.string()).describe("The honed skills each session is given after `workplace/global`, by name."),
    credentials: z
      .array(z.string())
      .nullable()
      .describe(
        "The services each session is given, by name; null for the stage's defaults. Never a token, nor whether " +
          "one was the caller's own.",
      ),
    hostId: HostId,
    state: z
      .enum(AGENT_STATES)
      .describe(
        "`idle`: has a home and no live session. `working`, `waiting`: a live session, " +
          "in a turn or between turns, as its host last reported it (`working` too from the moment a " +
          "`start` or a message is queued). " +
          "`interrupted`: its session ended without a stop, and it can be resumed. `retired`: " +
          "no longer on the team; its home folder is kept on the host.",
      ),
    session: z
      .object({ id: SessionId, startedAt: Instant })
      .nullable()
      .describe("The live session, or null for none."),
    createdAt: Instant,
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
          "`setAgentStatus` that it needs the person, and stays so until the person messages it " +
          "(a turn it begins by itself does not end it). `review`: its change is submitted to " +
          "approval-service, said by the agent or by approval-service, and it waits on the reviewer " +
          "until the change ships or is sent back. `done`: it finished what it was made for, or its " +
          "change shipped. `review` and `done` are kept once its session ends, and no turn changes " +
          "them; only a message from the person, or `setAgentStatus`, does. Otherwise null without " +
          "a live session. Only `waiting` should notify the person.",
      ),
    summary: z
      .string()
      .nullable()
      .describe(
        "One line it, or approval-service, last said with `setAgentStatus`: what it is doing, while " +
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
    hostStatus: HostStatus.describe(
      "Its host's `status`. While the host is `disconnected` or `lost`, `state` may be out of date.",
    ),
  })
  .openapi("Agent");

export const SessionSchema = z
  .object({
    id: SessionId,
    agentId: AgentId,
    startedAt: Instant.describe("When its `start` was queued."),
    endedAt: Instant.nullable(),
    ended: z
      .enum(SESSION_ENDINGS)
      .nullable()
      .describe("`stopped`: told to stop, or its host ended it cleanly. `interrupted`: it died. Null while live."),
    context: z
      .object({ key: z.string(), version: z.number().int() })
      .nullable()
      .describe("The `workplace/global` it started with, from honed; null when it was given none."),
    documents: z
      .array(z.object({ key: z.string(), version: z.number().int() }))
      .describe("The documents it started with beside `context`, in order."),
    skills: z
      .array(z.object({ key: z.string(), version: z.number().int(), commit: z.string() }))
      .describe(
        "The clients it started with, each read from its service's `GET /skill` for this stage and written over `context`'s files at the same paths.",
      ),
    contextNote: z
      .string()
      .nullable()
      .describe("Why it was given no context, or why a document it was made with, or a service's skill, was left out."),
  })
  .openapi("Session");

export const HostSchema = z
  .object({
    id: HostId,
    heartbeatAt: Instant,
    version: z.string().nullable().describe("The agent-host build of its last heartbeat."),
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

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const FAILS = {
  400: json(ErrorSchema, "The request failed validation."),
  401: json(ErrorSchema, "Missing or incorrect bearer token."),
  503: json(ErrorSchema, "No API token is configured."),
};

const NO_AGENT = { 404: json(ErrorSchema, "No agent has this id.") };

const NO_HOST = { 404: json(ErrorSchema, "No host has this id.") };

const REFUSED = (why: string) => ({ 409: json(ErrorSchema, `Nothing was queued: ${why}`) });

export const AcceptedSchema = z
  .object({
    commandId: z
      .string()
      .nullable()
      .describe("Follow it in `listAgentCommands`. Null when nothing was sent to the host."),
  })
  .openapi("Accepted");

export const SentCommandSchema = z
  .object({
    command: CommandSchema,
    queuedAt: Instant,
    delivery: z
      .enum(DELIVERIES)
      .describe(
        "`queued`: not yet reported by the host. `written`: its text is in the agent's session, which " +
          "has not yet taken it (it takes it at its next step); a session that ends first makes it " +
          "`rejected`. `withdrawn`: never to be sent, because it went " +
          `unreported for ${LOST_AFTER} seconds (\`create\` and \`retire\` excepted) or its agent ` +
          "was force-stopped. `done` / `rejected`: the host reported it, done (a text: taken) or not.",
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
    type: z.literal("report"),
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
  .object({ type: z.literal("ping") })
  .describe("Either side's keep-alive, beside the server's WebSocket pings, which close a socket that misses one.")
  .openapi("SocketPing");

export const SocketInboundSchema = z
  .discriminatedUnion("type", [SocketReportSchema, SocketPingSchema])
  .openapi("SocketInbound");

export type SocketInbound = z.infer<typeof SocketInboundSchema>;

export const SocketOutboundSchema = z
  .discriminatedUnion("type", [
    z
      .object({ type: z.literal("command"), command: CommandSchema })
      .describe(
        "To every socket of the command's host, the moment it is queued; and to a host's socket " +
          "once it is open, every command still pending for that host, oldest first. That replay " +
          "follows the first message the host sends on it (its full report on connecting), and " +
          "leaves out commands that message reports. A command is pending until a report names it, or until it is " +
          "withdrawn; a host may see one more than once, and knows it by `id`.",
      )
      .openapi("CommandPush"),
    z
      .object({ type: z.literal("agent"), agent: AgentSchema })
      .describe("To viewers, whenever an agent changes.")
      .openapi("AgentPush"),
    z
      .object({ type: z.literal("lines"), agentId: AgentId, lines: z.array(TranscriptLineSchema) })
      .describe("To viewers, as lines arrive.")
      .openapi("LinesPush"),
    z
      .object({ type: z.literal("sent"), agentId: AgentId, sent: SentCommandSchema })
      .describe(
        "To viewers, when a command carrying `text` (a `message`, a `start` or an `interrupt`) is " +
          "queued, and each time its `delivery` changes, " +
          "but for a time-based `withdrawn`, which a read of `listAgentCommands` says.",
      )
      .openapi("SentPush"),
    z
      .object({ type: z.literal("host"), host: HostSchema })
      .describe("To viewers, on every heartbeat.")
      .openapi("HostPush"),
    z
      .object({ type: z.literal("usage"), usage: UsageSchema })
      .describe("To viewers, when a report brings a newer reading of the account's usage.")
      .openapi("UsagePush"),
    z
      .object({ type: z.literal("error"), error: z.string() })
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
export const AUDIENCES = {
  host: "hosts",
  reading: "clients, reading",
  acting: "clients, acting",
  agent: "agents, of themselves",
} as const;

type Unaudienced = Omit<RouteConfig, "tags" | "security">;

const secured = { security: [{ bearerAuth: [] }] };

const forHost = <R extends Unaudienced>(route: R) =>
  createRoute({ ...route, ...secured, tags: [AUDIENCES.host] });
const forClientReading = <R extends Unaudienced & { method: "get" }>(route: R) =>
  createRoute({ ...route, ...secured, tags: [AUDIENCES.reading] });
const forClientActing = <R extends Unaudienced & { method: "post" | "patch" | "delete" }>(route: R) =>
  createRoute({ ...route, ...secured, tags: [AUDIENCES.acting] });
const forAgent = <R extends Unaudienced & { method: "put" }>(route: R) =>
  createRoute({ ...route, ...secured, tags: [AUDIENCES.agent] });

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "healthCheck",
  tags: ["meta"],
  summary: "Health check",
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

export const heartbeatRoute = forHost({
  method: "post",
  path: "/hosts/{id}/heartbeat",
  operationId: "heartbeat",
  summary: "Keep the host connected, and say what it offers",
  description:
    "Liveness and what the host offers, nothing more: commands come down the host's socket at " +
    "`socketUrl`, and reports go up it. The host chooses its id; the first heartbeat from an id " +
    "registers it. Only a heartbeat keeps a host `connected`.",
  request: {
    params: z.object({ id: HostId }),
    body: json(HeartbeatSchema, "What the host is and offers."),
  },
  responses: {
    200: json(HeartbeatResponseSchema, "Accepted."),
    ...FAILS,
  },
});

export const listHostsRoute = forClientReading({
  method: "get",
  path: "/hosts",
  operationId: "listHosts",
  summary: "List hosts",
  description:
    "Every host that has sent a heartbeat since it was last deregistered with `deleteHost`, however " +
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
    200: json(z.object({ hosts: z.array(HostSchema) }).openapi("HostList"), "The hosts listed."),
    ...FAILS,
  },
});

export const deleteHostRoute = forClientActing({
  method: "delete",
  path: "/hosts/{id}",
  operationId: "deleteHost",
  summary: "Deregister a host",
  description:
    "Deletes the host's record, which is how a host leaves `listHosts`. Its agents, their " +
    "transcripts and the commands sent to them stay on record, and its agents read as on a " +
    "`lost` host. The next heartbeat from this id registers it again, and its socket is sent " +
    "whatever is still queued for it.",
  request: { params: z.object({ id: HostId }) },
  responses: { 204: { description: "Deregistered." }, ...NO_HOST, ...FAILS },
});

export const createAgentRoute = forClientActing({
  method: "post",
  path: "/agents",
  operationId: "createAgent",
  summary: "Create an agent on a host",
  description:
    "Records the agent `idle` and queues `create` for its host, which makes its home. With a " +
    "`brief`, also queues a `start` whose first message is the brief, and the agent is `working` " +
    "at once. Without a `hostId`, the service chooses a connected host with room.",
  request: {
    headers: ClaimHeader,
    body: json(
      z
        .object({
          name: AgentName,
          role: RoleName.optional().describe(
            "The role it is made from (`listRoles`): its `documents`, `credentials`, `whenDone`, `label` and `brief` " +
              "are the agent's, each unless given here, which overrides the role's. A role this stage does not have is refused.",
          ),
          hostId: HostId.optional().describe(
            "Where it lives. Absent, the service places it on a `connected` host with room (`available` above 0), " +
              "the one with the most first, carrying every one of `labels`.",
          ),
          labels: Labels.optional().describe("Without `hostId`, what the host it is placed on must all carry."),
          brief: Text.optional().describe("The first session's first message. Absent, the role's, if it has one; otherwise no session starts."),
          label: AgentLabel.optional().describe("Absent, the role's, or without one none."),
          item: ItemId.optional().describe(
            "The work item it is started on, kept for its life so `listAgents` with `item` finds it. Absent, none.",
          ),
          whenDone: WhenDone.optional().describe("Absent, the role's, or without one `keep`."),
          credentials: Credentials.optional().describe(
            "The services each session is given an address and token for, by name: `agent-service` and each " +
              "its services file names, such as `waypoint` and `honed`. A name it does not have is refused. " +
              "Absent, the role's, or without one all of them. Only the names are kept on record; each token is read at each start. " +
              "`{name, token}` gives this agent the caller's token in place of the name's shared one: kept apart " +
              "from its record, never returned by any read, and deleted when the agent is retired.",
          ),
          documents: Documents.optional().describe(
            "Given after `workplace/global` at each start, at their current version. A skill honed does not " +
              "have is refused here. Absent, the role's, or without one only `workplace/global`.",
          ),
        })
        .openapi("NewAgent"),
      "Who the agent is and where it lives.",
    ),
  },
  responses: {
    201: json(AgentSchema, "Created; its `create` is queued for the host."),
    404: json(ErrorSchema, "No host has the id `hostId`."),
    ...REFUSED("an agent not retired already has `name`, the host is `lost`, or it is full and a `brief` was given."),
    ...FAILS,
    503: json(ErrorSchema, "No API token is configured, or no `hostId` was given and no connected host fits and has room."),
    400: json(
      ErrorSchema,
      "The request failed validation, `role` is not one this stage has, a credential is not one this stage has, or honed has no skill named in `documents`.",
    ),
  },
});

export const listAgentsRoute = forClientReading({
  method: "get",
  path: "/agents",
  operationId: "listAgents",
  summary: "List agents",
  description:
    "Retired agents are listed only with `all=true`, or with `item`. With `createdBy`, only the agents " +
    "made by that `claimed-by`, so a service can list its own. With `item`, only those started on that " +
    "work item, retired ones included, so what they used is still there once they have gone. With `role`, only " +
    "those made from that role.",
  request: {
    query: z.object({
      createdBy: z.string().min(1).max(MAKER_LIMIT).optional(),
      item: ItemId.optional(),
      role: RoleName.optional().describe("Only the agents made from this role."),
      all: z.enum(["true", "false"]).optional().describe("`true` includes retired agents."),
    }),
  },
  responses: {
    200: json(z.object({ agents: z.array(AgentSchema) }).openapi("AgentList"), "Matching agents."),
    ...FAILS,
  },
});

export const getAgentRoute = forClientReading({
  method: "get",
  path: "/agents/{id}",
  operationId: "getAgent",
  summary: "Get one agent",
  request: { params: z.object({ id: AgentId }) },
  responses: { 200: json(AgentSchema, "The agent."), ...NO_AGENT, ...FAILS },
});

const agentParam = { params: z.object({ id: AgentId }) };

export const messageAgentRoute = forClientActing({
  method: "post",
  path: "/agents/{id}/messages",
  operationId: "messageAgent",
  summary: "Send an agent a message, or interrupt it",
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
    ...REFUSED("the agent is retired, has no session to interrupt, or its host is `lost` or full."),
    ...FAILS,
  },
});

export const stopAgentRoute = forClientActing({
  method: "post",
  path: "/agents/{id}/stop",
  operationId: "stopAgent",
  summary: "Stop an agent's session, or force it idle",
  description:
    "Queues a `stop`; the session ends and the agent is `idle` once its host reports doing it. " +
    "When its host is `lost` or deregistered, and so cannot be told, or with `force: true`, the session " +
    "is ended and the agent `idle` at once, and everything queued for it but `create` is withdrawn; " +
    "nothing is sent. If its host later reports that session still running, it is sent a `stop`. " +
    "A caller need not send `force`: the service decides it from the host.",
  request: {
    ...agentParam,
    body: {
      ...json(
        z
          .object({
            force: z.boolean().optional().describe("`true` ends it on record without waiting for the host, even one still connected."),
          })
          .openapi("Stop"),
        "Optional. Absent, the host is asked to stop it.",
      ),
      required: false,
    },
  },
  responses: {
    202: json(AcceptedSchema, "The `stop` is queued; ended on record (its host `lost`, or `force`), and `commandId` is null."),
    ...NO_AGENT,
    ...REFUSED("the agent has no live session."),
    ...FAILS,
  },
});

export const resumeAgentRoute = forClientActing({
  method: "post",
  path: "/agents/{id}/resume",
  operationId: "resumeAgent",
  summary: "Start a session continuing the agent's last conversation",
  description: "Queues a `start` with `resume: true`, or `false` for an agent that has never had a session.",
  request: agentParam,
  responses: {
    202: json(AcceptedSchema, "The `start` is queued."),
    ...NO_AGENT,
    ...REFUSED("the agent is retired or has a live session, or its host is `lost` or full."),
    ...FAILS,
  },
});

export const renameAgentRoute = forClientActing({
  method: "patch",
  path: "/agents/{id}",
  operationId: "renameAgent",
  summary: "Rename an agent, or change or clear its title or label",
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
    ...REFUSED("the agent is retired, or an agent not retired already has `name`."),
    ...FAILS,
  },
});

export const retireAgentRoute = forClientActing({
  method: "delete",
  path: "/agents/{id}",
  operationId: "retireAgent",
  summary: "Retire an agent",
  description:
    "Records it `retired` at once, ends any session, frees its name, and queues a `stop` if it had " +
    "a live session and then `retire`, which is offered until its host takes it. Its transcript, " +
    "sessions and home folder are kept.",
  request: agentParam,
  responses: {
    202: json(AcceptedSchema, "Retired; `commandId` is the `retire`'s."),
    ...NO_AGENT,
    ...REFUSED("the agent is retired already."),
    ...FAILS,
  },
});

export const transcriptRoute = forClientReading({
  method: "get",
  path: "/agents/{id}/transcript",
  operationId: "listTranscript",
  summary: "List an agent's transcript lines after a cursor, oldest first, across its sessions",
  description: "Poll with the returned `next`, or take `lines` on a socket, to follow it as it grows.",
  request: { ...agentParam, query: z.object(page) },
  responses: {
    200: json(
      z
        .object({
          lines: z.array(TranscriptLineSchema),
          next: Cursor.describe("Pass as `after` to read what follows. Unchanged when nothing does yet."),
        })
        .openapi("Transcript"),
      "Lines after the cursor.",
    ),
    ...NO_AGENT,
    ...FAILS,
  },
});

export const listSessionsRoute = forClientReading({
  method: "get",
  path: "/agents/{id}/sessions",
  operationId: "listSessions",
  summary: "List an agent's sessions, oldest first",
  request: agentParam,
  responses: {
    200: json(z.object({ sessions: z.array(SessionSchema) }).openapi("SessionList"), "Every session."),
    ...NO_AGENT,
    ...FAILS,
  },
});

export const SessionContextSchema = z
  .object({
    context: ContextSchema.nullable().describe("Written as a start's `context` is; null when there is none to give."),
    documents: z.array(ContextSchema).describe("Written after it, as a start's `documents` are."),
  })
  .openapi("SessionContext");

export const getSessionContextRoute = forHost({
  method: "get",
  path: "/agents/{id}/sessions/{sessionId}/context",
  operationId: "getSessionContext",
  summary: "Read a live session's whole context, when its start was too large to carry it",
  description:
    "Read at the moment it is asked, as a start's is, and recorded on the session in place of what its " +
    "start carried, so the session's `contextNote` says what it was given.",
  request: { params: z.object({ id: AgentId, sessionId: SessionId }) },
  responses: {
    200: json(SessionContextSchema, "Its context and documents."),
    ...NO_AGENT,
    409: json(ErrorSchema, "The session is not the agent's live one."),
    ...FAILS,
  },
});

export const listAgentCommandsRoute = forClientReading({
  method: "get",
  path: "/agents/{id}/commands",
  operationId: "listAgentCommands",
  summary: "List the commands sent to an agent, oldest first, with their delivery",
  description: `Each is kept ${KEPT_FOR / 86400} days from when it was queued, then deleted.`,
  request: agentParam,
  responses: {
    200: json(
      z.object({ commands: z.array(SentCommandSchema) }).openapi("AgentCommands"),
      "Every command kept.",
    ),
    ...NO_AGENT,
    ...FAILS,
  },
});

export const setAgentStatusRoute = forAgent({
  method: "put",
  path: "/agents/{id}/status",
  operationId: "setAgentStatus",
  summary: "Say whether the agent needs the person, is in review or done, and what on",
  description:
    "Called by the agent itself, from its `page` skill, and by approval-service for the agent whose change it " +
    "took or shipped. `waiting` says the agent needs the person; it stands until the person messages it. `working` " +
    "only says what it is doing: whether it reads `working` or `idle` is its host's turns. `review` says its change " +
    "is submitted to approval-service and `done` that it finished, or its change shipped; each needs no live session. " +
    "Not sent to its host. Once the agent is in `review` or `done` and no turn or background task of its runs, " +
    "`whenDone` is carried out: `stop` stops its session, and `retire` retires it once `done` (in `review` it is " +
    "stopped, never retired, so a send-back reaches it).",
  request: {
    ...agentParam,
    body: json(
      z
        .strictObject({
          status: z.enum(SAID),
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
    409: json(ErrorSchema, "The agent is retired, or has no live session to be `working` or `waiting`."),
    ...FAILS,
  },
});

export const setAgentTitleRoute = forAgent({
  method: "put",
  path: "/agents/{id}/title",
  operationId: "setAgentTitle",
  summary: "Name the agent for its work, once",
  description:
    "Called by the agent itself, early in its first session, once it knows what it is there to do. " +
    "Set once: after that only the person changes it, with `renameAgent`.",
  request: {
    ...agentParam,
    body: json(z.strictObject({ title: AgentTitle }).openapi("AgentTitle"), "What the agent names itself."),
  },
  responses: {
    200: json(AgentSchema, "Recorded."),
    ...NO_AGENT,
    409: json(ErrorSchema, "The agent is retired, or has a title already."),
    ...FAILS,
  },
});

export const getUsageRoute = forClientReading({
  method: "get",
  path: "/usage",
  operationId: "getUsage",
  summary: "Read how much of the Claude account's 5-hour and weekly allowance is used",
  description:
    "The newest reading of each window any host has reported. A window whose `resetsAt` has " +
    "passed has since started again from 0; the reading says only what was true at `readAt`. " +
    "With nothing reported yet, every field is null.",
  responses: { 200: json(UsageSchema, "The newest reading."), 401: FAILS[401], 503: FAILS[503] },
});

// --- roles ------------------------------------------------------------------

const Priority = z.number().int().min(0).max(1000);

const RoleFields = {
  documents: Documents.describe("The honed skills each session of an agent made from it is given after `workplace/global`, by name, in this order."),
  credentials: CredentialNames.nullable().describe(
    "The services each session is given, by name; null for the stage's defaults. A caller can still give one of these " +
      "a token of its own, by naming it in `credentials` as `{name, token}`.",
  ),
  whenDone: WhenDone,
  label: AgentLabel,
  description: Text.nullable().describe(
    "What an agent made from it is for, who starts one, and whether a person would: markdown, a few sentences. Null for none.",
  ),
  priority: Priority.describe("Of two requests waiting to start, the higher starts first."),
  brief: Text.nullable().describe("The first message of an agent made from it with no `brief` of its own; null when the caller must give one."),
};

export const RoleSchema = z
  .object({
    name: RoleName,
    ...RoleFields,
    updatedAt: Instant.nullable().describe("When it was last written; null for a role as the stage was seeded with it."),
  })
  .openapi("Role");

const NO_ROLE = { 404: json(ErrorSchema, "No role has this name.") };

const ADMIN = { 403: json(ErrorSchema, "Writing a role takes the stage's admin token.") };

const roleParam = { params: z.object({ name: RoleName }) };

export const listRolesRoute = forClientReading({
  method: "get",
  path: "/roles",
  operationId: "listRoles",
  summary: "List roles",
  description:
    "Every role an agent can be made from, highest `priority` first. A stage starts with `planner`, `reviewer`, " +
    "`conflict`, `investigator`, `judge` and `implementer`, as their callers made them before roles; one written " +
    "with `createRole` or `updateRole` is served as written.",
  responses: { 200: json(z.object({ roles: z.array(RoleSchema) }).openapi("RoleList"), "The roles."), ...FAILS },
});

export const getRoleRoute = forClientReading({
  method: "get",
  path: "/roles/{name}",
  operationId: "getRole",
  summary: "Get one role",
  request: roleParam,
  responses: { 200: json(RoleSchema, "The role."), ...NO_ROLE, ...FAILS },
});

export const createRoleRoute = forClientActing({
  method: "post",
  path: "/roles",
  operationId: "createRole",
  summary: "Create a role",
  description: "Takes the stage's admin token. An agent made from it afterwards gets what it names; one made before keeps what it was given.",
  request: {
    body: json(
      z
        .strictObject({
          name: RoleName,
          ...RoleFields,
          documents: RoleFields.documents.optional().describe("Absent, only `workplace/global`."),
          credentials: RoleFields.credentials.optional().describe("Absent, null: the stage's defaults."),
          whenDone: WhenDone.optional().describe("Absent, `keep`."),
          priority: RoleFields.priority.optional().describe("Absent, 0."),
          brief: RoleFields.brief.optional().describe("Absent, null."),
          description: RoleFields.description.optional().describe("Absent, null."),
        })
        .openapi("NewRole"),
      "The role.",
    ),
  },
  responses: {
    201: json(RoleSchema, "Created."),
    ...ADMIN,
    409: json(ErrorSchema, "A role has this name already."),
    ...FAILS,
    400: json(ErrorSchema, "The request failed validation, a credential is not one this stage has, or honed has no skill named in `documents`."),
  },
});

export const updateRoleRoute = forClientActing({
  method: "patch",
  path: "/roles/{name}",
  operationId: "updateRole",
  summary: "Change a role",
  description:
    "Takes the stage's admin token. Each field given replaces the role's; one absent is kept. Agents made from it " +
    "before keep what they were given; those made after get what it names now.",
  request: {
    ...roleParam,
    body: json(
      z
        .strictObject(Object.fromEntries(Object.entries(RoleFields).map(([k, v]) => [k, v.optional()])) as {
          [K in keyof typeof RoleFields]: z.ZodOptional<(typeof RoleFields)[K]>;
        })
        .openapi("RoleChange"),
      "What changes.",
    ),
  },
  responses: {
    200: json(RoleSchema, "Changed."),
    ...ADMIN,
    ...NO_ROLE,
    ...FAILS,
    400: json(ErrorSchema, "The request failed validation, a credential is not one this stage has, or honed has no skill named in `documents`."),
  },
});

// --- requests ---------------------------------------------------------------

const RequestId = z.uuid().describe("Assigned by the service; also the id of the agent it starts.");

const Subject = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("What it is for when that is no work item, such as `PR #41` or `judgment 3f…`: shown, never read.")
  .openapi({ example: "dakotacolorado/agent-service#41" });

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
    requester: z.string().nullable().describe("The `claimed-by` header it was made with, unverified; null for none."),
    state: z
      .enum(REQUEST_STATES)
      .describe("`waiting` to be admitted; `started`, its agent made and its session queued; `withdrawn`, never to start."),
    why: z.string().nullable().describe("While `waiting`, why it has not started, as admission last found; null before it has looked, and once it is not waiting."),
    priority: Priority.describe("Its role's, now."),
    position: z.number().int().min(1).nullable().describe("Where it stands among those waiting, 1 starting next; null once it is not waiting."),
    createdAt: Instant,
    startedAt: Instant.nullable(),
    agentId: AgentId.nullable().describe("The agent it started; null until it has."),
    withdrawnAt: Instant.nullable(),
  })
  .openapi("AgentRequest");

const NO_REQUEST = { 404: json(ErrorSchema, "No request has this id.") };

export const createRequestRoute = forClientActing({
  method: "post",
  path: "/requests",
  operationId: "createRequest",
  summary: "Ask for an agent in a role, to start when usage and a host allow",
  description:
    "Records the request `waiting`, then admits what it can at once. " +
    ADMISSION +
    " Admitted, the agent is made from its role as `createAgent` with `role` would, with this request's id as its " +
    "own and a name of the service's choosing (`<role>-<first 8 of its id>`), placed on a host of the service's " +
    "choosing; `agentId` names it. A request names no host or agent name.",
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
          labels: Labels.optional().describe("What the host it is placed on must all carry. Absent, none."),
          credentials: Credentials.optional().describe(
            "In place of the role's, as `createAgent` takes them; a `{name, token}` is kept for the agent it " +
              "starts from now, and deleted if it is withdrawn.",
          ),
          tokens: z
            .array(OwnToken)
            .min(1)
            .max(16)
            .refine((given) => new Set(given.map((t) => t.name)).size === given.length, "Name each token once.")
            .optional()
            .describe(
              "Tokens of the caller's, each given the agent in place of that service's shared secret, for services it " +
                "is given anyway: its role's, or `credentials`. The agent keeps its role's services, so a caller with " +
                "a token of its own for one need not name them all. Kept as `credentials`' are; refused for a service " +
                "the agent would not be given, or one `credentials` gives a token for.",
            ),
        })
        .openapi("NewAgentRequest"),
      "What kind of agent, and what it is for.",
    ),
  },
  responses: {
    201: json(RequestSchema, "Recorded, and `started` if it was admitted at once."),
    ...FAILS,
    400: json(ErrorSchema, "The request failed validation, the stage has no such role, neither it nor its role has a brief, a credential is not one this stage has, or a token is for a service the agent would not be given."),
    503: json(ErrorSchema, "No API token is configured, or a token of its own could not be kept."),
  },
});

export const listRequestsRoute = forClientReading({
  method: "get",
  path: "/requests",
  operationId: "listRequests",
  summary: "List requests for agents",
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
  responses: { 200: json(z.object({ requests: z.array(RequestSchema) }).openapi("AgentRequestList"), "The requests."), ...FAILS },
});

export const getRequestRoute = forClientReading({
  method: "get",
  path: "/requests/{id}",
  operationId: "getRequest",
  summary: "Get one request for an agent",
  request: { params: z.object({ id: RequestId }) },
  responses: { 200: json(RequestSchema, "The request."), ...NO_REQUEST, ...FAILS },
});

export const withdrawRequestRoute = forClientActing({
  method: "delete",
  path: "/requests/{id}",
  operationId: "withdrawRequest",
  summary: "Withdraw a waiting request, so it never starts",
  request: { params: z.object({ id: RequestId }) },
  responses: {
    200: json(RequestSchema, "Withdrawn."),
    ...NO_REQUEST,
    409: json(ErrorSchema, "It has started, or was withdrawn already."),
    ...FAILS,
  },
});

export const TICKET_TTL = 60;

export const socketTicketRoute = forClientActing({
  method: "post",
  path: "/socket-tickets",
  operationId: "createSocketTicket",
  summary: "Trade the bearer token for a one-time socket ticket",
  description:
    "A browser cannot set a header on a WebSocket, and a long-lived token must never go in a " +
    `URL, so a page opens \`<socketUrl>?ticket=<ticket>\` instead. Good once, for ${TICKET_TTL} ` +
    "seconds. The socket then receives `SocketOutbound` messages: `agent`, `lines` and `host`.",
  responses: {
    201: json(
      z
        .object({
          ticket: z.string(),
          socketUrl: z.string(),
          expiresAt: Instant,
        })
        .openapi("SocketTicket"),
      "The ticket.",
    ),
    ...FAILS,
    503: json(ErrorSchema, "No API token is configured, or this server has no socket."),
  },
});

export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;
export type RoleView = z.infer<typeof RoleSchema>;
export type RequestView = z.infer<typeof RequestSchema>;
export type LineReport = z.infer<typeof LineReportSchema>;
export type AgentReport = z.infer<typeof AgentReportSchema>;
export type CommandReport = z.infer<typeof CommandReportSchema>;

export const SkillSchema = z
  .object({
    key: z.string().describe("Whose skills these are: `agent-service`."),
    version: z.number().int().describe("The deployed tree's commit count, 0 when deployed from outside git."),
    commit: z.string().describe("The deployed commit, ending `-dirty` when deployed with uncommitted changes."),
    files: z.array(
      z.object({
        path: z.string().describe("Under the agent's Claude Code folder: `skills/<name>/bin/…` or `skills/<name>/reference/…`."),
        content: z.string(),
        executable: z.boolean(),
      }),
    ),
  })
  .openapi("Skill");

export const getSkillRoute = forClientReading({
  method: "get",
  path: "/skill",
  operationId: "getSkill",
  summary: "Read the clients agents call this deployment with",
  description:
    "The `page` and `title` skills, `SKILL.md`, `bin/` and `reference/`, as this deployment was built with them. " +
    "Every start lays them, and each other service's `GET /skill` (its `bin/` and `reference/` alone), over " +
    "`workplace/global`'s files at the same paths, so an agent calls the API that is deployed.",
  responses: { 200: json(SkillSchema, "The skills' files."), 401: FAILS[401], 503: FAILS[503] },
});
