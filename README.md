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

Two modes. See [requirement.md](requirement.md) for the full spec.

### Interactive mode — type instructions in plain English

```bash
npm run interactive -- https://example.com/login
```

Then type instructions at the `jev>` prompt. Jev picks the element; you're prompted
for a value or to pick an option when needed; the action runs in the browser and is
recorded.

```
jev> type "you@example.com" into the email field
  Jev → input field labelled "Email address"  (confidence 1.00)
  ✓ filled "Email address"
jev> enter my password
  Jev → input field labelled "Password"  (confidence 1.00)
  Value for "Password": ······
  ✓ filled "Password"
jev> select India for country
  Jev → select "India" (confidence 1.00)
  ✓ selected "India"
jev> click the sign in button
  ✓ clicked "Sign in"
jev> :quit
  ✔ 4 steps → generated/interactive.spec.ts
```

When Jev isn't confident, it lists the candidate elements and asks you to pick a
number (or skip). Commands: `:goto <url>`, `:show`, `:save [path]`, `:undo`,
`:help`, `:quit`. Flags: `--headless`, `--out <path>`, `--min <0..1>`.

### Autonomous mode — goal + data in a task file

Edit `task.example.json` (or make your own), then:

```bash
npm run record -- task.example.json
```

Set `"headless": true` to run silently. The generated script lands at the task's
`out` path. Run either mode's output like any Playwright test:

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
