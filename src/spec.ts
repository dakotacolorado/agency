import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NO_TOKEN, SPEC_PATH, WorkerServiceApi } from "./api.ts";
import { REFERENCE_PATH, renderReference } from "./skill.ts";
import { Store } from "./store.ts";

/**
 * Writes `openapi.json` and the docs rendered from it. Committed so clients
 * generate without a deploy and API changes surface in review.
 */
export const repoFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** Fetched through the app, so the file cannot differ from what is served. */
export async function openApiDocument(): Promise<unknown> {
  const api = new WorkerServiceApi(Store.open(":memory:"), NO_TOKEN);
  return (await api.fetch(new Request(`http://local${SPEC_PATH}`))).json();
}

/**
 * Every file rendered from the schema, by repo path. The hook writes these and
 * the drift test compares against them, so the two cannot disagree on how.
 */
export async function generatedFiles(): Promise<Record<string, string>> {
  const doc = await openApiDocument();
  const spec = `${JSON.stringify(doc, null, 2)}\n`;
  const dir = mkdtempSync(join(tmpdir(), "agent-service-spec-"));
  try {
    writeFileSync(join(dir, "openapi.json"), spec);
    const bin = (name: string) => repoFile(`node_modules/.bin/${name}`);
    execFileSync(bin("openapi-to-md"), ["openapi.json", "API.md"], { cwd: dir, stdio: "pipe" });
    execFileSync(bin("redocly"), ["build-docs", "openapi.json", "-o", "index.html"], {
      cwd: dir,
      stdio: "pipe",
    });
    return {
      "openapi.json": spec,
      "docs/API.md": readFileSync(join(dir, "API.md"), "utf8"),
      "docs/index.html": readFileSync(join(dir, "index.html"), "utf8"),
      [REFERENCE_PATH]: renderReference(doc as Parameters<typeof renderReference>[0]),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  for (const [path, content] of Object.entries(await generatedFiles())) {
    writeFileSync(repoFile(path), content);
    console.log(`wrote ${path}`);
  }
}
