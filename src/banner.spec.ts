import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "./build.ts";
import { banner, MARK_ICON, MARK_PIXELS, TAGLINE, WORDMARK } from "./banner.ts";

const info = { version: "1.2.3", url: "http://127.0.0.1:4600", publicUrl: "https://beta:8446", db: "/data/agency.db", services: ["agency", "waypoint"], missing: [], color: false };

describe("banner", () => {
  it("carries the person's tagline verbatim", () => {
    expect(TAGLINE).toBe("Agents at your command, across all your computers.");
  });

  it("sets the mark beside the letters, a row of text for each two of pixels", () => {
    expect(MARK_PIXELS).toHaveLength(12);
    expect(new Set(MARK_PIXELS.map((row) => row.length))).toEqual(new Set([18]));
    expect(WORDMARK.split("\n")).toHaveLength(6);
    expect(WORDMARK.split("\n")[0]).toMatch(/^ █████╗  ██████╗ .* +▄▄██▄▄$/);
  });

  it("says what agency is, where its page, API and MCP are at the public address, and what its sessions may be given", () => {
    expect(banner(info).split("\n")).toEqual([
      "",
      ...WORDMARK.split("\n"),
      "v1.2.3",
      "",
      TAGLINE,
      "Agents, their sessions, the requests that start them and the hosts they run on.",
      "",
      "  ▸ Page      https://beta:8446/",
      "  ▸ API       https://beta:8446/agents   docs https://beta:8446/docs/api",
      "  ▸ MCP       https://beta:8446/mcp      docs https://beta:8446/docs/mcp",
      "",
      "  sessions may be given: agency, waypoint",
      "  listening on http://127.0.0.1:4600, data in /data/agency.db",
      "  Ctrl+C to stop.",
      "",
    ]);
  });

  it("says when AUTH_TOKEN is not set", () => {
    expect(banner({ ...info, missing: ["AUTH_TOKEN"] })).toContain("\nAUTH_TOKEN not set: every call but /health answers 503\n");
  });

  it("is painted in agency's brass only when color is on", () => {
    expect(banner(info)).not.toContain("\x1b");
    expect(banner({ ...info, color: true })).toContain("\x1b[38;5;178m");
  });

  it("gives the tab a brass mark in its light and dark", () => {
    expect(MARK_ICON).toContain("--ink:#7f5d00");
    expect(MARK_ICON).toContain("prefers-color-scheme:dark");
  });

  it("is in the README as agency prints it, starting locally", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const local = "http://127.0.0.1:4600";
    const printed = banner({ ...info, url: local, publicUrl: local, db: "~/.local/share/agency/agency.db", services: ["agency"], version: PACKAGE_VERSION });
    expect(readme).toContain(`**${TAGLINE}**`);
    expect(readme).toContain(`\`\`\`\n${printed.replace(/^\n+|\n+$/g, "")}\n\`\`\``);
  });
});
