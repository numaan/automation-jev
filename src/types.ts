export type Kind = "click" | "fill" | "select";

export interface SelectOption {
  value: string;
  label: string;
}

/** A candidate interactive element on the current page. */
export interface Candidate {
  /** Stable id used as the Choice option key, e.g. "el_3". */
  id: string;
  kind: Kind;
  tag: string;
  role: string;
  /** Accessible name / visible text. */
  name: string;
  inputType?: string;
  placeholder?: string;
  ariaLabel?: string;
  href?: string;
  value?: string;
  /** Options for a <select> element. */
  options?: SelectOption[];
  /** Unique CSS selector, used as the execution fallback. */
  css: string;
}

/** A recorded step, both executed live and emitted into the script. */
export interface Step {
  action: "goto" | "click" | "fill" | "select";
  /** Playwright locator source used in the generated script, e.g. getByRole(...). */
  locator: string;
  value?: string;
  url?: string;
  /** Human note for comments in the generated script. */
  note: string;
}

export interface Task {
  /** The natural-language objective Jev optimizes toward. */
  goal: string;
  startUrl: string;
  /** Values available to type into fields, keyed by meaning. */
  data?: Record<string, string>;
  maxSteps?: number;
  /** Min Choice confidence required before acting on a pick. */
  minConfidence?: number;
  /** Noul threshold above which the goal is treated as complete. */
  doneThreshold?: number;
  /** Run the browser headless. Default false so you can watch it. */
  headless?: boolean;
  /** Output path for the generated Playwright spec. */
  out?: string;
}
