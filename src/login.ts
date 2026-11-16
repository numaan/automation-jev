import type { Page } from "playwright";
import { extractCandidates, describe } from "./extract.js";
import { executionLocator, scriptLocatorFor } from "./locators.js";
import { interpretInstruction } from "./interpret.js";
import { loginLocatorSource, type KbLogin, type KbField } from "./knowledge.js";
import type { LoginConfig, PasswordLogin } from "./config.js";
import type { Candidate, Step } from "./types.js";

const PASSWORD_FIELD = 'input[type="password"]';
/** Buttons and links that look like a submit button but are not. */
const NOT_SUBMIT = /forgot|register|sign.?up|create.*account|reset|cancel|back/i;

async function settle(page: Page, ms: number) {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
  await page.waitForTimeout(300);
}

/** Pick one element with the model, but only when it is confident. */
async function pickWithModel(
  page: Page,
  cands: Candidate[],
  instruction: string,
  minConfidence: number,
  hint: string
): Promise<Candidate> {
  if (cands.length === 0) throw new Error(`No candidates for "${instruction}". ${hint}`);
  const d = await interpretInstruction({
    instruction,
    currentUrl: page.url(),
    pageTitle: await page.title(),
    history: [],
    candidates: cands,
  });
  const chosen = cands.find((c) => c.id === d.pick);
  console.log(`  login: "${instruction}" → ${chosen ? describe(chosen) : "none"} (conf ${d.confidence.toFixed(2)})`);
  if (!chosen || d.confidence < minConfidence) {
    throw new Error(`Not confident enough about "${instruction}" (${d.confidence.toFixed(2)}). ${hint}`);
  }
  return chosen;
}

async function fieldFromSelector(sel: string): Promise<KbField> {
  return { css: sel, src: `page.locator(${JSON.stringify(sel)})` };
}
async function fieldFromCandidate(page: Page, c: Candidate): Promise<KbField> {
  return { css: c.css, src: await scriptLocatorFor(page, c) };
}

/**
 * Sign in and return what a later run needs to repeat it. Credentials come from
 * environment variables. They are never written to the script or the knowledge file.
 */
export async function performLogin(
  page: Page,
  login: LoginConfig,
  steps: Step[],
  opts: { minConfidence: number; settleMs: number }
): Promise<KbLogin | null> {
  if (login.type === "none") return null;
  if (login.type === "role") return performRoleLogin(page, login.role, steps, opts);
  return performPasswordLogin(page, login, steps, opts);
}

async function performRoleLogin(
  page: Page,
  role: string,
  steps: Step[],
  opts: { minConfidence: number; settleMs: number }
): Promise<KbLogin | null> {
  await page.locator("button, a[href]").first().waitFor({ timeout: 10000 });
  // Signing in is a click on a button. A checkbox only selects a role.
  const cands = (await extractCandidates(page)).filter(
    (c) => c.inputType !== "checkbox" && c.inputType !== "radio"
  );
  const chosen = await pickWithModel(
    page,
    cands,
    `click the ${role} role button`,
    opts.minConfidence,
    "Check login.role in the config."
  );
  await executionLocator(page, chosen).click();
  steps.push({ action: "click", locator: loginLocatorSource(role), note: `sign in as ${role}` });
  await settle(page, opts.settleMs);
  return { type: "role", label: role, roleLabel: role };
}

