import type { WhenDone } from "./domain.ts";

/**
 * What a kind of worker is started with: a caller names the role and says
 * what is particular to this one (its brief, its item), and the role gives
 * the rest. Its priority orders admission: higher starts first.
 */
export interface Role {
  name: string;
  /** Read after `global` at each start. */
  documents: string[];
  /** The services each session is given, by name; null for the stage's defaults. */
  credentials: string[] | null;
  whenDone: WhenDone;
  label: string;
  /** What it is for, who starts it, and whether a person would: markdown; null for none. */
  description: string | null;
  priority: number;
  /** The first message when the caller gives none; null when a caller must. */
  brief: string | null;
  /** When it was last written; null for a role as seeded and never changed. */
  updatedAt: string | null;
}

/** Every service a session can be given, as approval-service gives its reviewers today. */
const ALL = ["document-service", "work-tracker", "worker-service", "approval-service"];

const PLANNER_BRIEF = [
  "You are a planner, started from the Work page's New item button. Ask the person, in this chat, what they want done: use the page skill to say you are waiting on them for it, and end your turn. Their answer, in their own words, starts you again. Then plan it into one epic in the work tracker, its stories, and the dependencies between them, as the `planner` document you started with says. Write the items; do not take them or do the work.",
  "When the plan is written, report each item you made by short id and title, then use the page skill to say done, with a one-line result: your session then ends, and a message from the person in this chat starts it again, to revise the items you made rather than make new ones.",
].join("\n\n");

const DESCRIPTIONS = {
  planner:
    "Turns what the person wants done into one epic in the work tracker, with its stories and the dependencies between them. It asks the person what they want, in its chat, and writes the items; it never takes them or does the work.\n\n" +
    "**Started by** the person: the Work page's New item button, or the New worker form. Pick it when you have new work to plan.",
  implementer:
    "Does one ticket from the work tracker: an epic, story or task. It writes the change, runs the repo's checks, opens the PR and submits it to approval-service, then moves the item to review.\n\n" +
    "**Started by** the work queue, for the next ticket in it, or by a person on a ticket of their choosing. A send-back from approval-service, or a message, starts it again. Pick it, with the ticket, when you want one done now.",
  reviewer:
    "Reviews one submitted change for approval-service: reads the PR, runs the repo's checks at that commit, and approves it or sends it back with the reason.\n\n" +
    "**Started by** approval-service, once for each change submitted to it. A person does not start one by hand.",
  conflict:
    "Rebases one change that no longer applies onto `main`, for approval-service, resolving the conflict so the change can merge.\n\n" +
    "**Started by** approval-service, when a change it is merging conflicts. A person does not start one by hand.",
  investigator:
    "Finds out why a batch of changes failed in approval-service's pipeline (a check, a deploy or a smoke test), and which change caused it, so that change alone is sent back.\n\n" +
    "**Started by** approval-service, when a batch fails. A person does not start one by hand.",
  onboarder:
    "Drafts the release routine (`pipeline.toml` and `jobs.toml` in release-routines) for a repo approval-service has not released before, checks it and writes it, so approval-service can run its first stage and register it.\n\n" +
    "**Started by** approval-service, when someone asks it to onboard a repo (`approval onboard <owner/repo>`). A person does not start one by hand.",
  judge:
    "Judges one proposed change to a shared document in document-service: merges it, or rejects it with the reason.\n\n" +
    "**Started by** document-service, for each proposal a worker makes. A person does not start one by hand.",
};

type Seed = Omit<Role, "updatedAt" | "brief" | "description"> & { name: keyof typeof DESCRIPTIONS; brief?: string };

const seed = (role: Seed): Role => ({ brief: null, updatedAt: null, description: DESCRIPTIONS[role.name], ...role });

/**
 * The roles a stage starts with, as approval-service, document-service,
 * work-tracker and workplace-ui make their workers today. A role written
 * with the same name replaces its seed.
 */
export const SEEDED_ROLES: readonly Role[] = [
  seed({ name: "planner", documents: ["planner"], credentials: null, whenDone: "stop", label: "plan: new work", priority: 40, brief: PLANNER_BRIEF }),
  seed({ name: "reviewer", documents: ["approval"], credentials: ALL, whenDone: "retire", label: "review", priority: 30 }),
  seed({ name: "conflict", documents: [], credentials: ALL, whenDone: "retire", label: "conflict", priority: 30 }),
  seed({ name: "investigator", documents: [], credentials: ALL, whenDone: "retire", label: "investigate", priority: 30 }),
  seed({ name: "onboarder", documents: [], credentials: ALL, whenDone: "retire", label: "onboard", priority: 30 }),
  seed({ name: "judge", documents: [], credentials: ["document-service"], whenDone: "retire", label: "judge", priority: 30 }),
  seed({ name: "implementer", documents: ["tickets"], credentials: null, whenDone: "stop", label: "ticket", priority: 10 }),
];

/**
 * The seeds with those written laid over them by name, highest priority first, then by name.
 * One written before roles had a description has none on record, and takes its seed's.
 */
export function rolesOf(written: (Omit<Role, "description"> & { description?: string | null })[]): Role[] {
  const byName = new Map(SEEDED_ROLES.map((role) => [role.name, role]));
  for (const role of written) byName.set(role.name, { ...role, description: role.description === undefined ? (byName.get(role.name)?.description ?? null) : role.description });
  return [...byName.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}
