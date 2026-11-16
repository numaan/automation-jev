import type { Page } from "playwright";
import { extractData } from "./data.js";
import type { KbData, KbTable } from "./knowledge.js";

/** A criterion about displayed data: a table, a card or a chart. */
export type DataCriterion =
  | { kind: "columns"; table: string | null; columns: string[] }
  | { kind: "rows"; table: string | null; op: "atLeast" | "atMost" | "exactly"; n: number }
  | { kind: "rowShows"; table: string | null; row: string; shows: string[] }
  | { kind: "card"; label: string; expect: { type: "number" } | { type: "nonEmpty" } | { type: "value"; value: string } }
  | { kind: "chart"; label: string; shows: string | null };

export interface DataCheck {
  verdict: "pass" | "fail" | "unsure";
  detail: string;
  /** Playwright expressions for the generated spec. Empty means: write a note only. */
  locators: string[];
}

const QUOTED = /["“']([^"”']+)["”']/g;
const quotes = (s: string) => Array.from(s.matchAll(QUOTED), (m) => m[1]);

/** Loose text compare: ignore case, punctuation and spacing. */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const like = (hay: string, needle: string) => norm(needle) !== "" && norm(hay).includes(norm(needle));
const NUMBER = /^[~<>≈+\-−]?\s*[$€£]?\s*\d[\d.,]*\s*(%|[kKmMbB]\b|ms\b|s\b|h\b|d\b|min\b|pts\b)?/;
const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const q = (s: string) => JSON.stringify(s);

/**
 * Recognise a data criterion. Examples:
 *   the "Models" table should have the columns "Model" and "Status"
 *   the "Agents" table should have at least 1 row
 *   the row "data-export-agent" should show "Changes requested"
 *   the card "Calls today" should show a number   (or: show "10")
 *   the chart "Agents by status" should be visible
 * Returns null when the line is something else (then the text check handles it).
 */
