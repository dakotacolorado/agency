// agent-service's page: agents, an agent's transcript and sessions, a form to make one, requests, hosts, roles and usage, over the API.
// Every element is made with `h`, which sets text, never HTML, so nothing an agent or its transcript says is run.

const TOKEN_KEY = "agent-service.token";
const CLAIMED_BY = "agent-service page";
/** How often an agent's page asks for more of its transcript, and lists for changes. */
const FOLLOW_MS = 2000;
const REFRESH_MS = 5000;
const TRANSCRIPT_PAGE = 500;

const main = document.getElementById("main");
const signout = document.getElementById("signout");

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}

const token = () => localStorage.getItem(TOKEN_KEY);

class ApiError extends Error {
  constructor(status, body) {
    // Errors are moving from `{error}` to `{code, message}`; either reads.
    const said = body?.message ?? body?.error;
    super(typeof said === "string" ? said : said ? JSON.stringify(said) : `HTTP ${status}`);
    this.status = status;
  }
}

/** One API call, relative to this page. A 401 forgets the token and asks for another. */
async function request(method, path, { body, headers = {} } = {}) {
  const res = await fetch(path.replace(/^\//, ""), {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    route();
    throw new ApiError(401, { message: "That is not this agent-service's token." });
  }
  return res;
}

async function api(method, path, body, headers) {
  const res = await request(method, path, { body, headers });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const short = (id) => id.slice(0, 8);
const errorBox = () => h("div", { class: "error", hidden: true });
const show = (box, err) => {
  box.hidden = false;
  box.textContent = err.message;
};
const note = (box, text) => {
  box.hidden = false;
  box.textContent = text;
};
const badge = (value) => (value ? h("span", { class: `state ${value}` }, value) : h("span", { class: "muted" }, "none"));
const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const tokens = (t) =>
  t ? `${count(t.inputTokens)} in, ${count(t.outputTokens)} out, ${count(t.cacheReadInputTokens)} cache read, ${count(t.cacheCreationInputTokens)} cache written` : "";
/** What it last said or did, whichever is newer: its `summary` by `saidAt`, or its `activity` by `at`. */
function latest(agent) {
  const said = agent.summary ? { text: agent.summary, at: agent.saidAt } : null;
  const did = agent.activity;
  if (said && did) return Date.parse(said.at ?? 0) >= Date.parse(did.at) ? said : did;
  return said ?? did ?? null;
}
const agentLink = (agent) => h("a", { href: `#/agents/${agent.id}` }, agent.name);
const hostCell = (agent) => [h("span", { class: "mono" }, agent.hostId), " ", badge(agent.hostStatus)];
const checkbox = (checked, onchange) => h("input", { type: "checkbox", checked, onchange });
const quiet = "margin:0;text-transform:none;letter-spacing:0;font-size:13px;display:inline";

/**
 * What the page is showing, so a timer a page left behind stops: each draw
 * takes a new generation, and a timer whose generation is not the current
 * one does nothing more.
 */
let generation = 0;
const current = () => {
  const mine = ++generation;
  return () => mine === generation;
};
const every = (ms, live, fn) => {
  const tick = async () => {
    if (!live()) return;
    try {
      await fn();
    } catch {
      // A dropped poll is retried.
    }
    if (live()) setTimeout(tick, ms);
  };
  setTimeout(tick, ms);
};

function signIn() {
  current();
  signout.hidden = true;
  const input = h("input", { type: "password", placeholder: "AUTH_TOKEN", style: "width:100%", autocomplete: "off" });
  const box = errorBox();
  const form = h(
    "form",
    {
      class: "panel",
      onsubmit: async (event) => {
        event.preventDefault();
        localStorage.setItem(TOKEN_KEY, input.value.trim());
        try {
          await api("GET", "/usage");
          route();
        } catch (err) {
          show(box, err);
        }
      },
    },
    h("h2", {}, "Sign in"),
    h("p", { class: "muted" }, "Paste this stage's token, its AUTH_TOKEN. It stays in this browser."),
    input,
    box,
    h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Sign in")),
  );
  main.replaceChildren(
    h(
      "div",
      { class: "signin" },
      h("h1", {}, "agent-service"),
      h("p", { class: "muted" }, "Agents, their sessions, the requests that start them and the hosts they run on. The API is at ", h("code", {}, `${location.origin}/agents`), ", the MCP server at ", h("code", {}, `${location.origin}/mcp`), "."),
      form,
    ),
  );
  input.focus();
}

/** A table with a header and a body `draw` refills; `empty` is what an empty list says. */
function table(columns, empty) {
  const body = h("tbody");
  const el = h("table", {}, h("thead", {}, h("tr", {}, columns.map((name) => h("th", {}, name)))), body);
  const draw = (rows) =>
    body.replaceChildren(...(rows.length ? rows : [h("tr", {}, h("td", { colspan: columns.length, class: "muted" }, empty))]));
  return { el, draw };
}

async function agents(params) {
  const live = current();
  const all = params.get("all") === "true";
  const load = () => (all ? api("GET", "/agents?all=true") : api("GET", "/agents"));
  const { agents: list } = await load();
  if (!live()) return;
  const counted = h("span", { class: "muted" });
  const { el, draw } = table(["Agent", "Status", "Doing", "Host", "Role", "Tokens"], all ? "No agents." : "No agents but retired ones.");
  const fill = (rows) => {
    counted.textContent = `${rows.length} agent${rows.length === 1 ? "" : "s"}`;
    draw(
      rows.map((agent) => {
        const last = latest(agent);
        return h(
          "tr",
          {},
          h("td", {}, agentLink(agent), agent.title ? h("div", { class: "muted" }, agent.title) : ""),
          h("td", {}, agent.state === "retired" ? badge("retired") : badge(agent.status)),
          h("td", {}, last ? [h("span", { class: "text" }, last.text), h("div", { class: "muted" }, when(last.at))] : ""),
          h("td", {}, hostCell(agent)),
          h("td", {}, agent.role ?? ""),
          h("td", { class: "muted" }, tokens(agent.tokens)),
        );
      }),
    );
  };
  fill(list);
  main.replaceChildren(
    h("div", { class: "filters" }, h("label", { style: quiet }, checkbox(all, (e) => (location.hash = e.target.checked ? "#/?all=true" : "#/")), " include retired"), counted),
    el,
  );
  every(REFRESH_MS, live, async () => {
    const { agents: rows } = await load();
    if (live()) fill(rows);
  });
}

async function agentPage(id) {
  const live = current();
  let agent = await api("GET", `/agents/${id}`);
  if (!live()) return;
  const box = errorBox();
  const done = h("div", { class: "note", hidden: true });
  const head = h("div", { class: "panel" });
  const act = (label, cls, fn) =>
    h(
      "button",
      {
        class: cls,
        onclick: async () => {
          box.hidden = true;
          try {
            const said = await fn();
            if (said === undefined) return;
            note(done, said);
            agent = await api("GET", `/agents/${agent.id}`);
            drawHead();
          } catch (err) {
            show(box, err);
          }
        },
      },
      label,
    );
  const drawHead = () => {
    const last = latest(agent);
    const retired = agent.state === "retired";
    const fields = [
      ["Id", h("span", { class: "mono" }, agent.id)],
      agent.title && ["Title", agent.title],
      ["Status", badge(agent.status)],
      ["State", `${agent.state}${agent.tasks ? `, ${agent.tasks} background task${agent.tasks === 1 ? "" : "s"}` : ""}`],
      agent.headline && ["Headline", agent.headline],
      agent.summary && ["Summary", h("span", { class: "text" }, agent.summary, h("span", { class: "muted" }, ` (${when(agent.saidAt)})`))],
      agent.activity && ["Activity", [agent.activity.text, h("span", { class: "muted" }, ` (${when(agent.activity.at)})`)]],
      ["Host", hostCell(agent)],
      ["Role", agent.role ?? "none"],
      agent.label && ["Label", agent.label],
      agent.item && ["Item", h("span", { class: "mono" }, agent.item)],
      ["When done", agent.whenDone],
      ["Skills", agent.skills.length ? agent.skills.join(", ") : "none"],
      ["Tokens", tokens(agent.tokens)],
      ["Session", agent.session ? [h("span", { class: "mono" }, short(agent.session.id)), `, since ${when(agent.session.startedAt)}`] : "none live"],
      ["Made by", agent.createdBy ?? "unknown"],
      ["Made", when(agent.createdAt)],
      agent.reportedAt && ["Reported", when(agent.reportedAt)],
    ].filter(Boolean);
    head.replaceChildren(
      h("h1", {}, agent.name),
      h("div", { class: "muted" }, last ? last.text : ""),
      h(
        "div",
        { class: "row" },
        !retired && act("Stop", "", async () => (await api("POST", `/agents/${agent.id}/stop`), "Stop queued.")),
        !retired && act("Resume", "", async () => (await api("POST", `/agents/${agent.id}/resume`), "Resume queued.")),
        !retired &&
          act("Retire", "danger", async () => {
            if (!confirm(`Retire ${agent.name}? Its session ends and its name is freed; this cannot be undone.`)) return undefined;
            await api("DELETE", `/agents/${agent.id}`);
            return "Retired.";
          }),
      ),
      box,
      done,
      h("dl", { class: "fields" }, fields.flatMap(([name, value]) => [h("dt", {}, name), h("dd", {}, value)])),
    );
  };
  drawHead();

  const text = h("textarea", { placeholder: "A message to the agent" });
  const interrupt = h("input", { type: "checkbox" });
  const sendBox = errorBox();
  const sent = h("div", { class: "note", hidden: true });
  const message = h(
    "form",
    {
      class: "panel",
      onsubmit: async (e) => {
        e.preventDefault();
        sendBox.hidden = sent.hidden = true;
        const said = text.value.trim();
        const body = interrupt.checked ? { ...(said && { text: said }), interrupt: true } : { text: said };
        try {
          await api("POST", `/agents/${agent.id}/messages`, body);
          text.value = "";
          interrupt.checked = false;
          note(sent, "Queued for its host.");
        } catch (err) {
          show(sendBox, err);
        }
      },
    },
    h("h2", {}, "Message"),
    text,
    sendBox,
    sent,
    h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Send"), h("label", { style: quiet }, interrupt, " interrupt its turn first")),
  );

  const sessionsPanel = h("div", { class: "panel" }, h("h2", {}, "Sessions"));
  const drawSessions = ({ sessions }) => {
    const { el, draw } = table(["Session", "Started", "Ended", "Skills", "Clients", "Note"], "No sessions yet.");
    draw(
      sessions.map((s) =>
        h(
          "tr",
          {},
          h("td", { class: "mono" }, short(s.id)),
          h("td", {}, when(s.startedAt)),
          h("td", {}, s.endedAt ? `${when(s.endedAt)}${s.ended ? `, ${s.ended}` : ""}` : "live"),
          h("td", { class: "mono" }, s.skills.map((k) => `${k.name} v${k.version}`).join(", ") || "none"),
          h("td", { class: "mono" }, s.clients ? short(s.clients.commit) : "none"),
          h("td", { class: "text" }, s.contextNote ?? ""),
        ),
      ),
    );
    sessionsPanel.replaceChildren(h("h2", {}, "Sessions"), el);
  };

  const lines = h("div", { class: "transcript" });
  const status = h("span", { class: "muted" });
  const follow = h("input", { type: "checkbox", checked: true });
  let cursor = null;
  let session = null;
  let seen = 0;
  /** Reads the transcript on from `cursor`, and says whether a full page came back, so more may be waiting. */
  const more = async () => {
    const query = new URLSearchParams({ limit: String(TRANSCRIPT_PAGE), ...(cursor && { after: cursor }) });
    const read = await api("GET", `/agents/${agent.id}/transcript?${query}`);
    cursor = read.next;
    if (read.lines.length) {
      const atBottom = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 24;
      for (const line of read.lines) {
        if (line.sessionId !== session) {
          session = line.sessionId;
          lines.append(h("div", { class: "session" }, `session ${short(session)}`));
        }
        lines.append(h("div", { class: `line ${line.from}` }, h("span", { class: "at" }, new Date(line.at).toLocaleTimeString()), line.text));
      }
      seen += read.lines.length;
      if (follow.checked && atBottom) lines.scrollTop = lines.scrollHeight;
    }
    status.textContent = `${seen} line${seen === 1 ? "" : "s"}, following`;
    return read.lines.length === TRANSCRIPT_PAGE;
  };

  main.replaceChildren(
    head,
    message,
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Transcript"),
      h("div", { class: "row", style: "margin:0 0 8px" }, status, h("label", { style: quiet }, follow, " keep at the end")),
      lines,
    ),
    sessionsPanel,
  );
  drawSessions(await api("GET", `/agents/${agent.id}/sessions`));
  while (live() && (await more()));
  every(FOLLOW_MS, live, async () => {
    while (live() && (await more()));
  });
  every(REFRESH_MS, live, async () => {
    const next = await api("GET", `/agents/${agent.id}`);
    if (!live()) return;
    if (JSON.stringify(next) !== JSON.stringify(agent)) {
      agent = next;
      drawHead();
    }
    drawSessions(await api("GET", `/agents/${agent.id}/sessions`));
  });
}

const select = (options, blank) => h("select", {}, blank && h("option", { value: "" }, blank), options.map(([value, text]) => h("option", { value }, text)));

async function newAgent() {
  const live = current();
  const [{ hosts }, { roles }] = await Promise.all([api("GET", "/hosts"), api("GET", "/roles")]);
  if (!live()) return;
  const name = h("input", { required: true, pattern: "[a-z0-9][a-z0-9\\-]{0,39}", placeholder: "frontend-1", style: "width:100%" });
  const host = select(
    hosts.map((each) => [each.id, `${each.id} (${each.status}${each.available !== null ? `, ${each.available} free` : ""})`]),
    "any connected host with room",
  );
  const role = select(roles.map((each) => [each.name, `${each.name}: ${each.label}`]), "none");
  const brief = h("textarea", { placeholder: "The first session's first message. Empty, the role's own, if it has one." });
  const box = errorBox();
  main.replaceChildren(
    h(
      "form",
      {
        class: "panel",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const made = await api(
              "POST",
              "/agents",
              {
                name: name.value.trim(),
                ...(host.value && { hostId: host.value }),
                ...(role.value && { role: role.value }),
                ...(brief.value.trim() && { brief: brief.value.trim() }),
              },
              { "claimed-by": CLAIMED_BY },
            );
            location.hash = `#/agents/${made.id}`;
          } catch (err) {
            show(box, err);
          }
        },
      },
      h("h1", {}, "New agent"),
      h("p", { class: "muted" }, "Made at once on its host, without waiting its turn among requests. To wait for room, ask for one under Requests."),
      h("label", {}, "Name"), name,
      h("div", { class: "grid2" }, h("div", {}, h("label", {}, "Host"), host), h("div", {}, h("label", {}, "Role"), role)),
      h("label", {}, "Brief"), brief,
      box,
      h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Make it")),
    ),
  );
  name.focus();
}

