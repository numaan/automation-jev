# Requirements — Jev Playwright Recorder

## 1. Purpose

Let a person automate a web flow by **typing plain-English instructions**. The tool
uses **Jev** (TypeSafe's System One model) to decide which on-screen element each
instruction refers to, prompts the person to **enter a value or pick from options**
when needed, **performs the action live in the browser**, and **records every action
as a runnable Playwright script**.

Code owns the loop, the browser, and all execution. Jev supplies one thing: the
typed judgment "given this instruction and this screen, which element?" — returned
as a probability distribution, never as free-form text.

## 2. Users & goals

| User | Goal |
| --- | --- |
| QA / SDET | Build a Playwright regression script without hand-writing selectors. |
| Developer | Drive a flow in natural language and keep the generated spec in the repo. |
| Non-coder | Automate a repetitive web task by describing it. |

## 3. Functional requirements

### 3.1 Interactive mode (primary)
- **R1** — Accept a natural-language instruction per line (e.g. "click the login
  button", `type "you@x.com" into the email field`, "select India for country").
- **R2** — Extract the interactive elements of the current page (links, buttons,
  inputs, textareas, selects, ARIA-role widgets); ignore hidden/disabled elements.
- **R3** — Use Jev (a `Choice` over the extracted elements) to pick the element the
  instruction refers to, with a confidence score.
- **R4** — When confidence ≥ a threshold, perform the action automatically.
- **R5** — When confidence is below the threshold (ambiguous, or nothing fits well),
  present a **numbered list of candidate elements** for the person to choose from,
  or skip.
- **R6 (enter a value)** — For a text field, take the value from a quoted literal in
  the instruction if present, otherwise **prompt the person to type it**.
- **R7 (select from options)** — For a `<select>`, use Jev to pick the option that
  matches the instruction; if unsure, **list the options** for the person to choose.
- **R8** — Perform the chosen action in the browser (click / fill / selectOption).
- **R9** — Record each performed action and, on save/exit, emit a standalone
  `@playwright/test` spec.
- **R10** — Provide commands: `:goto <url>`, `:show`, `:save [path]`, `:undo`,
  `:help`, `:quit`.

### 3.2 Autonomous mode (secondary)
- **R11** — Given a goal + start URL + data in a task file, drive the flow to
  completion without per-step input, using Jev to choose each action and a `Noul`
  to decide when the goal is met. Emit the same kind of script.

### 3.3 Generated script
- **R12** — Prefer readable semantic locators (`getByRole`, `getByLabel`,
  `getByPlaceholder`); fall back to a unique CSS path when a semantic locator is not
  uniquely the extracted element.
- **R13** — The generated spec must run under `@playwright/test` unmodified except
  for an assertion the person adds.

## 4. Non-functional requirements

- **N1 — Safety.** Never solve CAPTCHAs or bot checks. When confidence is low, stop
  or ask rather than click blindly. The confidence gate is the primary guard.
- **N2 — Secrets.** The TypeSafe API key is read from the environment
  (`TYPESAFE_API_KEY`) and never sent to the browser or written to the script.
- **N3 — Scope of test data.** Intended for the person's own flows with test data;
  not for entering real third-party credentials.
- **N4 — Determinism of replay.** Recording drives a live browser; the emitted
  script replays without Jev. Sites with randomized DOM/anti-bot (e.g. Google) may
  not replay reliably — a known limitation, not a defect.
- **N5 — Cost/latency.** One Jev request per instruction (a second only when a
  dropdown option must be chosen). Keep requests minimal.

## 5. Architecture

```
instruction ─▶ extract elements ─▶ Jev Choice: which element? ─▶ confidence gate
                                                                   │
                                          high │                   │ low
                                               ▼                   ▼
                              value? (quoted / prompt /       numbered menu
                              Jev option Choice)              (person picks)
                                               │
                                               ▼
                              Playwright click / fill / selectOption
                                               │
                                               ▼
                              record step ─▶ emit *.spec.ts
```

| Module | Responsibility |
| --- | --- |
| `src/extract.ts` | Browser-side element extraction + locator/description helpers. |
| `src/interpret.ts` | Jev judgments: element target (`Choice`), dropdown option (`Choice`). |
| `src/jev.ts` | Jev judgments for autonomous mode (`Choice` + `Noul`). |
| `src/locators.ts` | Exact execution locator + verified semantic locator for the script. |
| `src/emit.ts` | Render recorded steps to a Playwright spec. |
| `src/interactive.ts` | The REPL: prompts, menus, execution, recording. |
| `src/recorder.ts` | Autonomous goal-driven loop. |

## 6. Design decisions & rationale

- **No "none of these" option in the target `Choice`.** Including one badly
  destabilizes the distribution (a clear match can collapse to ~0.4). A real match
  scores ~1.0; an instruction that fits nothing spreads out and lowers confidence,
  so the confidence gate handles no-match without a synthetic option.
- **Quoted literals are stripped before the target judgment.** A quoted value is
  what to type/select, not a clue to which element; stripping it keeps the target
  pick clean while the value is still read separately.
- **Act on the exact extracted element (CSS path); write the pretty locator only
  when verified.** Semantic locators are often ambiguous on real pages, so they
  must not decide what gets clicked — only how the script reads.

## 7. Out of scope (current)

- Assertions/expectations are left as a TODO in the generated script.
- Checkboxes/radios are treated as clicks; file uploads, drag-and-drop, and iframes
  are not yet handled.
- No parallel/multi-tab flows.

## 8. Acceptance criteria

- Typing the four instructions in §3.1 against a login/registration form fills both
  fields, selects the dropdown option, clicks submit, and the emitted spec replays
  those steps with semantic locators. *(Verified on a local form: all steps at
  confidence 1.00.)*
