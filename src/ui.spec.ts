import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentServiceApi } from "./api.ts";
import { FakeStore } from "./fake-store.ts";

const TOKEN = "agent-service-secret";
const file = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the page", () => {
  const api = new AgentServiceApi(new FakeStore(), { value: async () => TOKEN });

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

  it("makes every element from text, so nothing an agent or its transcript says is run as HTML", () => {
    expect(file("ui/app.js")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|eval\(/);
  });

  it("calls only routes the API has", async () => {
    const { paths } = (await (await api.fetch(new Request("http://local/openapi.json"))).json()) as { paths: Record<string, unknown> };
    // Each call's path, as `api("GET", "/agents")` or `api("POST", `/agents/${agent.id}/stop`)` writes it.
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
      "/agents/{id}/resume",
      "/agents/{id}/sessions",
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
