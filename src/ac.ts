import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Page } from "playwright";
import { extractCandidates, describe } from "./extract.js";
import { executionLocator, scriptLocatorFor } from "./locators.js";
import { chooseOption, chooseScreen, interpretInstruction, judgeStatement } from "./interpret.js";
import { describeScreen, findPath, loadKnowledge } from "./knowledge.js";
import { replayLogin } from "./login.js";
import { checkText, parseTextCriterion, type Typed } from "./assertions.js";
import { emitScript } from "./emit.js";
import type { Step } from "./types.js";

// Usage: npm run ac -- --knowledge knowledge/<app>.<role>.json
//                      (--criteria "line 1\nline 2" | --file criteria.txt)
//                      [--headless] [--out generated/ac.spec.ts] [--min 0.8]
interface Opts {
  knowledge: string;
  criteria: string;
  headless: boolean;
  out: string;
  min: number;
}
function parseArgs(argv: string[]): Opts {
  const o: Opts = { knowledge: "", criteria: "", headless: false, out: "generated/ac.spec.ts", min: 0.8 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--knowledge") o.knowledge = argv[++i];
    else if (a === "--criteria") o.criteria = argv[++i].replace(/\\n/g, "\n");
    else if (a === "--file") o.criteria = readFileSync(argv[++i], "utf8");
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--min") o.min = Number(argv[++i]);
    else if (a === "--headless") o.headless = true;
  }
  return o;
}

const quoted = (s: string) => {
  const m = s.match(/"([^"]*)"|'([^']*)'/);
  return m ? (m[1] ?? m[2] ?? null) : null;
};
const ASSERT = /^(then|verify|assert|expect|check|ensure)\b|\bshould\b|\b(is|are) (shown|displayed|visible|listed)\b/i;
/** A step that only moves to a screen ("I am on X", "go to X", "open the X screen"). */
const isNavigation = (raw: string) =>
  !ASSERT.test(raw) &&
  !/\b(click|press|tap|type|enter|fill|select|choose|submit|toggle|search)\b/i.test(raw) &&
  /\b(am on|is on|are on|navigate|go to|goes to|open|visit|land on|switch to)\b/i.test(raw);
/** A "Given ..." line that only says the user is signed in. */
const isLoginPrecondition = (raw: string) =>
  /^\s*(?:[-*\d.)]+\s*)?given\b/i.test(raw) &&
  !ASSERT.test(raw) &&
  /\b(signed|logged|authenticated)\b|\b(sign|log)(ged)?[- ]?in\b/i.test(raw) &&
  !/\b(click|press|type|enter|fill|select|submit)\b/i.test(raw);
const strip = (l: string) =>
  l.replace(/^\s*(?:[-*\d.)]+\s*)?(?:given|when|then|and|but)\b[:,]?\s*/i, "").trim();

