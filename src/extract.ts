import type { Page } from "playwright";
import type { Candidate } from "./types.js";

type RawCandidate = Omit<Candidate, "id">;

/**
 * Browser-side extraction, kept as a string on purpose.
 *
 * Playwright serializes a passed function to run it in the page. When this file
 * is executed through a bundler (tsx/esbuild), the bundler rewrites named inner
 * functions with a module-scoped `__name()` helper that does NOT exist in the
 * page context, so a passed *function* throws "__name is not defined". Passing
 * the code as a plain string sidesteps the transform entirely — it's the robust
 * way to ship non-trivial in-page logic. (No type checking here; that's inherent
 * to code that runs in the browser, not Node.)
 */
const EXTRACT_JS = String.raw`(() => {
  function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== "html") {
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) sel += ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    return true;
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ").trim();
      if (t) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lbl && lbl.textContent) return lbl.textContent.trim();
      }
      const wrap = el.closest("label");
      if (wrap && wrap.textContent) return wrap.textContent.trim();
      if (el.placeholder) return el.placeholder.trim();
      return (el.getAttribute("name") || "").trim();
    }
    // Visible text names a button or link; title is only the fallback (as in the
    // browser's accessible-name rules). Title first hid names like "Agent Developer".
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (text) return text;
    const title = el.getAttribute("title");
    return title ? title.trim() : "";
  }

  const CLICK_SEL = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], summary';
  const FILL_SEL = 'input:not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select, [contenteditable="true"]';

  const seen = new Set();
  const out = [];

  function push(el, kind) {
    if (seen.has(el) || !visible(el)) return;
    if (el.disabled) return;
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const implicitRole = tag === "a" ? "link" : tag === "button" ? "button" : tag;
    const realKind = tag === "select" ? "select" : kind;
    let options;
    if (tag === "select") {
      options = Array.from(el.options || []).map((o) => ({
        value: o.value,
        label: (o.textContent || o.value || "").replace(/\s+/g, " ").trim(),
      }));
    }
    out.push({
      kind: realKind,
      tag: tag,
      role: el.getAttribute("role") || implicitRole,
      name: accessibleName(el),
      inputType: el.getAttribute("type") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      href: (typeof el.getAttribute === "function" ? el.getAttribute("href") : null) || undefined,
      value: el.value || undefined,
      options: options,
      css: cssPath(el),
    });
  }

  document.querySelectorAll(FILL_SEL).forEach((el) => push(el, "fill"));
  document.querySelectorAll(CLICK_SEL).forEach((el) => push(el, "click"));
  return out;
})()`;

/**
 * Collect visible, interactive elements from the current page: links, buttons,
 * inputs and ARIA-role widgets a user could actually see and use, each with a
 * lightweight descriptor and a unique CSS selector.
 */
export async function extractCandidates(page: Page): Promise<Candidate[]> {
  const raw = (await page.evaluate(EXTRACT_JS)) as RawCandidate[];
  return raw
    .filter((c) => c.kind === "fill" || c.name.length > 0)
    .slice(0, 200) // Choice supports up to 255 options; stay well under.
    .map((c, i) => ({ ...c, id: `el_${i}` }));
}

/** Build the Playwright locator source string used in the generated script. */
export function locatorSource(c: Candidate): string {
  const q = (s: string) => JSON.stringify(s);
  if (c.kind === "fill" || c.kind === "select") {
    if (c.ariaLabel) return `page.getByLabel(${q(c.ariaLabel)})`;
    if (c.name && c.name !== c.placeholder) return `page.getByLabel(${q(c.name)})`;
    if (c.placeholder) return `page.getByPlaceholder(${q(c.placeholder)})`;
    return `page.locator(${q(c.css)})`;
  }
  if ((c.role === "button" || c.role === "link") && c.name) {
    return `page.getByRole(${q(c.role)}, { name: ${q(c.name)} })`;
  }
  if (c.name) return `page.getByText(${q(c.name)}, { exact: false })`;
  return `page.locator(${q(c.css)})`;
}

/** A short human-readable description used both for Jev criteria and comments. */
export function describe(c: Candidate): string {
  const kindLabel =
    c.kind === "fill" ? "input field" : c.kind === "select" ? "dropdown" : c.role;
  const bits = [kindLabel];
  if (c.name) bits.push(`labelled "${c.name}"`);
  if (c.inputType) bits.push(`(type=${c.inputType})`);
  if (c.href) bits.push(`-> ${c.href}`);
  if (c.kind === "select" && c.options?.length) {
    const sample = c.options.slice(0, 6).map((o) => o.label).filter(Boolean);
    bits.push(`options: ${sample.join(", ")}${c.options.length > 6 ? ", …" : ""}`);
  } else if (c.value) {
    bits.push(`current value: "${c.value}"`);
  }
  return bits.join(" ");
}
