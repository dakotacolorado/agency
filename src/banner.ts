/** agency's mark: its name in block letters beside the mark, a bureau: a pediment over a row of columns, each column an agent holding the agency up. */

const LETTERS = [
  " █████╗  ██████╗ ███████╗███╗   ██╗ ██████╗██╗   ██╗",
  "██╔══██╗██╔════╝ ██╔════╝████╗  ██║██╔════╝╚██╗ ██╔╝",
  "███████║██║  ███╗█████╗  ██╔██╗ ██║██║      ╚████╔╝",
  "██╔══██║██║   ██║██╔══╝  ██║╚██╗██║██║       ╚██╔╝",
  "██║  ██║╚██████╔╝███████╗██║ ╚████║╚██████╗   ██║",
  "╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝ ╚═════╝   ╚═╝",
];

/**
 * The mark on an 18 by 12 grid: a pediment, its architrave, four columns and
 * a stepped base. A terminal draws two rows a character, so it stands as
 * many rows as the letters.
 */
export const MARK_PIXELS = [
  "........##........",
  "......######......",
  "....##########....",
  "..##############..",
  ".################.",
  "..................",
  "..##..##..##..##..",
  "..##..##..##..##..",
  "..##..##..##..##..",
  "..##..##..##..##..",
  ".################.",
  "##################",
];

/** The mark as text, two pixels a character, for terminals; the page draws MARK_PIXELS as an image instead. */
const MARK = Array.from({ length: MARK_PIXELS.length / 2 }, (_, row) =>
  [...MARK_PIXELS[row * 2]!]
    .map((top, col) => {
      const t = top === "#", b = MARK_PIXELS[row * 2 + 1]![col] === "#";
      return t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    })
    .join("")
    .trimEnd(),
);

/** The letters alone, for the page, which sets the mark beside them as an image. */
export const LETTERS_ONLY = LETTERS.join("\n");

const WIDTH = Math.max(...LETTERS.map((line) => line.length));
export const WORDMARK = LETTERS.map((line, i) => `${line.padEnd(WIDTH)}  ${MARK[i]}`.trimEnd()).join("\n");

/** The person's line for agency, verbatim. */
export const TAGLINE = "Agents at your command, across all your computers.";
/** What agency is, in one line. Every place that describes agency in a line uses this or TAGLINE, verbatim. */
export const SUMMARY = "Agents, their sessions, the requests that start them and the hosts they run on.";

/** The pixel mark as an SVG drawn from its grid, in the current color. */
export const MARK_PIXEL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="0 0 ${MARK_PIXELS[0]!.length} ${MARK_PIXELS.length}" shape-rendering="crispEdges" fill="currentColor">${MARK_PIXELS.flatMap((row, y) =>
  [...row].flatMap((pixel, x) => (pixel === "#" ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])),
).join("")}</svg>`;

/** The mark drawn smooth: `ink` strokes it, `ground` fills the pediment. `viewBox` squares it for an icon. */
const smoothMark = (ink: string, ground: string, width: number, viewBox: string, style = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="${viewBox}">${style}<g fill="none" stroke="${ink}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"><path d="M20 2L37 11H3Z" fill="${ground}"/><path d="M4 14.5H36M8 18V25M16 18V25M24 18V25M32 18V25M4 28H36M2 31H38"/></g></svg>`;

/** The smooth mark in the page's colors, for its header. */
export const MARK_SVG = smoothMark("currentColor", "var(--panel)", 2, "0 0 40 32");

/** The mark as the page's favicon: square, stroked heavier so it reads at 16 pixels, brass on the tab's light or dark. */
export const MARK_ICON = smoothMark(
  "var(--ink)",
  "var(--ground)",
  3,
  "0 -4 40 40",
  "<style>svg{--ink:#7f5d00;--ground:#fff}@media (prefers-color-scheme:dark){svg{--ink:#e2b84f;--ground:#161615}}</style>",
);

/** Colors only for a terminal that wants them (https://no-color.org). agency's is brass, beside honed's teal, waypoint's terracotta and jobber's violet. */
export function palette(enabled: boolean) {
  const paint = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { mark: paint("38;5;178"), bold: paint("1"), dim: paint("2") };
}

export interface BannerInfo {
  version: string;
  /** Where it listens. */
  url: string;
  /** Where people, agents and hosts reach it: its public HTTPS address behind a proxy, else `url`. */
  publicUrl: string;
  db: string;
  /** The services its sessions may be given, this one first. */
  services: string[];
  /** The role it picks up waypoint's ready tasks in; null for none. */
  pickUp: string | null;
  /** AUTH_TOKEN, when it is not set: what answers 503 until it is. */
  missing: string[];
  color: boolean;
}

/** What agency says when it starts: what it is, where each part is, what its sessions are given, and what is not set. */
export function banner(b: BannerInfo): string {
  const c = palette(b.color);
  return [
    "",
    c.mark(WORDMARK),
    c.dim(`v${b.version}`),
    "",
    c.bold(TAGLINE),
    SUMMARY,
    "",
    `  ${c.mark("▸")} Page      ${b.publicUrl}/`,
    `  ${c.mark("▸")} API       ${b.publicUrl}/agents   docs ${b.publicUrl}/docs/api`,
    `  ${c.mark("▸")} MCP       ${b.publicUrl}/mcp      docs ${b.publicUrl}/docs/mcp`,
    "",
    ...(b.missing.length ? [c.bold(`${b.missing.join(" and ")} not set: every call but /health answers 503`), ""] : []),
    `  ${c.dim(`sessions may be given: ${b.services.join(", ")}`)}`,
    ...(b.pickUp ? [`  ${c.dim(`picking up waypoint's ready tasks as ${b.pickUp}`)}`] : []),
    `  ${c.dim(`listening on ${b.url}, data in ${b.db}`)}`,
    `  ${c.dim("Ctrl+C to stop.")}`,
    "",
  ].join("\n");
}
