import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Page } from "playwright";
import { extractCandidates } from "./extract.js";
import { emitScript } from "./emit.js";
import type { Step } from "./types.js";
import { factorShell, saveKnowledge, type KbScreen, type Knowledge } from "./knowledge.js";
import { denyRegex, loadAppConfig, loginLabel, type AppConfig } from "./config.js";
import { performLogin } from "./login.js";
import { extractData } from "./data.js";

// Usage: npm run crawl -- --config apps/<app>.json [--headless]
//    or: npm run crawl -- <url> --login "Role" [--headless] [--max 40] [--per-pattern 1]
//                         [--out generated/screens.spec.ts] [--knowledge <path>]

/** Settings for the current run. Set once in main(), read by the helpers below. */
let cfg: AppConfig;
/** Never follow links that end the session or change data (defaults + config). */
let DENY: RegExp;

/**
 * Group detail pages (/agents/foo, /agents/bar) into one pattern so the crawl
 * samples a few instead of visiting every record. Lists and tab views stay distinct.
 */
function patternOf(href: string): string {
  const u = new URL(href, "http://x");
  const parts = u.pathname.split("/").filter(Boolean);
  return parts.length >= 2 ? `/${parts[0]}/*` : u.pathname + u.search;
}

type ScreenReport = KbScreen;

