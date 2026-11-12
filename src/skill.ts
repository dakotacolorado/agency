import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOf } from "./build.ts";

/** This service's skills, `page` and `title`, served as one. */
export const SKILL_KEY = "agent-service";

/**
 * The clients an agent calls this service with, as written into its
 * `skills/`: `skill/<name>/bin/` and `skill/<name>/reference/` only. When to
 * use them and how to work stay in each `SKILL.md` that document-service's
 * `global` holds.
 */
export const SKILL_DIR = fileURLToPath(new URL("../skill", import.meta.url));
/** Repo-relative, as `generatedFiles` keys it. */
export const REFERENCE_PATH = "skill/page/reference/api.md";
/** What `page` and `title` call; the rest of the API is for people and programs. */
export const REFERENCE_OPERATIONS = ["getAgent", "setAgentStatus", "setAgentTitle"];

export interface SkillFile {
  path: string;
  content: string;
  executable: boolean;
}

export interface Skill {
  key: string;
  version: number;
  commit: string;
  files: SkillFile[];
}

/** Every file under `dir`, as an agent gets it, read from disk at each call. */
export function readSkill(dir: string, version: number, commit: string): Skill {
  const walk = (at: string): string[] =>
    readdirSync(at, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(at, e.name)) : [join(at, e.name)],
    );
  const files = walk(dir)
    .sort()
    .map((file) => ({
      path: `skills/${relative(dir, file).split("\\").join("/")}`,
      content: readFileSync(file, "utf8"),
      // By folder, not mode: a copy need not keep a file's mode.
      executable: relative(dir, file).split("/")[1] === "bin",
    }));
  return { key: SKILL_KEY, version, commit, files };
}

/** This copy's clients, at the commit it was built from. */
export const ownSkill = (): Skill => {
  const { version, commit } = buildOf();
  return readSkill(SKILL_DIR, version, commit);
};

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  description?: string;
  nullable?: boolean;
  format?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  additionalProperties?: Schema | boolean;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};
type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: Schema };
type Operation = {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { description?: string; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema }> }>;
};
type Document = {
  info?: { title?: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};

const METHODS = ["get", "post", "put", "patch", "delete"];
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const refName = (ref: string) => ref.split("/").pop()!;

/** One schema as a short type: a component by name, an enum by its values. */
function type(s: Schema | undefined): string {
  if (!s) return "any";
  if (s.$ref) return `\`${refName(s.$ref)}\``;
  const or = s.anyOf ?? s.oneOf;
  if (or) return or.map(type).join(" or ");
  if (s.allOf) return s.allOf.map(type).join(" and ");
  if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v).replace(/^"|"$/g, "")}\``).join(", ");
  let t: string;
  if (s.type === "array") t = `${type(s.items)}[]`;
  else if (s.type === "object" && s.properties) {
    const required = new Set(s.required ?? []);
    t = `{${Object.entries(s.properties).map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${type(v)}`).join(", ")}}`;
  }
  else if (s.type === "object" && typeof s.additionalProperties === "object") t = `map of ${type(s.additionalProperties)}`;
  else t = [s.type ?? "any"].flat().join(" or ") + (s.format ? ` (${s.format})` : "");
  const limits = [
    s.minLength !== undefined && `min ${s.minLength}`,
    s.maxLength !== undefined && `max ${s.maxLength}`,
    s.maxItems !== undefined && `at most ${s.maxItems}`,
    s.minimum !== undefined && `≥ ${s.minimum}`,
    s.maximum !== undefined && `≤ ${s.maximum}`,
  ].filter(Boolean);
  return t + (limits.length ? ` (${limits.join(", ")})` : "") + (s.nullable ? " or null" : "");
}

function fields(s: Schema): string[] {
  const required = new Set(s.required ?? []);
  return [
    "| Field | Type | |",
    "| --- | --- | --- |",
    ...Object.entries(s.properties ?? {}).map(
      ([name, p]) => `| \`${name}\`${required.has(name) ? "" : "?"} | ${cell(type(p))} | ${cell(p.description ?? "")} |`,
    ),
  ];
}

const body = (content: Record<string, { schema?: Schema }> | undefined) => {
  const schema = content && Object.values(content)[0]?.schema;
  return schema ? type(schema) : null;
};

/**
 * An agent's reference to the API, from its OpenAPI document: each of
 * `operations`, with its parameters, body and answers, then every named schema's fields.
 * Short enough for an agent's context, where the full rendering is not.
 */
export function renderReference(doc: Document, operations: string[] = REFERENCE_OPERATIONS): string {
  const out = [
    `# ${doc.info?.title ?? "API"} API`,
    "",
    `Generated from this deployment's \`openapi.json\`. \`bin/\` adds the address, the bearer token and \`claimed-by\`, so a path is all a call needs. A field marked \`?\` is optional.`,
    "",
  ];
  if (doc.info?.description) out.push(doc.info.description, "");
  const rendered: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId || !operations.includes(op.operationId)) continue;
      rendered.push(op);
      out.push(`## ${method.toUpperCase()} ${path}`, "");
      if (op.summary) out.push(op.summary + ".", "");
      if (op.description) out.push(op.description, "");
      const params = (op.parameters ?? []).filter((p) => p.in !== "header");
      if (params.length) {
        out.push("| Parameter | In | Type | |", "| --- | --- | --- | --- |");
        for (const p of params) {
          out.push(`| \`${p.name}\`${p.required ? "" : "?"} | ${p.in} | ${cell(type(p.schema))} | ${cell(p.description ?? p.schema?.description ?? "")} |`);
        }
        out.push("");
      }
      const sent = body(op.requestBody?.content);
      if (sent) out.push(`Body: ${sent}${op.requestBody?.description ? `. ${op.requestBody.description}` : ""}`, "");
      for (const [status, r] of Object.entries(op.responses ?? {})) {
        const got = body(r.content);
        out.push(`- ${status}: ${r.description ?? ""}${got ? ` → ${got}` : ""}`);
      }
      out.push("");
    }
  }
  const all = doc.components?.schemas ?? {};
  const used = new Set<string>();
  const reach = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(reach);
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref" && typeof v === "string" && !used.has(refName(v))) {
        used.add(refName(v));
        reach(all[refName(v)]);
      } else reach(v);
    }
  };
  reach(rendered);
  const schemas = Object.entries(all).filter(([name]) => used.has(name));
  if (schemas.length) out.push("# Schemas", "");
  for (const [name, s] of schemas) {
    out.push(`## ${name}`, "");
    if (s.description) out.push(s.description, "");
    if (s.allOf) {
      const refs = s.allOf.filter((part) => part.$ref).map(type);
      const own = s.allOf.filter((part) => part.properties);
      if (refs.length) out.push(`Every field of ${refs.join(" and ")}${own.length ? ", and:" : "."}`, "");
      for (const part of own) out.push(...fields(part), "");
    } else out.push(...(s.properties ? fields(s) : [type(s)]), "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
