import { chromium } from "playwright";
import { extractCandidates, describe } from "./extract.js";
import { executionLocator, scriptLocatorFor } from "./locators.js";
import { emitScript } from "./emit.js";
import { decideNextAction, chooseValueFor, DONE, GIVE_UP } from "./jev.js";
import type { Step, Task } from "./types.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export async function record(task: Task): Promise<Step[]> {
  const {
    goal,
    startUrl,
    data = {},
    maxSteps = 20,
    minConfidence = 0.4,
    doneThreshold = 0.8,
    headless = false,
    out = "generated/recorded.spec.ts",
  } = task;

  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();
  const steps: Step[] = [];
  const history: string[] = [];

  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  steps.push({ action: "goto", locator: "", url: startUrl, note: `open ${startUrl}` });

  try {
    for (let i = 0; i < maxSteps; i++) {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      const candidates = await extractCandidates(page);
      const currentUrl = page.url();
      const pageTitle = await page.title();

      console.log(`\n── step ${i + 1} · ${currentUrl}`);
      console.log(`   ${candidates.length} candidate elements`);

      if (candidates.length === 0) {
        console.log("   no interactive elements found; stopping.");
        break;
      }

      const decision = await decideNextAction({
        goal,
        currentUrl,
        pageTitle,
        history,
        candidates,
        data,
      });

      console.log(
        `   Jev → ${decision.pick} (conf ${decision.confidence.toFixed(2)}, ` +
          `goalComplete ${decision.goalComplete.toFixed(2)})`
      );

      if (decision.goalComplete >= doneThreshold || decision.pick === DONE) {
        console.log("   goal judged complete. done.");
        break;
      }
      if (decision.pick === GIVE_UP) {
        console.log("   Jev sees no useful action here. stopping.");
        break;
      }
      if (decision.confidence < minConfidence) {
        console.log(
          `   confidence ${decision.confidence.toFixed(2)} below ${minConfidence}; stopping to avoid a blind click.`
        );
        break;
      }

      const chosen = candidates.find((c) => c.id === decision.pick);
      if (!chosen) {
        console.log("   picked id not found; stopping.");
        break;
      }

      const loc = executionLocator(page, chosen);
      const src = await scriptLocatorFor(page, chosen);

      if (chosen.kind === "select") {
        // The autonomous recorder has no per-option intent; the interactive mode
        // (npm run interactive) is where dropdowns are chosen from options.
        console.log("   dropdown selection isn't supported in autonomous mode; stopping.");
        break;
      } else if (chosen.kind === "fill") {
        const { key, confidence } = await chooseValueFor({ goal, field: chosen, data });
        if (!key) {
          console.log("   no data value fits this field; stopping.");
          break;
        }
        const value = data[key];
        console.log(`   fill "${chosen.name}" ← data.${key} (conf ${confidence.toFixed(2)})`);
        await loc.fill(value);
        steps.push({
          action: "fill",
          locator: src,
          value,
          note: `fill ${describe(chosen)} with data.${key}`,
        });
        history.push(`Filled "${chosen.name}" with the ${key} value.`);
      } else {
        console.log(`   click ${describe(chosen)}`);
        await Promise.all([
          loc.click(),
          page.waitForLoadState("domcontentloaded").catch(() => {}),
        ]);
        steps.push({ action: "click", locator: src, note: `click ${describe(chosen)}` });
        history.push(`Clicked "${chosen.name || chosen.role}".`);
      }

      await page.waitForTimeout(400); // let SPA transitions settle
    }
  } finally {
    await browser.close();
  }

  const script = emitScript(`Goal: ${task.goal}`, steps);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, script, "utf8");
  console.log(`\n✔ ${steps.length} steps recorded → ${out}`);
  return steps;
}