async function main() {
  cfg = loadAppConfig(process.argv.slice(2));
  DENY = denyRegex(cfg.denyPatterns);
  const opts = cfg;
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("Set TYPESAFE_API_KEY (see .env.example).");
    process.exit(1);
  }

  const origin = new URL(opts.url).origin;
  const browser = await chromium.launch({ headless: opts.headless });
  const page = await browser.newPage();
  const steps: Step[] = [];
  const reports: ScreenReport[] = [];
  let login: Awaited<ReturnType<typeof performLogin>> = null;

  let consoleErrors: string[] = [];
  let failed: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });

  await page.goto(opts.url, { waitUntil: "domcontentloaded" });
  steps.push({ action: "goto", locator: "", url: opts.url, note: `open ${opts.url}` });
  await settle(page);

  try {
    // 1. Login: by role button or by username and password (see config).
    login = await performLogin(page, cfg.login, steps, {
      minConfidence: cfg.minConfidence,
      settleMs: cfg.settleMs,
    });

    // 2. Crawl. Visit each link by clicking it where possible, so the generated
    //    script replays through the real navigation and keeps the session.
    const seen = new Set<string>();
    const perPattern = new Map<string, number>();
    const queue: string[] = [];
    const parentOf = new Map<string, string>(); // link -> screen where it was seen
    const key = (h: string) => new URL(h, origin).pathname + new URL(h, origin).search;

    const discover = async () => {
      await expandGroups(page, steps);
      // Cards and tables often render after the network is idle. Wait until the
      // number of links stops changing (max ~4 s) before reading them.
      let last = -1;
      for (let i = 0; i < Math.ceil(cfg.linkWaitMs / 250); i++) {
        const c = await page.locator("a[href]").count();
        if (c === last) break;
        last = c;
        await page.waitForTimeout(250);
      }
      const links = await page.locator("a[href]").evaluateAll((as) =>
        as.map((a) => ({ href: a.getAttribute("href") ?? "", text: (a.textContent ?? "").trim() }))
      );
      for (const l of links) {
        if (!l.href || l.href.startsWith("#") || DENY.test(l.href + " " + l.text)) continue;
        let k: string;
        try {
          const u = new URL(l.href, origin);
          if (u.origin !== origin) continue;
          k = key(l.href);
        } catch {
          continue;
        }
        if (seen.has(k) || queue.includes(k)) continue;
        queue.push(k);
        parentOf.set(k, key(page.url()));
      }
    };


    /** Reach a screen by clicking its link. If the link is not on this screen,
     *  go to the screen where it was found first (a click path), else use goto. */
    const openScreen = async (k: string, depth = 0): Promise<void> => {
      const sel = `a[href="${k}"]`;
      const link = page.locator(sel).first();
      if (await link.isVisible().catch(() => false)) {
        await link.click();
        steps.push({
          action: "click",
          locator: `page.locator(${JSON.stringify(sel)}).first()`,
          note: `open ${k}`,
        });
        return;
      }
      const parent = parentOf.get(k);
      if (parent && parent !== key(page.url()) && depth < 3) {
        await openScreen(parent, depth + 1);
        await settle(page);
        if (await link.isVisible().catch(() => false)) {
          await link.click();
          steps.push({
            action: "click",
            locator: `page.locator(${JSON.stringify(sel)}).first()`,
            note: `open ${k}`,
          });
          return;
        }
      }
      await page.goto(origin + k, { waitUntil: "domcontentloaded" });
      steps.push({ action: "goto", locator: "", url: origin + k, note: `open ${k} (direct)` });
    };

    const here = key(page.url());
    seen.add(here);
    await record(page, here, reports, steps, consoleErrors, failed, true);
    await discover();

    while (queue.length && reports.length < opts.maxScreens) {
      const k = queue.shift()!;
      if (seen.has(k)) continue;
      const pat = patternOf(k);
      const n = perPattern.get(pat) ?? 0;
      if (pat.endsWith("/*") && n >= opts.perPattern) continue;
      perPattern.set(pat, n + 1);
      seen.add(k);

      consoleErrors = [];
      failed = [];
      await openScreen(k);
      await settle(page);
      console.log(`[${reports.length + 1}] ${k}`);
      await record(page, k, reports, steps, consoleErrors, failed, false);
      reports[reports.length - 1].via = parentOf.get(k);
      await discover();
    }
  } finally {
    await browser.close();
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, emitScript(`Visit every screen as ${loginLabel(cfg.login)}`, steps), "utf8");
  const md = [
    "| # | Screen | Title | Heading | Console errors | Failed requests |",
    "|---|---|---|---|---|---|",
    ...reports.map(
      (r, i) =>
        `| ${i + 1} | \`${r.href}\` | ${r.title} | ${r.heading} | ${r.consoleErrors} | ${r.failedRequests} |`
    ),
  ].join("\n");
  const mdPath = opts.out.replace(/\.spec\.ts$/, ".report.md");
  writeFileSync(mdPath, md + "\n", "utf8");
  const { shell, screens } = factorShell(reports);
  const kb: Knowledge = {
    app: new URL(opts.url).host,
    origin,
    role: loginLabel(cfg.login),
    generatedAt: new Date().toISOString(),
    login,
    shell,
    screens,
  };
  const kbPath =
    opts.knowledge ??
    `knowledge/${kb.app.replace(/[^a-z0-9]+/gi, "-")}.${kb.role.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
  saveKnowledge(kbPath, kb);
  console.log(`  knowledge → ${kbPath} (${screens.length} screens, ${shell.links.length} shell links)`);
  console.log(`\n✔ ${reports.length} screens, ${steps.length} steps → ${opts.out}\n  report → ${mdPath}`);
}

/** Wait for the SPA to render; never fail on a busy page. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: cfg.settleMs }).catch(() => {});
  await page.waitForTimeout(300);
}

/** Open collapsed sidebar groups so their links become visible. Navigation only:
 *  menu and dialog triggers (aria-haspopup) are never clicked. */
async function expandGroups(page: Page, steps: Step[]) {
  const buttons = page.locator(cfg.expandSelector);
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const name = ((await b.textContent()) ?? "").trim();
    if (!name || DENY.test(name)) continue;
    if (!(await b.isVisible().catch(() => false))) continue;
    await b.click().catch(() => {});
    steps.push({
      action: "click",
      locator: `page.getByRole("button", { name: ${JSON.stringify(name)}, exact: true })`,
      note: `expand ${name}`,
    });
  }
}

async function record(
  page: Page,
  href: string,
  reports: ScreenReport[],
  steps: Step[],
  consoleErrors: string[],
  failed: string[],
  first: boolean
) {
  const title = await page.title();
  const heading =
    ((await page.getByRole("heading", { level: 1 }).first().textContent().catch(() => "")) ?? "").trim();
  const subheadings = (
    await page
      .locator("h2, h3")
      .evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()))
      .catch(() => [] as string[])
  )
    .filter(Boolean)
    .slice(0, 15);
  const links = (
    await page
      .locator("a[href]")
      .evaluateAll((as) =>
        as.map((a) => ({
          text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
          href: a.getAttribute("href") ?? "",
        }))
      )
      .catch(() => [] as { text: string; href: string }[])
  )
    .filter((l) => l.href && !l.href.startsWith("#") && !/^[a-z]+:/i.test(l.href) && !DENY.test(l.href + l.text))
    .map((l) => ({ text: l.text, href: l.href }));
  const controls = (await extractCandidates(page))
    .filter((c) => c.role !== "link")
    .map((c) => ({
      kind: c.kind,
      role: c.role,
      name: c.name.slice(0, 80),
      inputType: c.inputType,
      placeholder: c.placeholder,
      options: c.options?.slice(0, 30).map((o) => o.label),
    }));
  const data = await extractData(page, cfg.linkWaitMs);
  reports.push({
    id: href,
    href,
    title,
    heading,
    subheadings,
    links,
    controls,
    data,
    consoleErrors: consoleErrors.length,
    failedRequests: failed.length,
  });
  const path = new URL(href, "http://x").pathname;
  steps.push({
    action: "assert",
    locator: `expect(page).toHaveURL(new RegExp(${JSON.stringify(
      "^[^?#]*" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\?|#|$)"
    )}))`,
    note: `on ${href}`,
  });
  if (heading) {
    steps.push({
      action: "assert",
      locator: `expect(page.getByRole("heading", { level: 1 }).first()).toContainText(${JSON.stringify(heading)})`,
      note: `heading "${heading}"`,
    });
  }
  if (first) console.log(`[1] ${href}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
