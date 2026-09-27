# Jev Playwright Recorder

Drive a real browser with **Playwright**, let **Jev** (TypeSafe's System One model)
decide which link/button/field to act on at each screen, and emit a runnable
`@playwright/test` script from what actually happened.

Code owns the loop and the browser. Jev supplies one judgment per screen:
*"given this goal and these elements, which one moves us forward?"* — returned as a
typed `Choice` with a probability distribution, not free-form text.

## How it works

```
 ┌─────────────────────────────────────────────────────────────┐
 │ loop (max N steps)                                           │
 │                                                             │
 │  Playwright ──extract──▶ candidate elements (links,         │
 │                          buttons, inputs) + goal + history  │
 │                              │                              │
 │                              ▼                              │
 │   Jev.systemOne  ─ Choice: which element? (+ DONE/GIVE_UP)  │
 │   (one request)  └ Noul:   is the goal complete?           │
 │                              │                              │
 │            pick a fill field?├─▶ 2nd Jev Choice: which data │
 │                              │    value goes in it?         │
 │                              ▼                              │
 │  Playwright ──click/fill──▶ record step ──▶ append to script │
 └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                generated/<name>.spec.ts
```

Why two Jev primitives:

- **`Choice`** over the on-screen elements is the "which button" decision. Its
  `confidence` (how concentrated the distribution is) gates whether we act — a low
  score stops the run instead of clicking blindly.
- **`Noul`** ("is the goal done?") is asked in the *same request*, in parallel, so
  the loop knows when to stop without an extra round trip.
- A **second `Choice`** maps a chosen input field to a data value. It's a separate
  request on purpose: the relevant values are only defined once the field is known.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env    # then put your TYPESAFE_API_KEY in it
```

## Run

Edit `task.example.json` (or make your own), then:

```bash
npm run record -- task.example.json
```

Watch it navigate (set `"headless": true` to run silently). The generated script
lands at the task's `out` path, e.g. `generated/login.spec.ts`. Run it like any
Playwright test:

```bash
npx playwright test generated/
```

## Task file

| Field | Meaning |
| --- | --- |
| `goal` | Natural-language objective Jev optimizes toward. |
| `startUrl` | Where the run begins. |
| `data` | Values Jev may type, keyed by meaning (`email`, `password`, …). Jev sees the **keys**, code supplies the values. |
| `maxSteps` | Safety cap on loop iterations. |
| `minConfidence` | Below this Choice confidence, stop rather than guess. |
| `doneThreshold` | Noul ≥ this ⇒ goal treated as complete. |
| `headless` | Run the browser without a window. |
| `out` | Output path for the generated spec. |

## Notes & tuning

- **Two artifacts, one run:** the live navigation *and* a deterministic script. Re-run
  the script without Jev; re-run the recorder when the UI changes.
- **Locators:** the recorder prefers semantic locators (`getByRole`, `getByLabel`)
  and falls back to a unique CSS path, so generated scripts stay readable.
- **Thresholds are starting points.** Calibrate `minConfidence` / `doneThreshold` on
  your own site and the cost of a wrong click, per the TypeSafe confidence docs.
- **Keep the API key server-side.** It's read from the environment, never sent to the
  browser.
- **This only fills test data into the flow you point it at.** Don't feed it real
  credentials for third-party sites.
```

Built against the TypeSafe JS SDK (`@typesafe-ai/sdk`) and its Choice/Noul primitives.
See https://docs.typesafe.ai for the current API.
