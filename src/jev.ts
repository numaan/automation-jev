import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import type { Candidate } from "./types.js";
import { describe } from "./extract.js";

const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY from the environment

/** Special Choice options that are not page elements. */
export const DONE = "__DONE__";
export const GIVE_UP = "__GIVE_UP__";

export interface Decision {
  /** Candidate id, or DONE / GIVE_UP. */
  pick: string;
  confidence: number;
  /** Jev's probability that the goal is already complete. */
  goalComplete: number;
  probabilities: Record<string, number>;
}

/**
 * Ask Jev, in a single request, two independent judgments over the same screen:
 *   1. which element (if any) to interact with next to advance the goal, and
 *   2. whether the goal is already complete.
 * The two questions run in parallel and cannot see each other's answers.
 */
export async function decideNextAction(params: {
  goal: string;
  currentUrl: string;
  pageTitle: string;
  history: string[];
  candidates: Candidate[];
  data: Record<string, string>;
}): Promise<Decision> {
  const { goal, currentUrl, pageTitle, history, candidates, data } = params;

  // Each candidate becomes one Choice option; the description is what Jev reads.
  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c.id] = describe(c);
  criteria[DONE] = "The goal is already accomplished; stop and do nothing.";
  criteria[GIVE_UP] =
    "None of the elements can plausibly advance the goal from this screen.";

  const state = {
    goal,
    availableData: Object.keys(data), // meaning of data we can type, not the values
    currentUrl,
    pageTitle,
    stepsTakenSoFar: history,
  };

  const response = await client.systemOne({
    state,
    questions: {
      action: choice(
        "Given the goal and the current screen, which single element should be " +
          "interacted with next to make progress? Prefer the element a careful " +
          "human would click or fill at this step. Choose " +
          `${DONE} if the goal is already met, or ${GIVE_UP} if nothing here helps.`,
        criteria
      ),
      goalComplete: noul(
        "Considering the goal, the current URL, the page title and the steps " +
          "already taken, has the goal already been fully accomplished?"
      ),
    },
  });

  const action = response.answers.action;
  return {
    pick: action.choice,
    confidence: action.confidence,
    probabilities: action.probabilities,
    goalComplete: response.answers.goalComplete.noul,
  };
}

/**
 * When Jev chose an input field, a second request decides which piece of data to
 * type into it. This is a legitimate follow-up: the set of relevant data values
 * only becomes defined once we know which field was selected.
 */
export async function chooseValueFor(params: {
  goal: string;
  field: Candidate;
  data: Record<string, string>;
}): Promise<{ key: string | null; confidence: number }> {
  const { goal, field, data } = params;
  const keys = Object.keys(data);
  if (keys.length === 0) return { key: null, confidence: 1 };

  const criteria: Record<string, string> = {};
  for (const k of keys) criteria[k] = `Use the value provided for "${k}".`;
  const SKIP = "__SKIP__";
  criteria[SKIP] = "None of these values belongs in this field.";

  const response = await client.systemOne({
    state: {
      goal,
      field: describe(field),
      fieldLabel: field.name,
      fieldType: field.inputType ?? "text",
    },
    questions: {
      whichValue: choice(
        "Which of the available data values should be typed into this input field?",
        criteria
      ),
    },
  });

  const ans = response.answers.whichValue;
  return {
    key: ans.choice === SKIP ? null : ans.choice,
    confidence: ans.confidence,
  };
}
