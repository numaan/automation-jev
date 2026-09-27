import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { extractCandidates, describe } from "./extract.js";
import { executionLocator, scriptLocatorFor } from "./locators.js";
import { interpretInstruction, chooseOption } from "./interpret.js";
import { emitScript } from "./emit.js";
import type { Candidate, Step } from "./types.js";

interface Opts {
  startUrl?: string;
  out: string;
  headless: boolean;
  minConfidence: number;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    out: "generated/interactive.spec.ts",
    headless: false,
    minConfidence: 0.8,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headless") opts.headless = true;
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--min") opts.minConfidence = Number(argv[++i]);
    else if (!a.startsWith("--")) opts.startUrl = a;
  }
  return opts;
}

/** Pull a value the user typed inline, e.g. type "john@x.com" in email. */
function parseQuoted(s: string): string | null {
  const m = s.match(/"([^"]*)"|'([^']*)'/);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

const HELP = `
Type an instruction in plain English, e.g.:
  click the login button
  type "you@example.com" into the email field
  enter my password
  select "India" for country

Commands:
  :goto <url>     navigate the browser
  :show           list the interactive elements on the current page
  :save [path]    write the Playwright script so far
  :undo           remove the last recorded step
  :help           show this help
  :quit / :exit   save and exit
`.trim();

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("Set TYPESAFE_API_KEY (copy .env.example to .env).");
    process.exit(1);
  }

  const browser: Browser = await chromium.launch({ headless: opts.headless });
  const page: Page = await browser.newPage();
  const steps: Step[] = [];
  const history: string[] = [];
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const save = () => {
    if (steps.length === 0) return;
    const script = emitScript("Interactive Jev recording", steps);
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, script, "utf8");
    console.log(`\n✔ ${steps.length} steps → ${opts.out}`);
  };

  if (opts.startUrl) {
    await page.goto(opts.startUrl, { waitUntil: "domcontentloaded" });
    steps.push({ action: "goto", locator: "", url: opts.startUrl, note: `open ${opts.startUrl}` });
    console.log(`opened ${opts.startUrl}`);
  } else {
    console.log("No start URL. Use `:goto <url>` to begin.");
  }
  console.log("Type an instruction, or `:help`.\n");

  // Let the user pick from a numbered menu of candidates.
  async function pickFromMenu(cands: Candidate[]): Promise<Candidate | null> {
    const top = cands.slice(0, 10);
    console.log("  Not sure which element. Options:");
    top.forEach((c, i) => console.log(`   [${i + 1}] ${describe(c)}`));
    const a = (await rl.question("  Pick a number (Enter to skip): ")).trim();
    if (!a) return null;
    const n = Number(a);
    return n >= 1 && n <= top.length ? top[n - 1] : null;
  }

  async function handleInstruction(instruction: string) {
    const cands = await extractCandidates(page);
    if (cands.length === 0) {
      console.log("  no interactive elements found on this page.");
      return;
    }

    const decision = await interpretInstruction({
      instruction,
      currentUrl: page.url(),
      pageTitle: await page.title(),
      history,
      candidates: cands,
    });

    let chosen: Candidate | null = cands.find((c) => c.id === decision.pick) ?? null;

    if (chosen) {
      console.log(`  Jev → ${describe(chosen)}  (confidence ${decision.confidence.toFixed(2)})`);
    }

    // Low confidence (ambiguous, or the instruction fits nothing well): let the
    // user choose from the ranked candidates instead of acting blindly.
    if (!chosen || decision.confidence < opts.minConfidence) {
      const ordered = decision.ranked
        .map((id) => cands.find((c) => c.id === id))
        .filter((c): c is Candidate => Boolean(c));
      chosen = await pickFromMenu(ordered.length ? ordered : cands);
      if (!chosen) {
        console.log("  skipped.");
        return;
      }
    }

    const loc = executionLocator(page, chosen);
    const src = await scriptLocatorFor(page, chosen);

    if (chosen.kind === "fill") {
      let value = parseQuoted(instruction);
      if (value === null) {
        value = (await rl.question(`  Value for "${chosen.name}": `)).trim();
      }
      await loc.fill(value);
      steps.push({ action: "fill", locator: src, value, note: `fill ${describe(chosen)}` });
      history.push(`Filled "${chosen.name}".`);
      console.log(`  ✓ filled "${chosen.name}"`);
    } else if (chosen.kind === "select") {
      const options = chosen.options ?? [];
      const wanted = await chooseOption({ instruction, field: chosen, options });
      let picked = wanted.option;
      if (!picked || wanted.confidence < opts.minConfidence) {
        console.log(`  Options for "${chosen.name}":`);
        options.slice(0, 20).forEach((o, i) => console.log(`   [${i + 1}] ${o.label}`));
        const a = (await rl.question("  Pick a number (Enter to skip): ")).trim();
        if (!a) return console.log("  skipped.");
        picked = options[Number(a) - 1] ?? null;
        if (!picked) return console.log("  invalid choice; skipped.");
      } else {
        console.log(`  Jev → select "${picked.label}" (confidence ${wanted.confidence.toFixed(2)})`);
      }
      const selVal = picked.value || picked.label;
      await loc.selectOption(picked.value ? { value: picked.value } : { label: picked.label });
      steps.push({ action: "select", locator: src, value: selVal, note: `select "${picked.label}" in ${describe(chosen)}` });
      history.push(`Selected "${picked.label}" in "${chosen.name}".`);
      console.log(`  ✓ selected "${picked.label}"`);
    } else {
      await Promise.all([
        loc.click(),
        page.waitForLoadState("domcontentloaded").catch(() => {}),
      ]);
      steps.push({ action: "click", locator: src, note: `click ${describe(chosen)}` });
      history.push(`Clicked "${chosen.name || chosen.role}".`);
      console.log(`  ✓ clicked "${chosen.name || chosen.role}"`);
    }
    await page.waitForTimeout(300);
  }

  let quitting = false;
  while (!quitting) {
    const line = (await rl.question("jev> ")).trim();
    if (!line) continue;
    try {
      if (line === ":quit" || line === ":exit") {
        quitting = true;
      } else if (line === ":help") {
        console.log(HELP);
      } else if (line.startsWith(":goto ")) {
        const url = line.slice(6).trim();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        steps.push({ action: "goto", locator: "", url, note: `open ${url}` });
        console.log(`  opened ${url}`);
      } else if (line === ":show") {
        const cands = await extractCandidates(page);
        cands.forEach((c) => console.log(`   ${c.id}: ${describe(c)}`));
      } else if (line === ":undo") {
        const removed = steps.pop();
        console.log(removed ? `  removed: ${removed.note}` : "  nothing to undo.");
      } else if (line.startsWith(":save")) {
        const p = line.slice(5).trim();
        if (p) opts.out = p;
        save();
      } else if (line.startsWith(":")) {
        console.log("  unknown command. `:help` for the list.");
      } else {
        await handleInstruction(line);
      }
    } catch (err) {
      console.error(`  error: ${(err as Error).message}`);
    }
  }

  save();
  rl.close();
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
