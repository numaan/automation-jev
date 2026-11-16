import type { Page } from "playwright";
import type { KbData } from "./knowledge.js";

/**
 * Browser-side extraction of the data a screen shows: tables and grids, KPI cards,
 * charts and labels. Kept as a plain string for the same reason as in extract.ts
 * (a bundler rewrites named inner functions and breaks them in the page).
 *
 * The rules do not depend on one app: they read ARIA roles, table markup, figure
 * and svg/canvas elements, and common class words (kpi, stat, metric, card, chip,
 * badge). Elements inside nav, aside and header are skipped as page chrome.
 */
const EXTRACT_DATA_JS = String.raw`(() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const inChrome = (el) => !!el.closest("nav, aside, header, [role=navigation], [role=banner]");
  const HEADING = "h1,h2,h3,h4,h5,h6,[role=heading]";

  function nameOf(el) {
    const al = el.getAttribute("aria-label");
    if (al) return clean(al);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = clean(lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" "));
      if (t) return t;
    }
    const cap = el.querySelector("caption, figcaption");
    if (cap) return clean(cap.textContent);
    return "";
  }

  // The nearest heading that comes before the element (best effort, 4 levels up).
  function headingBefore(el) {
    let node = el;
    for (let up = 0; node && up < 4; up++) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.matches(HEADING)) return clean(sib.textContent);
        const inner = sib.querySelectorAll(HEADING);
        if (inner.length) return clean(inner[inner.length - 1].textContent);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }

  // ---- tables and grids
  const tables = [];
  document.querySelectorAll("table, [role=table], [role=grid]").forEach((t) => {
    if (!visible(t) || inChrome(t)) return;
    if (t.parentElement && t.parentElement.closest("table, [role=table], [role=grid]")) return;
    const columns = Array.from(t.querySelectorAll("th, [role=columnheader]"))
      .filter(visible)
      .map((h) => clean(h.textContent))
      .filter(Boolean);
    const rowEls = Array.from(t.querySelectorAll("tbody tr, [role=row]")).filter(
      (r) => !r.querySelector("th, [role=columnheader]") || r.querySelector("td, [role=cell], [role=gridcell]")
    );
    let rows = rowEls
      .map((r) => Array.from(r.querySelectorAll("td, th, [role=cell], [role=gridcell], [role=rowheader]")).map((c) => clean(c.innerText || c.textContent).slice(0, 40)))
      .filter((r) => r.length);
    // One wide cell under several columns is an empty-state message, not a data row.
    let emptyText;
    if (rows.length === 1 && rows[0].length === 1 && columns.length > 1) {
      emptyText = rows[0][0];
      rows = [];
    }
    tables.push({
      title: nameOf(t) || headingBefore(t),
      columns: columns,
      rowCount: rows.length,
      sampleRows: rows.slice(0, 3),
      emptyText: emptyText,
    });
  });

  // ---- KPI cards: a short block with one number and one label
  const NUM = /^[~<>≈+\-−]?\s*[$€£]?\s*\d[\d.,]*\s*(%|[kKmMbB]\b|ms\b|s\b|h\b|d\b|min\b|pts\b)?/;
  const CARD_SEL = '[class*="kpi"],[class*="stat"],[class*="metric"],[class*="tile"],[class*="card"],[class*="summary"]';
  const cards = [];
  const acceptedEls = [];
  const seenCards = new Set();
  document.querySelectorAll(CARD_SEL).forEach((el) => {
    if (!visible(el) || inChrome(el)) return;
    if (el.querySelector("table, [role=table], [role=grid]")) return;
    if (acceptedEls.some((a) => a.contains(el))) return;
    const lines = (el.innerText || "").split("\n").map(clean).filter(Boolean);
    if (lines.length === 0 || lines.length > 8 || lines.join(" ").length > 140) return;
    // A range toggle ("7 d", "24h", "30 days") is a control, not a value.
    const isValue = (l) => NUM.test(l) && !/^\d+\s*(d|h|m|min|days?|hours?|weeks?)$/i.test(l);
    const vi = lines.findIndex(isValue);
    if (vi < 0) return;
    const label = lines.find((l, i) => i !== vi && !isValue(l) && l.length <= 60);
    if (!label) return;
    const key = label + "|" + lines[vi];
    if (seenCards.has(key)) return;
    seenCards.add(key);
    acceptedEls.push(el);
    cards.push({
      label: label,
      value: lines[vi],
      note: lines.filter((l, i) => i !== vi && l !== label).slice(0, 2).join(" · "),
    });
  });

  // ---- charts: svg or canvas of chart size, or a labelled image, or a figure
  const charts = [];
  const seenCharts = new Set();
  document.querySelectorAll('svg[role="img"], [role="img"][aria-label], svg[aria-label], svg, canvas, figure').forEach((el) => {
    if (!visible(el) || inChrome(el)) return;
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    const hasGraphic = tag === "svg" || tag === "canvas" || !!el.querySelector("svg, canvas");
    if (!hasGraphic) return;
    // An svg inside a figure or labelled image belongs to that parent.
    if (tag === "svg" && el.parentElement && el.parentElement.closest("figure, [role=img][aria-label]")) return;
    const titleEl = el.querySelector("title");
    const label = nameOf(el) || clean(el.getAttribute("title")) || (titleEl ? clean(titleEl.textContent) : "");
    const bigEnough = r.width >= 120 && r.height >= 60;
    if (!label && !bigEnough) return; // an icon
    const key = label || tag + ":" + Math.round(r.left) + ":" + Math.round(r.top);
    if (seenCharts.has(key)) return;
    seenCharts.add(key);
    const box = el.closest("figure") || el.parentElement || el;
    const legend = [];
    box.querySelectorAll('[class*="legend"] *').forEach((n) => {
      if (n.children.length === 0) {
        const t = clean(n.textContent);
        if (t && legend.indexOf(t) < 0 && legend.length < 12) legend.push(t);
      }
    });
    const text = [];
    el.querySelectorAll("text").forEach((n) => {
      const t = clean(n.textContent);
      if (t && text.indexOf(t) < 0 && text.length < 24) text.push(t);
    });
    const descEl = el.querySelector("desc");
    const describedBy = el.getAttribute("aria-describedby");
    const description = clean(
      el.getAttribute("aria-description") ||
        (descEl ? descEl.textContent : "") ||
        (describedBy ? (document.getElementById(describedBy) || {}).textContent : "")
    );
    charts.push({
      label: label,
      kind: tag === "canvas" || el.querySelector("canvas") ? "canvas" : "svg",
      legend: legend,
      text: text,
      description: description.slice(0, 200),
    });
  });

  // ---- labels: chips, badges, status text
  const LABEL_SEL = '[class*="chip"],[class*="badge"],[class*="pill"],[class*="tag"],[class*="status"],[role="status"]';
  const counts = new Map();
  document.querySelectorAll(LABEL_SEL).forEach((el) => {
    if (!visible(el) || inChrome(el)) return;
    if (el.querySelector(LABEL_SEL)) return; // use the innermost
    const t = clean(el.textContent);
    if (!t || t.length > 40) return;
    counts.set(t, (counts.get(t) || 0) + 1);
  });
  const labels = Array.from(counts.entries())
    .map((e) => ({ text: e[0], count: e[1] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  return { tables: tables, cards: cards, charts: charts, labels: labels };
})()`;

/** Wait until the page text stops changing, so late-loading data is included. */
async function waitStable(page: Page, maxMs: number) {
  let last = -1;
  let same = 0;
  for (let waited = 0; waited < maxMs; waited += 300) {
    const len = (await page.evaluate("document.body ? document.body.innerText.length : 0").catch(() => 0)) as number;
    same = len === last ? same + 1 : 0;
    if (same >= 2) return;
    last = len;
    await page.waitForTimeout(300);
  }
}

/** The data the current screen shows. */
export async function extractData(page: Page, waitMs = 4000): Promise<KbData> {
  await waitStable(page, waitMs);
  try {
    return (await page.evaluate(EXTRACT_DATA_JS)) as KbData;
  } catch {
    return { tables: [], cards: [], charts: [], labels: [] };
  }
}