async function performPasswordLogin(
  page: Page,
  cfg: PasswordLogin,
  steps: Step[],
  opts: { minConfidence: number; settleMs: number }
): Promise<KbLogin> {
  const user = process.env[cfg.usernameEnv];
  const pass = process.env[cfg.passwordEnv];
  if (!user || !pass) {
    throw new Error(`Set ${cfg.usernameEnv} and ${cfg.passwordEnv} in .env (names come from the config).`);
  }

  if (cfg.loginUrl) {
    await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded" });
    steps.push({ action: "goto", locator: "", url: cfg.loginUrl, note: `open ${cfg.loginUrl}` });
  }
  await page
    .locator(PASSWORD_FIELD)
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {
      throw new Error(
        `No password field on ${page.url()}. Set login.loginUrl in the config, or login.selectors.`
      );
    });

  const cands = await extractCandidates(page);
  const sel = cfg.selectors ?? {};

  // Password field: it is the only field of type=password, so code needs no model.
  let password: KbField;
  if (sel.password) password = await fieldFromSelector(sel.password);
  else {
    const pw = cands.filter((c) => c.kind === "fill" && c.inputType === "password");
    if (pw.length !== 1) throw new Error(`Found ${pw.length} password fields. Set login.selectors.password.`);
    password = await fieldFromCandidate(page, pw[0]);
  }

  // Username field: one text field means no choice to make; else ask the model.
  let username: KbField;
  if (sel.username) username = await fieldFromSelector(sel.username);
  else {
    const texts = cands.filter((c) => c.kind === "fill" && c.inputType !== "password" && c.inputType !== "hidden");
    const chosen =
      texts.length === 1
        ? texts[0]
        : await pickWithModel(
            page,
            texts,
            "enter the username or email address",
            opts.minConfidence,
            "Set login.selectors.username in the config."
          );
    username = await fieldFromCandidate(page, chosen);
  }

  // Submit button: one submit button means no choice; else ask the model.
  let submit: KbField;
  if (sel.submit) submit = await fieldFromSelector(sel.submit);
  else {
    const buttons = cands.filter(
      (c) => c.kind === "click" && c.role !== "link" && !NOT_SUBMIT.test(c.name)
    );
    const submits = buttons.filter((c) => c.inputType === "submit");
    const chosen =
      submits.length === 1
        ? submits[0]
        : await pickWithModel(
            page,
            buttons,
            "click the sign in button",
            opts.minConfidence,
            "Set login.selectors.submit in the config."
          );
    submit = await fieldFromCandidate(page, chosen);
  }

  await page.locator(username.css).first().fill(user);
  await page.locator(password.css).first().fill(pass);
  steps.push({ action: "fill", locator: username.src, valueEnv: cfg.usernameEnv, note: "enter the username" });
  steps.push({ action: "fill", locator: password.src, valueEnv: cfg.passwordEnv, note: "enter the password" });
  await Promise.all([
    page.locator(submit.css).first().click(),
    page.waitForLoadState("domcontentloaded").catch(() => {}),
  ]);
  steps.push({ action: "click", locator: submit.src, note: "sign in" });
  await settle(page, opts.settleMs);

  // A form that is still on screen means the sign-in did not work.
  await page
    .locator(PASSWORD_FIELD)
    .first()
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {
      throw new Error(`Still on the login form at ${page.url()}. Check ${cfg.usernameEnv} and ${cfg.passwordEnv}.`);
    });

  return {
    type: "password",
    label: cfg.label ?? "user",
    loginUrl: cfg.loginUrl,
    usernameEnv: cfg.usernameEnv,
    passwordEnv: cfg.passwordEnv,
    username,
    password,
    submit,
  };
}

/** Repeat a recorded login. Uses no model. */
export async function replayLogin(
  page: Page,
  login: KbLogin,
  steps: Step[],
  settleMs = 5000
): Promise<void> {
  if (login.type === "role") {
    await page.getByRole("button", { name: new RegExp("^" + (login.roleLabel ?? login.label)) }).first().click();
    steps.push({ action: "click", locator: loginLocatorSource(login.roleLabel ?? login.label), note: `sign in as ${login.label}` });
    await settle(page, settleMs);
    return;
  }
  const user = process.env[login.usernameEnv ?? ""];
  const pass = process.env[login.passwordEnv ?? ""];
  if (!user || !pass) throw new Error(`Set ${login.usernameEnv} and ${login.passwordEnv} in .env.`);
  if (login.loginUrl) {
    await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
    steps.push({ action: "goto", locator: "", url: login.loginUrl, note: `open ${login.loginUrl}` });
  }
  await page.locator(PASSWORD_FIELD).first().waitFor({ timeout: 10000 });
  await page.locator(login.username!.css).first().fill(user);
  await page.locator(login.password!.css).first().fill(pass);
  steps.push({ action: "fill", locator: login.username!.src, valueEnv: login.usernameEnv, note: "enter the username" });
  steps.push({ action: "fill", locator: login.password!.src, valueEnv: login.passwordEnv, note: "enter the password" });
  await Promise.all([
    page.locator(login.submit!.css).first().click(),
    page.waitForLoadState("domcontentloaded").catch(() => {}),
  ]);
  steps.push({ action: "click", locator: login.submit!.src, note: "sign in" });
  await settle(page, settleMs);
}
