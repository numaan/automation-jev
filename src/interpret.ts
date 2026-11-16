import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import type { Candidate, SelectOption } from "./types.js";
import { describe } from "./extract.js";

const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY from the environment

export interface TargetDecision {
  /** Best-matching candidate id. */
  pick: string;
  /** Distribution concentration; low means the caller should let the user pick. */
  confidence: number;
  /** Candidate ids ordered by probability, best first. */
  ranked: string[];
  probabilities: Record<string, number>;
}

/**
 * Given a natural-language instruction and the current screen, ask Jev which
 * single element the instruction refers to. Returns the best pick, its
 * confidence, and a ranked list so the caller can offer alternatives when Jev
 * is unsure. This is the "understand what the user meant" judgment; code owns
 * what to do with it (act, or ask the user to disambiguate).
 *
 * The Choice deliberately has NO "none of these" option: including one badly
 * destabilizes the distribution (a real match can collapse to ~0.4). Instead,
 * a genuine match scores ~1.0 while an instruction that fits nothing spreads the
 * distribution and lowers confidence, so the caller's confidence gate — not a
 * synthetic option — handles the no-match case.
 */
export async function interpretInstruction(params: {
  instruction: string;
  currentUrl: string;
  pageTitle: string;
  history: string[];
  candidates: Candidate[];
}): Promise<TargetDecision> {
  const { instruction, currentUrl, pageTitle, history, candidates } = params;

  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c.id] = describe(c);

  // A quoted literal is the value to type/select, not a clue to which element.
  // Strip it so it can't distract the target judgment (the caller still reads it
  // for the value itself).
  const forTarget = instruction.replace(/"[^"]*"|'[^']*'/g, " ").replace(/\s+/g, " ").trim();

  const response = await client.systemOne({
    state: {
      userInstruction: forTarget || instruction,
      currentUrl,
      pageTitle,
      actionsSoFar: history,
    },
    questions: {
      target: choice(
        "The user's instruction is in `userInstruction`. Which single element " +
          "should the action be performed on to carry it out?",
        criteria
      ),
    },
  });

  const ans = response.answers.target;
  const ranked = Object.entries(ans.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  return {
    pick: ans.choice,
    confidence: ans.confidence,
    ranked,
    probabilities: ans.probabilities,
  };
}

export interface OptionDecision {
  option: SelectOption | null;
  confidence: number;
  ranked: SelectOption[];
}

/**
 * For a <select> (or any fixed option list), ask Jev which option best matches
 * what the user asked for. Used to pre-select the likely choice; the caller can
 * still show the full list for the user to confirm or override.
 */
export async function chooseOption(params: {
  instruction: string;
  field: Candidate;
  options: SelectOption[];
}): Promise<OptionDecision> {
  const { instruction, field, options } = params;
  if (options.length === 0) return { option: null, confidence: 0, ranked: [] };

  // Option labels may repeat or be empty; key by index to stay unambiguous.
  const criteria: Record<string, string> = {};
  options.forEach((o, i) => {
    criteria[`opt_${i}`] = o.label || o.value || `(option ${i})`;
  });

  const response = await client.systemOne({
    state: {
      userInstruction: instruction,
      fieldLabel: field.name,
    },
    questions: {
      whichOption: choice(
        "The user's instruction is in `userInstruction`. Which of these dropdown " +
          "options does the user want selected?",
        criteria
      ),
    },
  });

  const ans = response.answers.whichOption;
  const ranked = Object.entries(ans.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => options[Number(k.slice(4))])
    .filter(Boolean);
  const picked = options[Number(ans.choice.slice(4))] ?? null;

  return { option: picked, confidence: ans.confidence, ranked };
}

export interface ScreenDecision {
  pick: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/**
 * Given one acceptance-criterion step and what the explorer knows about every
 * screen, ask the model which screen the step belongs on. Screen ids are the
 * hrefs. The caller prefers the current screen when the step continues there.
 */
export async function chooseScreen(params: {
  step: string;
  currentScreen: string | null;
  previousSteps: string[];
  screens: Record<string, string>; // id -> description
  /** True when the step only moves to a screen ("go to X"): the answer is the destination. */
  navigate?: boolean;
}): Promise<ScreenDecision> {
  const { step, currentScreen, previousSteps, screens, navigate } = params;
  const forTarget = step.replace(/"[^"]*"|'[^']*'/g, " ").replace(/\s+/g, " ").trim();
  const response = await client.systemOne({
    state: {
      acceptanceCriterionStep: forTarget || step,
      // A navigation step must not see the current screen, or the model stays put.
      ...(navigate ? {} : { currentScreen: currentScreen ?? "none", previousSteps }),
    },
    questions: {
      screen: choice(
        navigate
          ? "Which screen of the application does this step ask the user to go to?"
          : "Which screen of the application is this acceptance-criterion step " +
              "performed on or about? Choose the current screen if the step continues there.",
        screens
      ),
    },
  });
  const a = response.answers.screen;
  return { pick: a.choice, confidence: a.confidence, probabilities: a.probabilities };
}

/**
 * Judge a free-text statement ("the page lists the agent") against the visible
 * text of the current page. Returns the probability that the statement is true.
 */
export async function judgeStatement(params: {
  statement: string;
  url: string;
  pageText: string;
}): Promise<number> {
  const response = await client.systemOne({
    state: {
      statement: params.statement,
      currentUrl: params.url,
      visiblePageText: params.pageText.slice(0, 4000),
    },
    questions: {
      holds: noul("Is the statement in `statement` true for the page shown in `visiblePageText`?"),
    },
  });
  return response.answers.holds.noul;
}
