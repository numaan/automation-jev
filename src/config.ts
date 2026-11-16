import { readFileSync } from "node:fs";

/** Sign in by clicking a role button (dev-mode apps that list roles). */
export interface RoleLogin {
  type: "role";
  role: string;
}

/** Sign in with a username and a password. */
export interface PasswordLogin {
  type: "password";
  /** Name of the environment variable that holds the username. Never put the value here. */
  usernameEnv: string;
  /** Name of the environment variable that holds the password. Never put the value here. */
  passwordEnv: string;
  /** Page that shows the login form. Default: the app url. */
  loginUrl?: string;
  /** Short name of the signed-in user. Used in file names and test titles. */
  label?: string;
  /** Optional CSS selectors. A selector given here replaces the model pick. */
  selectors?: { username?: string; password?: string; submit?: string };
}

export type LoginConfig = { type: "none" } | RoleLogin | PasswordLogin;

/** Everything the explorer needs to know about one app. */
export interface AppConfig {
  name?: string;
  url: string;
  login: LoginConfig;
  /** Regular expressions (case-insensitive). A link whose href or text matches is never followed. */
  denyPatterns: string[];
  maxScreens: number;
  /** Detail pages per pattern, e.g. /agents/* , that the crawl visits. */
  perPattern: number;
  /** Max wait (ms) for the network to go idle after each navigation. */
  settleMs: number;
  /** Max wait (ms) for the link count to stop changing before the crawl reads links. */
  linkWaitMs: number;
  /** CSS selector for collapsed menu groups the crawl may open. */
  expandSelector: string;
  headless: boolean;
  /** Model confidence needed before the tool acts on a pick. */
  minConfidence: number;
  out: string;
  knowledge?: string;
}

/** Links that end the session or change data. Config can add more, never remove these. */
export const DEFAULT_DENY = ["log.?out", "sign.?out", "delete", "remove", "revoke", "reset"];

const DEFAULTS = {
  denyPatterns: [] as string[],
  maxScreens: 40,
  perPattern: 1,
  settleMs: 5000,
  linkWaitMs: 4000,
  expandSelector: 'nav [aria-expanded="false"]:not([aria-haspopup])',
  headless: false,
  minConfidence: 0.8,
  out: "generated/screens.spec.ts",
};

function fail(msg: string): never {
  throw new Error(`Config error: ${msg}`);
}

function validateLogin(l: unknown): LoginConfig {
  if (l === undefined || l === null) return { type: "none" };
  const o = l as Record<string, unknown>;
  if (o.type === "none") return { type: "none" };
  if (o.type === "role") {
    if (typeof o.role !== "string" || !o.role) fail('login.role is required when login.type is "role"');
    return { type: "role", role: o.role };
  }
  if (o.type === "password") {
    for (const k of ["usernameEnv", "passwordEnv"]) {
      if (typeof o[k] !== "string" || !o[k]) fail(`login.${k} is required (the NAME of an environment variable)`);
    }
    const sel = (o.selectors ?? undefined) as PasswordLogin["selectors"];
    return {
      type: "password",
      usernameEnv: o.usernameEnv as string,
      passwordEnv: o.passwordEnv as string,
      loginUrl: typeof o.loginUrl === "string" ? o.loginUrl : undefined,
      label: typeof o.label === "string" ? o.label : undefined,
      selectors: sel,
    };
  }
  fail('login.type must be "none", "role" or "password"');
}

/** Combine the default and the configured deny patterns into one RegExp. */
export function denyRegex(extra: string[]): RegExp {
  const all = [...DEFAULT_DENY, ...extra];
  try {
    return new RegExp(all.join("|"), "i");
  } catch (e) {
    fail(`denyPatterns has an invalid regular expression: ${(e as Error).message}`);
  }
}

/**
 * Read the app config from the command line. `--config file.json` loads a file;
 * other flags override it. Without a file, a url plus `--login "Role"` still works.
 */
export function loadAppConfig(argv: string[]): AppConfig {
  let file: Record<string, unknown> = {};
  const flags: Record<string, string | true> = {};
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headless") flags.headless = true;
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
    else url = a;
  }
  if (typeof flags.config === "string") {
    try {
      file = JSON.parse(readFileSync(flags.config, "utf8"));
    } catch (e) {
      fail(`cannot read ${flags.config}: ${(e as Error).message}`);
    }
  }

  const finalUrl = url ?? (file.url as string | undefined);
  if (!finalUrl) fail("no url. Give a url or set `url` in the config file.");
  try {
    new URL(finalUrl);
  } catch {
    fail(`"${finalUrl}" is not a valid url`);
  }

  const login: LoginConfig =
    typeof flags.login === "string" ? { type: "role", role: flags.login } : validateLogin(file.login);

  const num = (v: unknown, d: number, name: string) => {
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) fail(`${name} must be a positive number`);
    return n;
  };

  const cfg: AppConfig = {
    name: typeof file.name === "string" ? file.name : undefined,
    url: finalUrl,
    login,
    denyPatterns: Array.isArray(file.denyPatterns) ? (file.denyPatterns as string[]) : DEFAULTS.denyPatterns,
    maxScreens: num(flags.max ?? file.maxScreens, DEFAULTS.maxScreens, "maxScreens"),
    perPattern: num(flags["per-pattern"] ?? file.perPattern, DEFAULTS.perPattern, "perPattern"),
    settleMs: num(file.settleMs, DEFAULTS.settleMs, "settleMs"),
    linkWaitMs: num(file.linkWaitMs, DEFAULTS.linkWaitMs, "linkWaitMs"),
    expandSelector: typeof file.expandSelector === "string" ? file.expandSelector : DEFAULTS.expandSelector,
    headless: flags.headless === true || file.headless === true,
    minConfidence: num(file.minConfidence, DEFAULTS.minConfidence, "minConfidence"),
    out: (flags.out as string) ?? (file.out as string | undefined) ?? DEFAULTS.out,
    knowledge: (flags.knowledge as string) ?? (file.knowledge as string | undefined),
  };
  denyRegex(cfg.denyPatterns); // fail early on a bad pattern
  return cfg;
}

/** Name used for the signed-in user in file names and titles. */
export function loginLabel(l: LoginConfig): string {
  if (l.type === "role") return l.role;
  if (l.type === "password") return l.label ?? "user";
  return "anonymous";
}
