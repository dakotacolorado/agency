import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgencyApi } from "./api.ts";
import { FakeStore } from "./fake-store.ts";
import { LETTERS_ONLY, MARK_ICON, MARK_PIXELS, MARK_SVG, SUMMARY, TAGLINE } from "./banner.ts";

const TOKEN = "agency-secret";
const file = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the page", () => {
  const api = new AgencyApi(new FakeStore(), { value: async () => TOKEN });

  it.each([
    ["/", "ui/index.html", "text/html"],
    ["/ui/app.js", "ui/app.js", "text/javascript"],
    ["/ui/style.css", "ui/style.css", "text/css"],
  ])("serves %s without a token, holding none", async (path, source, type) => {
    const res = await api.fetch(new Request(`http://local${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
    const body = await res.text();
    expect(body).toBe(file(source));
    expect(body).not.toContain(TOKEN);
  });

  it("serves banner.ts's mark as the favicon, without a token", async () => {
    const res = await api.fetch(new Request("http://local/ui/mark.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(await res.text()).toBe(MARK_ICON);
    expect(file("ui/index.html")).toContain('<link rel="icon" type="image/svg+xml" href="./ui/mark.svg">');
  });

  it("heads the page with banner.ts's mark, name and tagline", () => {
    expect(file("ui/index.html")).toContain(`<a class="brand" href="#/">${MARK_SVG}agency</a>`);
    expect(file("ui/index.html")).toContain("<title>agency</title>");
  });

  it("gives the page banner.ts's letters, mark, tagline and summary, without a token, so the terminal and the page say the same", async () => {
    const res = await api.fetch(new Request("http://local/ui/banner.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    const body = await res.text();
    expect(body).toContain(`export const LETTERS = ${JSON.stringify(LETTERS_ONLY)};`);
    expect(body).toContain(`export const MARK_PIXELS = ${JSON.stringify(MARK_PIXELS)};`);
    expect(body).toContain(`export const TAGLINE = ${JSON.stringify(TAGLINE)};`);
    expect(body).toContain(`export const SUMMARY = ${JSON.stringify(SUMMARY)};`);
    expect(file("ui/app.js")).toContain('import { LETTERS, MARK_PIXELS, SUMMARY, TAGLINE } from "./banner.js";');
  });

  it("opens the sign-in, and the agents, with the wordmark, tagline, endpoints and docs", () => {
    const app = file("ui/app.js");
    expect(app).toMatch(/\{ class: "signin" \},\s*landing\(false\)/);
    expect(app).toMatch(/main\.replaceChildren\(\s*landing\(true\)/);
    expect(app).toContain('h("a", { href: "./docs/api", target: "_blank" }, "API")');
    expect(app).toContain('h("a", { href: "./docs/mcp", target: "_blank" }, "MCP")');
  });

  it("makes every element from text, so nothing an agent or its transcript says is run as HTML", () => {
    expect(file("ui/app.js")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|eval\(/);
  });

  it("calls only routes the API has", async () => {
    const { paths } = (await (await api.fetch(new Request("http://local/openapi.json"))).json()) as { paths: Record<string, unknown> };
    // Each call's path, as `api("GET", "/agents")` or `api("POST", `/agents/${agent.id}/messages`)` writes it.
    const all = [
      ...new Set(
        [...file("ui/app.js").matchAll(/(?:api|request)\("(?:GET|POST|DELETE)", (["`])(.*?)\1/g)].map((m) =>
          m[2]!.split("?")[0]!.replace(/\$\{[^}]+\}/g, "{id}"),
        ),
      ),
    ];
    expect(all.sort()).toEqual([
      "/agents",
      "/agents/{id}",
      "/agents/{id}/messages",
      "/agents/{id}/stop",
      "/agents/{id}/transcript",
      "/hosts",
      "/requests",
      "/requests/{id}",
      "/roles",
      "/usage",
    ]);
    for (const path of all) expect(Object.keys(paths)).toContain(path);
  });
});