async function requests() {
  const live = current();
  const load = () => api("GET", "/requests?all=true");
  const [{ requests: list }, { roles }] = await Promise.all([load(), api("GET", "/roles")]);
  if (!live()) return;
  const box = errorBox();
  const { el, draw } = table(["Request", "State", "Position", "Why", "Role", "For", "Brief", "Asked by", "Asked"], "No requests.");
  const fill = (rows) =>
    draw(
      rows.map((r) =>
        h(
          "tr",
          {},
          h("td", { class: "mono" }, r.agentId ? h("a", { href: `#/agents/${r.agentId}` }, short(r.id)) : short(r.id)),
          h("td", {}, badge(r.state)),
          h("td", {}, r.position ?? ""),
          h("td", { class: "text" }, r.why ?? ""),
          h("td", {}, r.role),
          h("td", {}, r.subject ?? (r.item ? h("span", { class: "mono" }, short(r.item)) : ""), r.label ? h("div", { class: "muted" }, r.label) : ""),
          h("td", { class: "text" }, r.brief ? (r.brief.length > 200 ? `${r.brief.slice(0, 200)}…` : r.brief) : h("span", { class: "muted" }, "the role's")),
          h("td", {}, r.requester ?? ""),
          h(
            "td",
            {},
            when(r.createdAt),
            r.state === "waiting" &&
              h(
                "div",
                {},
                h(
                  "button",
                  {
                    class: "danger",
                    onclick: async () => {
                      try {
                        await api("DELETE", `/requests/${r.id}`);
                        fill((await load()).requests);
                      } catch (err) {
                        show(box, err);
                      }
                    },
                  },
                  "Withdraw",
                ),
              ),
          ),
        ),
      ),
    );
  fill(list);

  const role = select(roles.map((each) => [each.name, `${each.name}: ${each.label}`]));
  role.required = true;
  const brief = h("textarea", { placeholder: "The first message. Empty, the role's own; a role without one needs it." });
  const askBox = errorBox();
  const form = h(
    "form",
    {
      class: "panel",
      onsubmit: async (e) => {
        e.preventDefault();
        askBox.hidden = true;
        try {
          await api("POST", "/requests", { role: role.value, ...(brief.value.trim() && { brief: brief.value.trim() }) }, { "claimed-by": CLAIMED_BY });
          brief.value = "";
          fill((await load()).requests);
        } catch (err) {
          show(askBox, err);
        }
      },
    },
    h("h2", {}, "Ask for an agent"),
    h("p", { class: "muted" }, "It waits its turn, by its role's priority, until a host has room and usage allows."),
    h("label", {}, "Role"), role,
    h("label", {}, "Brief"), brief,
    askBox,
    h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Ask")),
  );
  main.replaceChildren(form, box, el);
  every(REFRESH_MS, live, async () => {
    const { requests: rows } = await load();
    if (live()) fill(rows);
  });
}