export function parseDataCriterion(raw: string): DataCriterion | null {
  const Q = quotes(raw);
  if (Q.length === 0) return null;
  const hasTable = /\b(table|grid)\b/i.test(raw);

  // Table title: `"X" table` or `table "X"`. Remove it from the quoted list.
  let title: string | null = null;
  const t1 = raw.match(/["“']([^"”']+)["”']\s+(?:table|grid)\b/i);
  const t2 = raw.match(/\b(?:table|grid)\s+["“']([^"”']+)["”']/i);
  if (t1) title = t1[1];
  else if (t2) title = t2[1];
  const rest = [...Q];
  if (title !== null) rest.splice(rest.indexOf(title), 1);

  // The row "X" should show "Y"
  if (/\brow\s+["“']/i.test(raw) || /["“'][^"”']+["”']\s+row\b/i.test(raw)) {
    if (rest.length === 0) return null;
    return { kind: "rowShows", table: title, row: rest[0], shows: rest.slice(1) };
  }
  if (/\bcolumns?\b/i.test(raw) && rest.length > 0) {
    return { kind: "columns", table: title, columns: rest };
  }
  if (hasTable && /\b(rows?|empty)\b/i.test(raw)) {
    const n = raw.match(/\b(at least|at most|exactly|no|\d+)\s*(\d+)?\s*rows?\b/i);
    if (/\bnot\s+(?:be\s+)?empty\b/i.test(raw)) return { kind: "rows", table: title, op: "atLeast", n: 1 };
    if (/\b(?:be\s+)?empty\b/i.test(raw) || /\bno\s+rows?\b/i.test(raw)) return { kind: "rows", table: title, op: "exactly", n: 0 };
    if (n) {
      const word = n[1].toLowerCase();
      const num = Number(n[2] ?? (/^\d+$/.test(word) ? word : NaN));
      if (Number.isFinite(num)) {
        const op = word === "at least" ? "atLeast" : word === "at most" ? "atMost" : "exactly";
        return { kind: "rows", table: title, op, n: num };
      }
    }
    if (/\b(?:some|any)\s+rows?\b/i.test(raw) || /\bhave\s+rows\b/i.test(raw)) return { kind: "rows", table: title, op: "atLeast", n: 1 };
    return null;
  }
  if (/\b(chart|graph|plot)\b/i.test(raw) && !hasTable) {
    return { kind: "chart", label: Q[0], shows: Q.length > 1 ? Q[1] : null };
  }
  if (/\b(card|kpi|tile|metric)\b/i.test(raw) && !hasTable) {
    if (Q.length > 1) return { kind: "card", label: Q[0], expect: { type: "value", value: Q[1] } };
    if (/\b(not\s+(?:be\s+)?empty|non-?empty)\b/i.test(raw)) return { kind: "card", label: Q[0], expect: { type: "nonEmpty" } };
    return { kind: "card", label: Q[0], expect: { type: "number" } };
  }
  return null;
}

/** Locator for the table that has these column names (the first two make it unique). */
function tableLocator(t: KbTable): string {
  const cols = t.columns.slice(0, 2);
  const filters = cols.map((c) => `.filter({ has: page.getByRole("columnheader", { name: ${q(c)} }) })`).join("");
  return `page.locator("table, [role=table], [role=grid]")${filters}.first()`;
}

function pickTable(d: KbData, title: string | null): { table?: KbTable; problem?: string } {
  if (d.tables.length === 0) return { problem: "the page shows no table" };
  if (title === null) {
    if (d.tables.length === 1) return { table: d.tables[0] };
    return { problem: `the page has ${d.tables.length} tables; name one: ${d.tables.map((t) => `"${t.title}"`).join(", ")}` };
  }
  const hit = d.tables.find((t) => like(t.title, title)) ?? d.tables.find((t) => like(title, t.title) && t.title);
  if (hit) return { table: hit };
  return { problem: `no table titled "${title}"; tables: ${d.tables.map((t) => `"${t.title || "(no title)"}"`).join(", ")}` };
}

function evaluate(d: KbData, c: DataCriterion): DataCheck {
  if (c.kind === "chart") {
    const hit = d.charts.find((x) => like(x.label, c.label) || like(x.description, c.label));
    // Only chart elements: a plain [aria-label] also matches info buttons such as "About <chart>".
    const attr = `[aria-label*=${q(c.label.replace(/"/g, ""))} i]`;
    const sel = ["svg", "canvas", "[role=img]"].map((t) => t + attr).join(", ");
    const locators = [`expect(page.locator(${q(sel)}).first()).toBeVisible()`];
    if (!hit) return { verdict: "fail", detail: `no chart "${c.label}"; charts: ${d.charts.map((x) => `"${x.label.slice(0, 40)}"`).join(", ") || "none"}`, locators };
    if (c.shows) {
      const inLabel = like(hit.label, c.shows);
      const inOther = [...hit.legend, ...hit.text, hit.description].some((s) => like(s, c.shows!));
      // Legend text sits next to the graphic, so the spec reads the chart's parent element.
      const legendLoc = `page.locator(${q(sel)}).first().locator("xpath=..")`;
      if (!inLabel && !inOther) {
        locators.push(`expect(${legendLoc}).toContainText(${q(c.shows)}, { ignoreCase: true })`);
        return { verdict: "fail", detail: `chart "${c.label}" does not show "${c.shows}" (label, legend, text)`, locators };
      }
      if (inLabel) locators.push(`expect(page.locator(${q(sel)}).first()).toHaveAttribute("aria-label", new RegExp(${q(reEsc(c.shows))}, "i"))`);
      else locators.push(`expect(${legendLoc}).toContainText(${q(c.shows)}, { ignoreCase: true })`);
    }
    return { verdict: "pass", detail: `chart "${c.label}" found${c.shows ? ` and shows "${c.shows}"` : ""}`, locators };
  }

  if (c.kind === "card") {
    const hit = d.cards.find((x) => like(x.label, c.label));
    if (!hit) return { verdict: "fail", detail: `no card "${c.label}"; cards: ${d.cards.map((x) => `"${x.label}"`).join(", ") || "none"}`, locators: [`expect(page.getByText(${q(c.label)}, { exact: false }).first()).toBeVisible()`] };
    const lab = reEsc(hit.label);
    if (c.expect.type === "value") {
      const want = c.expect.value;
      const ok = like(hit.value, want) || like(hit.note ?? "", want);
      return {
        verdict: ok ? "pass" : "fail",
        detail: ok ? `card "${hit.label}" shows "${want}"` : `card "${hit.label}" shows "${hit.value}", not "${want}"`,
        locators: [`expect(page.locator("body")).toContainText(new RegExp(${q(lab + "[\\s\\S]{0,60}?" + reEsc(want))}, "i"))`],
      };
    }
    if (c.expect.type === "number") {
      const ok = NUMBER.test(hit.value);
      return {
        verdict: ok ? "pass" : "fail",
        detail: ok ? `card "${hit.label}" shows a number (${hit.value})` : `card "${hit.label}" shows "${hit.value}", not a number`,
        locators: [`expect(page.locator("body")).toContainText(new RegExp(${q(lab + "[\\s\\S]{0,60}?\\d")}, "i"))`],
      };
    }
    const ok = hit.value.trim() !== "";
    return {
      verdict: ok ? "pass" : "fail",
      detail: ok ? `card "${hit.label}" is not empty (${hit.value})` : `card "${hit.label}" is empty`,
      locators: [`expect(page.getByText(${q(hit.label)}, { exact: false }).first()).toBeVisible()`],
    };
  }

  const { table, problem } = pickTable(d, c.table);
  if (!table) return { verdict: c.table === null && problem?.includes("name one") ? "unsure" : "fail", detail: problem!, locators: [] };
  const T = tableLocator(table);
  const name = table.title ? `"${table.title}"` : "the table";

  if (c.kind === "columns") {
    const missing = c.columns.filter((w) => !table.columns.some((col) => like(col, w)));
    const locators = c.columns.map((w) => `expect(${T}.getByRole("columnheader", { name: ${q(w)} })).toBeVisible()`);
    if (missing.length) {
      return { verdict: "fail", detail: `${name} has no column ${missing.map((m) => `"${m}"`).join(", ")}; columns: ${table.columns.join(", ")}`, locators };
    }
    return { verdict: "pass", detail: `${name} has the columns ${c.columns.map((x) => `"${x}"`).join(", ")}`, locators };
  }

  if (c.kind === "rows") {
    const have = table.rowCount;
    const ok = c.op === "atLeast" ? have >= c.n : c.op === "atMost" ? have <= c.n : have === c.n;
    const rows = `${T}.locator("tbody tr, [role=row]:has([role=cell], [role=gridcell])")`;
    const matcher = c.op === "atLeast" ? `toBeGreaterThanOrEqual(${c.n})` : c.op === "atMost" ? `toBeLessThanOrEqual(${c.n})` : `toBe(${c.n})`;
    const words = c.op === "atLeast" ? "at least" : c.op === "atMost" ? "at most" : "exactly";
    return {
      verdict: ok ? "pass" : "fail",
      detail: ok ? `${name} has ${have} row(s), ${words} ${c.n}` : `${name} has ${have} row(s), expected ${words} ${c.n}${table.emptyText ? ` (page says "${table.emptyText}")` : ""}`,
      locators: [`expect.poll(() => ${rows}.count()).${matcher}`],
    };
  }

  // rowShows: the sample holds only the first rows, so look at the live page for the row.
  return { verdict: "unsure", detail: "row check runs on the live page", locators: [] };
}

/** Rows are checked in the browser: the table may have more rows than the sample. */
async function checkRowShows(page: Page, d: KbData, c: Extract<DataCriterion, { kind: "rowShows" }>): Promise<DataCheck> {
  const { table, problem } = pickTable(d, c.table);
  if (!table) return { verdict: c.table === null && problem?.includes("name one") ? "unsure" : "fail", detail: problem!, locators: [] };
  const T = tableLocator(table);
  // The same table as in the spec: found by its first two column names.
  let tbl = page.locator("table, [role=table], [role=grid]");
  for (const col of table.columns.slice(0, 2)) {
    tbl = tbl.filter({ has: page.getByRole("columnheader", { name: col }) });
  }
  const want = norm(c.row);
  const texts = await tbl
    .first()
    .locator("tr, [role=row]")
    .allInnerTexts()
    .catch(() => [] as string[]);
  const hit = texts.find((t) => norm(t).includes(want));
  const rowLoc = `${T}.locator("tr, [role=row]").filter({ hasText: ${q(c.row)} }).first()`;
  const locators = c.shows.length
    ? c.shows.map((s) => `expect(${rowLoc}).toContainText(${q(s)}, { ignoreCase: true })`)
    : [`expect(${rowLoc}).toBeVisible()`];
  if (!hit) return { verdict: "fail", detail: `no row containing "${c.row}" in ${table.title ? `"${table.title}"` : "the table"}`, locators };
  const missing = c.shows.filter((s) => !norm(hit).includes(norm(s)));
  if (missing.length) {
    return { verdict: "fail", detail: `row "${c.row}" does not show ${missing.map((m) => `"${m}"`).join(", ")}; the row reads: ${hit.replace(/\s+/g, " ").slice(0, 120)}`, locators };
  }
  return {
    verdict: "pass",
    detail: `row "${c.row}" found${c.shows.length ? ` and shows ${c.shows.map((s) => `"${s}"`).join(", ")}` : ""}`,
    locators,
  };
}

/**
 * Check a data criterion on the live page. Data may load late, so a failed check
 * is retried once after a pause. Values are read at run time, not from the
 * knowledge file, so a changed row count or number is caught.
 */
export async function checkData(page: Page, c: DataCriterion, waitMs = 4000): Promise<DataCheck> {
  let result: DataCheck = { verdict: "fail", detail: "not checked", locators: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const d = await extractData(page, waitMs);
    result = c.kind === "rowShows" ? await checkRowShows(page, d, c) : evaluate(d, c);
    if (result.verdict === "pass") break;
    await page.waitForTimeout(1000);
  }
  return result;
}
