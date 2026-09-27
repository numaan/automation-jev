import type { Locator, Page } from "playwright";
import type { Candidate } from "./types.js";
import { locatorSource } from "./extract.js";

/**
 * Locator used to ACT: the exact element we extracted, addressed by its unique CSS
 * path. Semantic locators (getByLabel/getByRole) read well but are often ambiguous
 * on real pages (e.g. "Search" matches several elements on Google), so they must
 * not decide which element we act on.
 */
export function executionLocator(page: Page, c: Candidate): Locator {
  return page.locator(c.css).first();
}

/** The semantic locator, as a live Locator, for the identity check below. */
function semanticLocator(page: Page, c: Candidate): Locator | null {
  if (c.kind === "fill" || c.kind === "select") {
    if (c.ariaLabel) return page.getByLabel(c.ariaLabel);
    if (c.name && c.name !== c.placeholder) return page.getByLabel(c.name);
    if (c.placeholder) return page.getByPlaceholder(c.placeholder);
    return null;
  }
  if ((c.role === "button" || c.role === "link") && c.name) {
    return page.getByRole(c.role as "button" | "link", { name: c.name });
  }
  return null;
}

/**
 * Choose the locator source to write into the generated script. Prefer the
 * readable semantic locator, but only when it resolves to exactly one element and
 * that element IS the one we extracted; otherwise fall back to the exact CSS path
 * so the generated script targets the same element we actually acted on.
 */
export async function scriptLocatorFor(page: Page, c: Candidate): Promise<string> {
  const cssSource = `page.locator(${JSON.stringify(c.css)})`;
  const sem = semanticLocator(page, c);
  if (!sem) return locatorSource(c); // already CSS/text based
  try {
    if ((await sem.count()) !== 1) return cssSource;
    const handle = await sem.first().elementHandle();
    if (!handle) return cssSource;
    const same = await executionLocator(page, c).evaluate(
      (el, other) => el === other,
      handle
    );
    return same ? locatorSource(c) : cssSource;
  } catch {
    return cssSource;
  }
}
