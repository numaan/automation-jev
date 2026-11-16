import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A form field or button used to sign in: a CSS path to act on, and the script locator. */
export interface KbField {
  css: string;
  src: string;
}
/** How to sign in again. Holds env var NAMES, never secret values. */
export interface KbLogin {
  type: "role" | "password";
  label: string;
  roleLabel?: string;
  loginUrl?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  username?: KbField;
  password?: KbField;
  submit?: KbField;
}

/** A table or grid on a screen. Values are samples: live data changes between runs. */
export interface KbTable {
  title: string;
  columns: string[];
  rowCount: number;
  sampleRows: string[][];
  /** Message shown instead of rows ("No matches"), when the table is empty. */
  emptyText?: string;
}
/** A KPI card: one label, one number. */
export interface KbCard {
  label: string;
  value: string;
  note?: string;
}
/** A chart. Bar and line values are not in the DOM; only labels and legend text are. */
export interface KbChart {
  label: string;
  kind: "svg" | "canvas";
  legend: string[];
  text: string[];
  description: string;
}
/** The data a screen displays. */
export interface KbData {
  tables: KbTable[];
  cards: KbCard[];
  charts: KbChart[];
  /** Chips, badges and status text with how often each appears. */
  labels: { text: string; count: number }[];
}

/** What the explorer learned about one screen of the app. */
export interface KbControl {
  kind: string; // click | fill | select
  role: string;
  name: string;
  inputType?: string;
  placeholder?: string;
  href?: string;
  options?: string[];
}
export interface KbLink {
  text: string;
  href: string; // path + search, e.g. "/agents?tab=mine"
}
export interface KbScreen {
  id: string; // same as href
  href: string;
  title: string;
  heading: string;
  subheadings: string[];
  links: KbLink[]; // links specific to this screen (shell links removed)
  controls: KbControl[]; // controls specific to this screen (shell removed)
  data?: KbData; // tables, cards, charts and labels shown on the screen
  via?: string; // screen id where the explorer found the link
  consoleErrors: number;
  failedRequests: number;
}
/** The whole app, for one role. This JSON is the tool's "memory" of the flow. */
export interface Knowledge {
  app: string;
  origin: string;
  role: string;
  generatedAt: string;
  login: KbLogin | null;
  /** Links and controls that appear on most screens (sidebar, header). */
  shell: { links: KbLink[]; controls: KbControl[] };
  screens: KbScreen[];
}

export function saveKnowledge(path: string, kb: Knowledge) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(kb, null, 2) + "\n", "utf8");
}
export function loadKnowledge(path: string): Knowledge {
  return JSON.parse(readFileSync(path, "utf8")) as Knowledge;
}

/** Link/control identity used to find what repeats on most screens. */
const sig = (c: { role?: string; name?: string; href?: string; text?: string }) =>
  [c.role ?? "link", c.name ?? c.text ?? "", c.href ?? ""].join("|");

/** Move links and controls that repeat on >= 80% of screens into `shell`. */
export function factorShell(
  screens: KbScreen[]
): { shell: Knowledge["shell"]; screens: KbScreen[] } {
  const n = screens.length;
  const min = Math.max(3, Math.ceil(n * 0.8));
  const linkCount = new Map<string, number>();
  const ctlCount = new Map<string, number>();
  for (const s of screens) {
    for (const k of new Set(s.links.map((l) => sig({ text: l.text, href: l.href })))) {
      linkCount.set(k, (linkCount.get(k) ?? 0) + 1);
    }
    for (const k of new Set(s.controls.map(sig))) ctlCount.set(k, (ctlCount.get(k) ?? 0) + 1);
  }
  const isShellLink = (l: KbLink) => (linkCount.get(sig({ text: l.text, href: l.href })) ?? 0) >= min;
  const isShellCtl = (c: KbControl) => (ctlCount.get(sig(c)) ?? 0) >= min;
  const shell: Knowledge["shell"] = { links: [], controls: [] };
  const seenL = new Set<string>();
  const seenC = new Set<string>();
  for (const s of screens) {
    for (const l of s.links)
      if (isShellLink(l) && !seenL.has(sig({ text: l.text, href: l.href }))) {
        seenL.add(sig({ text: l.text, href: l.href }));
        shell.links.push(l);
      }
    for (const c of s.controls)
      if (isShellCtl(c) && !seenC.has(sig(c))) {
        seenC.add(sig(c));
        shell.controls.push(c);
      }
  }
  return {
    shell,
    screens: screens.map((s) => ({
      ...s,
      links: s.links.filter((l) => !isShellLink(l)),
      controls: s.controls.filter((c) => !isShellCtl(c)),
    })),
  };
}

/**
 * Shortest click path between two screens. Shell links (sidebar) are reachable from
 * everywhere, so most paths are one click. Returns the hrefs to click, in order.
 */
export function findPath(kb: Knowledge, fromId: string | null, toId: string): string[] | null {
  if (fromId === toId) return [];
  const screens = new Map(kb.screens.map((s) => [s.id, s]));
  const edgesOf = (id: string): KbLink[] => [...(screens.get(id)?.links ?? []), ...kb.shell.links];
  const start = fromId ?? "";
  const prev = new Map<string, { from: string; href: string }>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const l of edgesOf(cur)) {
      if (!screens.has(l.href) || seen.has(l.href)) continue;
      seen.add(l.href);
      prev.set(l.href, { from: cur, href: l.href });
      if (l.href === toId) {
        const out: string[] = [];
        let at = toId;
        while (at !== start) {
          const p = prev.get(at)!;
          out.unshift(p.href);
          at = p.from;
        }
        return out;
      }
      queue.push(l.href);
    }
  }
  return null;
}

/** One short paragraph the model reads to decide whether a step belongs on a screen. */
export function describeScreen(s: KbScreen): string {
  const parts = [`screen ${s.href}`, `heading "${s.heading}"`, `title "${s.title}"`];
  if (s.subheadings.length) parts.push(`sections: ${s.subheadings.slice(0, 8).join("; ")}`);
  const links = s.links.slice(0, 8).map((l) => l.text).filter(Boolean);
  if (links.length) parts.push(`links: ${links.join("; ")}`);
  const ctl = s.controls.slice(0, 10).map((c) => c.name).filter(Boolean);
  if (ctl.length) parts.push(`controls: ${ctl.join("; ")}`);
  const d = s.data;
  if (d) {
    const t = d.tables.slice(0, 4).map((x) => `${x.title || "table"} (${x.columns.slice(0, 6).join(", ")})`);
    if (t.length) parts.push(`tables: ${t.join("; ")}`);
    const ch = d.charts.map((x) => x.label).filter(Boolean).slice(0, 4);
    if (ch.length) parts.push(`charts: ${ch.join("; ")}`);
    const cd = d.cards.map((x) => x.label).slice(0, 6);
    if (cd.length) parts.push(`cards: ${cd.join("; ")}`);
  }
  return parts.join(" | ").slice(0, 900);
}

/** Escape text for use inside a RegExp source. */
const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Locator source for the role button on a "sign in as a role" screen. */
export function loginLocatorSource(role: string): string {
  return `page.getByRole("button", { name: new RegExp(${JSON.stringify("^" + reEsc(role))}) })`;
}