async function hosts() {
  const live = current();
  const load = () => api("GET", "/hosts");
  const { hosts: list } = await load();
  if (!live()) return;
  const { el, draw } = table(["Host", "Status", "Capacity", "Available", "Labels", "Version", "Heartbeat"], "No host has registered.");
  const fill = (rows) =>
    draw(
      rows.map((host) =>
        h(
          "tr",
          {},
          h("td", { class: "mono" }, host.id),
          h("td", {}, badge(host.status)),
          h("td", {}, host.capacity ?? ""),
          h("td", {}, host.available ?? ""),
          h("td", { class: "mono" }, host.labels.join(", ")),
          h("td", {}, host.version ?? ""),
          h("td", {}, when(host.heartbeatAt)),
        ),
      ),
    );
  fill(list);
  main.replaceChildren(el);
  every(REFRESH_MS, live, async () => {
    const { hosts: rows } = await load();
    if (live()) fill(rows);
  });
}

async function roles() {
  const live = current();
  const load = () => api("GET", "/roles");
  const { roles: list } = await load();
  if (!live()) return;
  const { el, draw } = table(["Role", "Priority", "Label", "When done", "Skills", "Description"], "No roles.");
  const fill = (rows) =>
    draw(
      rows.map((role) =>
        h(
          "tr",
          {},
          h("td", { class: "mono" }, role.name),
          h("td", {}, role.priority),
          h("td", {}, role.label),
          h("td", {}, role.whenDone),
          h("td", { class: "mono" }, role.skills.join(", ")),
          h("td", { class: "text" }, role.description ?? ""),
        ),
      ),
    );
  fill(list);
  main.replaceChildren(el);
  every(REFRESH_MS, live, async () => {
    const { roles: rows } = await load();
    if (live()) fill(rows);
  });
}