type Verdict = "pass" | "fail" | "unsure" | "skipped";
interface Result {
  step: string;
  kind: "action" | "assert";
  screen: string | null;
  verdict: Verdict;
  detail: string;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.knowledge || !o.criteria.trim()) {
    console.error('Usage: npm run ac -- --knowledge <kb.json> (--criteria "..." | --file f.txt)');
    process.exit(1);
  }
  const kb = loadKnowledge(o.knowledge);
  const lines = o.criteria.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const origin = kb.origin;
  const key = (u: string) => new URL(u, origin).pathname + new URL(u, origin).search;
  const descriptions = Object.fromEntries(kb.screens.map((s) => [s.id, describeScreen(s)]));

  const browser = await chromium.launch({ headless: o.headless });
  const page = await browser.newPage();
  const steps: Step[] = [];
  const results: Result[] = [];
  const settle = async () => {
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  };

  try {
    // 1. Login: replayed from knowledge, no model needed.
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    steps.push({ action: "goto", locator: "", url: origin, note: `open ${origin}` });
    if (kb.login) await replayLogin(page, kb.login, steps);

    // 2. Each criterion line: find its screen, go there, then act or assert.
    const done: string[] = [];
    const typed: Typed[] = [];
    for (const raw of lines) {
      const step = strip(raw);
      const kind: Result["kind"] = ASSERT.test(raw) ? "assert" : "action";
      console.log(`\n▶ ${raw}`);

      // "Given I am signed in as X" describes a state the login step already created.
      if (isLoginPrecondition(raw)) {
        const ok = Boolean(kb.login);
        results.push({
          step: raw,
          kind,
          screen: null,
          verdict: ok ? "pass" : "unsure",
          detail: ok ? `satisfied by the login (${kb.login!.label})` : "the knowledge file has no login",
        });
        console.log(ok ? `  ✓ satisfied by the login (${kb.login!.label})` : "  ? no login in the knowledge file");
        done.push(step);
        continue;
      }
      const here = key(page.url());
      const known = kb.screens.some((s) => s.id === here) ? here : null;

      // Which screen? Prefer staying put when the current screen is nearly as likely.
      const navOnly = isNavigation(raw);
      const d = await chooseScreen({ step, currentScreen: known, previousSteps: done.slice(-4), screens: descriptions, navigate: navOnly });
      let target = d.pick;
      if (!navOnly && known && (d.probabilities[known] ?? 0) >= 0.5 * (d.probabilities[d.pick] ?? 0)) target = known;
      console.log(`  screen → ${target} (conf ${d.confidence.toFixed(2)})${target === known ? " [stay]" : ""}`);

      if (target !== known) {
        if (d.confidence < o.min && !known) {
          results.push({ step: raw, kind, screen: null, verdict: "unsure", detail: `screen confidence ${d.confidence.toFixed(2)}` });
          console.log("  ? unsure which screen; skipped");
          continue;
        }
        const path = findPath(kb, known, target);
        if (!path) {
          results.push({ step: raw, kind, screen: target, verdict: "fail", detail: "no known click path" });
          console.log("  ✗ no known click path");
          continue;
        }
        for (const href of path) {
          const sel = `a[href="${href}"]`;
          const link = page.locator(sel).first();
          if (await link.isVisible().catch(() => false)) {
            await link.click();
            steps.push({ action: "click", locator: `page.locator(${JSON.stringify(sel)}).first()`, note: `open ${href}` });
          } else {
            await page.goto(origin + href, { waitUntil: "domcontentloaded" });
            steps.push({ action: "goto", locator: "", url: origin + href, note: `open ${href} (direct)` });
          }
          await settle();
        }
        console.log(`  navigated via ${path.length} click(s)`);
      }

      if (navOnly) {
        const arrived = key(page.url()) === target;
        results.push({
          step: raw,
          kind,
          screen: target,
          verdict: arrived ? "pass" : "fail",
          detail: arrived ? `on ${target}` : `ended on ${key(page.url())}`,
        });
        console.log(arrived ? `  ✓ on ${target}` : `  ✗ ended on ${key(page.url())}`);
        done.push(step);
        continue;
      }

      if (kind === "assert") {
        const crit = parseTextCriterion(raw);
        const text = await page.locator("body").innerText().catch(() => "");
        if (crit) {
          const r = await checkText(page, crit.q, crit.area, typed);
          steps.push({
            action: "assert",
            locator: r.locator,
            note: r.verdict === "unsure" ? `${raw} (${r.detail})` : raw,
          });
          results.push({ step: raw, kind, screen: target, verdict: r.verdict, detail: r.detail });
          console.log(`  ${r.verdict === "pass" ? "✓" : r.verdict === "fail" ? "✗" : "?"} ${r.detail}`);
        } else {
          const p = await judgeStatement({ statement: step, url: page.url(), pageText: text });
          const verdict: Verdict = p >= 0.7 ? "pass" : p <= 0.3 ? "fail" : "unsure";
          // A model judgement is not a hard assertion: write a note, not a check that always passes.
          steps.push({ action: "assert", locator: "", note: `${raw} (model judged p=${p.toFixed(2)}; add a precise assertion)` });
          results.push({ step: raw, kind, screen: target, verdict, detail: `model p=${p.toFixed(2)}` });
          console.log(`  ${verdict === "pass" ? "✓" : verdict === "fail" ? "✗" : "?"} model judged p=${p.toFixed(2)}`);
        }
        done.push(step);
        continue;
      }

      // Action on the live page.
      const cands = await extractCandidates(page);
      const dec = await interpretInstruction({ instruction: step, currentUrl: page.url(), pageTitle: await page.title(), history: done, candidates: cands });
      const chosen = cands.find((c) => c.id === dec.pick);
      if (!chosen || dec.confidence < o.min) {
        results.push({ step: raw, kind, screen: target, verdict: "unsure", detail: `element confidence ${dec.confidence.toFixed(2)}` });
        console.log(`  ? unsure which element (conf ${dec.confidence.toFixed(2)}); skipped`);
        continue;
      }
      console.log(`  element → ${describe(chosen)} (conf ${dec.confidence.toFixed(2)})`);
      const loc = executionLocator(page, chosen);
      const src = await scriptLocatorFor(page, chosen);
      try {
        if (chosen.kind === "fill") {
          const v = quoted(raw);
          if (v === null) {
            results.push({ step: raw, kind, screen: target, verdict: "skipped", detail: "no quoted value to type" });
            console.log('  - skipped: put the value in quotes, e.g. type "abc" into ...');
            continue;
          }
          typed.push({ value: v, before: await page.locator("body").innerText().catch(() => "") });
          await loc.fill(v);
          steps.push({ action: "fill", locator: src, value: v, note: raw });
        } else if (chosen.kind === "select") {
          const w = await chooseOption({ instruction: step, field: chosen, options: chosen.options ?? [] });
          if (!w.option || w.confidence < o.min) {
            results.push({ step: raw, kind, screen: target, verdict: "unsure", detail: "option unclear" });
            console.log("  ? option unclear; skipped");
            continue;
          }
          await loc.selectOption(w.option.value ? { value: w.option.value } : { label: w.option.label });
          steps.push({ action: "select", locator: src, value: w.option.value || w.option.label, note: raw });
        } else {
          await Promise.all([loc.click(), page.waitForLoadState("domcontentloaded").catch(() => {})]);
          steps.push({ action: "click", locator: src, note: raw });
        }
        await settle();
        results.push({ step: raw, kind, screen: target, verdict: "pass", detail: describe(chosen) });
        console.log("  ✓ done");
      } catch (e) {
        results.push({ step: raw, kind, screen: target, verdict: "fail", detail: (e as Error).message.split("\n")[0] });
        console.log(`  ✗ ${(e as Error).message.split("\n")[0]}`);
      }
      done.push(step);
    }
  } finally {
    await browser.close();
  }

  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, emitScript(`Acceptance criteria (${kb.role})`, steps), "utf8");
  const resPath = o.out.replace(/\.spec\.ts$/, ".result.json");
  writeFileSync(resPath, JSON.stringify({ knowledge: o.knowledge, results }, null, 2) + "\n", "utf8");
  console.log("\n| # | Verdict | Step | Detail |\n|---|---|---|---|");
  results.forEach((r, i) => console.log(`| ${i + 1} | ${r.verdict} | ${r.step} | ${r.detail} |`));
  console.log(`\nspec → ${o.out}\nresult → ${resPath}`);
  if (results.some((r) => r.verdict === "fail")) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
