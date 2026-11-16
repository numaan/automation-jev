import type { Page } from "playwright";

/** A value the run typed into a field, and the page text from just before it was typed. */
export interface Typed {
  value: string;
  before: string;
}

export interface TextCheck {
  verdict: "pass" | "fail" | "unsure";
  detail: string;
  /** Playwright expression for the generated spec. Empty means: write a note only. */
  locator: string;
}

/** Areas a criterion may name: `I should see "X" in the table`. */
const AREAS: Record<string, { css?: string; title?: boolean }> = {
  heading: { css: "h1, h2, h3, h4, h5, h6, [role=heading]" },
  title: { title: true },
  table: { css: "table, [role=table], [role=grid]" },
  list: { css: "ul, ol, [role=list]" },
  navigation: { css: "nav, aside" },
  nav: { css: "nav, aside" },
  sidebar: { css: "nav, aside" },
  dialog: { css: "[role=dialog], dialog" },
  modal: { css: "[role=dialog], dialog" },
  main: { css: "main, [role=main]" },
  "main content": { css: "main, [role=main]" },
  header: { css: "header, [role=banner]" },
  footer: { css: "footer, [role=contentinfo]" },
};

const SCOPE = /["']([^"']*)["']\s+(?:in|within|inside|under)\s+(?:the\s+)?(main content|heading|title|table|list|navigation|nav|sidebar|dialog|modal|main|header|footer)\b/i;

/** Split a criterion into the quoted text and the optional area. */
export function parseTextCriterion(raw: string): { q: string; area: string | null } | null {
  const scoped = raw.match(SCOPE);
  if (scoped) return { q: scoped[1], area: scoped[2].toLowerCase() };
  const m = raw.match(/"([^"]*)"|'([^']*)'/);
  const q = m ? (m[1] ?? m[2] ?? null) : null;
  return q === null ? null : { q, area: null };
}

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

/** Remove every case-insensitive occurrence of `v` from `text`. */
function without(text: string, v: string): string {
  const low = text.toLowerCase();
  const needle = v.toLowerCase();
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (needle && low.startsWith(needle, i)) i += needle.length;
    else out += text[i++];
  }
  return out;
}

/** How many elements the last area lookup matched (0 = the page has no such area). */
let lastAreaCount = 0;

/** Text of the area (or the whole page) as the user sees it now. */
async function areaText(page: Page, area: string | null): Promise<string> {
  const def = area ? AREAS[area] : undefined;
  if (def?.title) return page.title().catch(() => "");
  if (def?.css) {
    const parts = await page.locator(def.css).allInnerTexts().catch(() => [] as string[]);
    lastAreaCount = parts.length;
    return parts.join("\n");
  }
  return page.locator("body").innerText().catch(() => "");
}

/**
 * Check that quoted text is on the page (or in the named area). It waits up to
 * ~3 s for slow screens. When the text only appears because the page echoes a
 * value this run typed ("Nothing matches “abc”"), the result is `unsure`, not `pass`.
 */
export async function checkText(
  page: Page,
  q: string,
  area: string | null,
  typed: Typed[]
): Promise<TextCheck> {
  const def = area ? AREAS[area] : undefined;
  let text = "";
  for (let i = 0; i < 7; i++) {
    text = await areaText(page, area);
    if (has(text, q)) break;
    await page.waitForTimeout(500);
  }
  const where = area ? ` in the ${area}` : "";
  const locator = def?.title
    ? `expect((await page.title()).toLowerCase()).toContain(${JSON.stringify(q.toLowerCase())})`
    : def?.css
      ? `expect(page.locator(${JSON.stringify(def.css)}).filter({ hasText: ${JSON.stringify(q)} }).first()).toBeVisible()`
      : `expect(page.locator("body")).toContainText(${JSON.stringify(q)}, { ignoreCase: true })`;

  if (def?.css && lastAreaCount === 0) {
    return {
      verdict: "unsure",
      detail: `the page has no ${area} element, so "${q}" cannot be checked there; drop "in the ${area}" or mark up the page`,
      locator: "",
    };
  }
  if (!has(text, q)) return { verdict: "fail", detail: `text "${q}" not found${where}`, locator };

  // Echo guard: q is part of something this run typed.
  const echoes = typed.filter((t) => has(t.value, q));
  if (echoes.length > 0) {
    const existedBefore = echoes.some((t) => has(t.before, q));
    const outsideEcho = echoes.every((t) => has(without(text, t.value), q));
    if (!existedBefore && !outsideEcho) {
      return {
        verdict: "unsure",
        detail: `"${q}" appears only where the typed value is echoed; it is not proof`,
        locator: "",
      };
    }
  }
  return { verdict: "pass", detail: `text "${q}" found${where}`, locator };
}