function windowPanel(title, reading) {
  if (!reading) return h("div", { class: "panel" }, h("h2", {}, title), h("p", { class: "muted" }, "Nothing reported yet."));
  const percent = Math.round(reading.utilization * 100);
  const past = Date.parse(reading.resetsAt) < Date.now();
  return h(
    "div",
    { class: "panel" },
    h("h2", {}, title),
    h("h1", {}, `${percent}%`, past ? h("span", { class: "muted" }, " (reset since)") : ""),
    h("div", { class: `meter${percent >= 90 ? " high" : ""}` }, h("div", { style: `width:${Math.min(percent, 100)}%` })),
    h(
      "dl",
      { class: "fields" },
      h("dt", {}, "Resets"), h("dd", {}, when(reading.resetsAt)),
      h("dt", {}, "Read"), h("dd", {}, when(reading.readAt)),
      h("dt", {}, "From"), h("dd", { class: "mono" }, reading.hostId),
    ),
  );
}

async function usage() {
  const live = current();
  const load = () => api("GET", "/usage");
  const view = h("div");
  const fill = (u) =>
    view.replaceChildren(
      h("div", { class: "grid2" }, windowPanel("5-hour window", u.fiveHour), windowPanel("Weekly window", u.sevenDay)),
      h("p", { class: "muted" }, u.readAt ? `Last read ${when(u.readAt)}.` : "No host has reported usage."),
    );
  fill(await load());
  if (!live()) return;
  main.replaceChildren(view);
  every(REFRESH_MS, live, async () => {
    const u = await load();
    if (live()) fill(u);
  });
}

async function route() {
  if (!token()) return signIn();
  signout.hidden = false;
  const [path, search = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(search);
  try {
    const agent = /^\/agents\/([0-9a-f-]{36})$/.exec(path ?? "");
    if (agent) await agentPage(agent[1]);
    else if (path === "/new") await newAgent();
    else if (path === "/requests") await requests();
    else if (path === "/hosts") await hosts();
    else if (path === "/roles") await roles();
    else if (path === "/usage") await usage();
    else await agents(params);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    main.replaceChildren(h("div", { class: "panel error" }, err.message));
  }
}

signout.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  route();
});
window.addEventListener("hashchange", route);
fetch("health")
  .then((res) => res.json())
  .then((about) => (document.getElementById("about").textContent = `v${about.version} · ${about.commit.slice(0, 7)}`))
  .catch(() => {});
route();
