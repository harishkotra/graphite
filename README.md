# GRAPHITE

**Two models get the same CSV. Both write matplotlib code. A sandbox runs it. A judge picks the chart that actually answers the question.**

Most "AI battles" compare vibes. Graphite compares *artifacts*: one of the two models runs, one of them crashes, and the measured properties of each rendered PNG — axes, labels, colours, figure size — say who actually did the work. It is a model-progression demo (older model in slot A, newer model in slot B) with visual proof, built to be screen-recorded.

https://github.com/user-attachments/assets/bd2aefc2-e472-4ef5-a0e9-a28507097526

<img width="1858" height="1669" alt="screencapture-localhost-5173-2026-09-25-17_56_00" src="https://github.com/user-attachments/assets/06c366a2-4799-47fe-be64-e65230d53f2b" />
<img width="1858" height="2805" alt="screencapture-localhost-5173-2026-09-25-17_56_18" src="https://github.com/user-attachments/assets/a9cef273-e9f9-41b0-8764-9aec77dac02b" />
<img width="1858" height="2601" alt="screencapture-localhost-5173-2026-09-25-18_19_34" src="https://github.com/user-attachments/assets/17d794c8-8cdb-4593-bb1d-b4e532484889" />
<img width="1685" height="1158" alt="Screenshot at Sep 25 18-20-54" src="https://github.com/user-attachments/assets/13323b15-d829-4c9a-9f91-626b420dbeeb" />


---

## Table of contents

1. [The idea](#the-idea)
2. [Technologies](#technologies)
3. [Architecture](#architecture)
4. [Quickstart](#quickstart)
5. [Providers & capability detection](#providers--capability-detection)
6. [The execution sandbox](#the-execution-sandbox)
7. [Honest measurement](#honest-measurement)
8. [The judge](#the-judge)
9. [API reference](#api-reference)
10. [Project structure](#project-structure)
11. [Verification log](#verification-log)
12. [Contributing](#contributing)

---

## The idea

Every model in the arena receives **byte-identical input**:

- the same system prompt (`"You are a precise assistant. Answer the user's request directly."`),
- the same user prompt — a preview of `data/data.csv` inline, the note *"the full file is at ./data.csv"*, the question, and a **fresh random nonce** (so provider-side response caches can't fake determinism),
- the same temperature and token budget.

Each model answers with **Python code only**. The sandbox executes both snippets. The UI then shows, side by side:

| What you see | Where it comes from |
| --- | --- |
| The rendered chart | a real PNG produced by the sandboxed process |
| RAN / CRASHED / BLOCKED / TIMEOUT badge | the actual exit status |
| Runtime in ms | wall-clock around the subprocess |
| The code | exactly what the model returned, fences stripped |
| Python traceback | verbatim stderr, on crash |
| Measured properties | live matplotlib objects + the PNG header, **never** the model's code |
| Judge scorecard | a third model call at temperature 0 over the *measured properties* |

The dataset (`data/data.csv`, 215 rows) is a small product team's build log with two real signals buried in it: a step change when a remote build cache was enabled, and Swift builds that run 2–4× slower than everything else. A good chart finds those; a bad chart plots noise.

---

## Technologies

| Layer | Tech | Why |
| --- | --- | --- |
| Frontend | Vite 7 + React 19 + TypeScript, plain DOM, zero UI libraries | the PNGs are the star; no three.js, no chart libs |
| Styling | hand-rolled CSS (custom properties, no framework) | a deliberate graphite-and-paper identity |
| Model gateway | Node + TypeScript, plain `fetch`, **no SDK**, zero runtime deps | OpenAI-compatible `/chat/completions` only |
| Executor | Python 3 + FastAPI + uvicorn | subprocess isolation, `resource.setrlimit`, Seatbelt |
| Data plane | pandas + matplotlib (Agg backend) inside the sandbox | what the models write against |
| Transport | Vite dev proxy → gateway → executor | local providers need no CORS, keys never hit the client |

Model calls are plain HTTP POSTs to any OpenAI-compatible endpoint — no SDK, no vendor lock-in.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Browser — http://localhost:5173                                           │
│  Vite + React + TS                                                         │
│                                                                            │
│  ┌ question + 4 presets ┐   ┌ 3 slot editors (A / B / Judge) ┐             │
│  │ same-model toggle    │   │ provider · base URL · key · model│             │
│  └──────────┬───────────┘   └──────────┬───────────────────────┘             │
│             │  POST /api/graphite      │  POST /api/models (live list)       │
└─────────────┼──────────────────────────┼─────────────────────────────────────┘
              │        /api/* is proxied by Vite to :3001                       │
              ▼                                                                  │
┌────────────────────────────────────────────────────────────────────────────┐
│  Node gateway — http://127.0.0.1:3001   (server/gateway.ts)                │
│                                                                            │
│  • builds ONE prompt (data preview + question + nonce)                     │
│  • asserts zero prompt reuse (Set of sha256s)                              │
│  • calls slot A and slot B CONCURRENTLY                                    │
│  • strips reasoning_content at this boundary — only token counts survive   │
│  • retries empty-content responses with a doubled budget (cap 4000)        │
│  • judge call at temperature 0 with measured properties                    │
└──────┬──────────────────────────────┬──────────────────────────────────────┘
       │ POST /execute, /api/execute  │  plain fetch, OpenAI-compatible
       ▼                              ▼
┌───────────────────────────────┐   ┌──────────────────────────────────────────┐
│  FastAPI executor — :8000     │   │  Providers (your keys, your machines)    │
│  (backend/executor.py)        │   │                                          │
│                               │   │  Particle.ai   api.particle.ai/v1        │
│  temp dir with ONLY:          │   │  Ollama        127.0.0.1:11434/v1        │
│    data.csv                   │   │  LM Studio     127.0.0.1:1234/v1         │
│    user_code.py               │   │  OpenRouter    openrouter.ai/api/v1      │
│    _runner.py   ◄─ harness    │   │  Custom        anything /v1              │
│                               │   │                                          │
│  AST allowlist → run → kill   │   │  /v1/chat/completions                    │
│  at 20 s · 512 MB · no net    │   └──────────────────────────────────────────┘
│                               │
│  returns: pngBase64, stdout,  │
│  stderr, traceback, runtimeMs,│
│  figureMeta, pngInfo          │
└───────────────────────────────┘
```

Run flow state machine in the UI:

```
idle → asking → executing → judging → finished
                    ↘ (crash) repair pass ↗      error (anywhere)
```

---

## Quickstart

```bash
# 1. clone and install
git clone <your-fork> graphite && cd graphite
npm install

# 2. python side
python3 -m venv .venv
.venv/bin/pip install fastapi "uvicorn[standard]" pandas matplotlib

# 3. run all three processes
npm run dev          # web :5173 + gateway :3001 + executor :8000
```

Open **http://localhost:5173**, paste an API key into slot A/B (or point a slot at a local Ollama/LM Studio — no key needed), pick a preset question, hit **Run both models**.

Ports are overridable without touching code:

```bash
GRAPHITE_GATEWAY_PORT=3011 pnpm run dev:gateway          # gateway elsewhere
GRAPHITE_GATEWAY=http://127.0.0.1:3011 pnpm run dev:web  # point the proxy there
```

Offline? `scripts/mock-provider.mjs` is a tiny OpenAI-compatible fake (working model, crashing model, empty-budget model, blocked model) — point a Custom slot at `http://127.0.0.1:8100/v1` and the whole pipeline runs without any key.

---

## Providers & capability detection

Three slots — **A** (older model), **B** (newer model), **Judge** — each with its own provider, base URL, key and model name, persisted to `localStorage`. Detection, never assumptions:

```ts
// reasoning tokens: read from usage, or null → the UI shows "n/a" and
// hides the thinking toggle for that slot. Never 0, never invented.
const reasoningTokens =
  typeof usage?.completion_tokens_details?.reasoning_tokens === "number"
    ? usage.completion_tokens_details.reasoning_tokens
    : null;
```

```ts
// the thinking switch goes to EXACTLY ONE provider+model family
if (
  settings.disableReasoning &&
  slot.provider.toLowerCase() === "particle" &&
  slot.model.toLowerCase().startsWith("deepseek-")
) {
  body.chat_template_kwargs = { enable_thinking: false };
}
```

- **Model pickers** are populated from `GET {base_url}/models` **and** always accept a hand-typed name — `deepseek-v4-flash-0731` does not appear in Particle's `/models` list and still responds. A dead `/models` never gates a run.
- **Empty content on HTTP 200** means the hidden CoT ate the budget → retry once with double tokens, cap 4000. Not a refusal.
- **`reasoning_content`** (the CoT text) is stripped at the gateway boundary: never logged, never displayed, never persisted. Only its token count survives.
- **Dead local servers** produce the provider's real error: `Cannot reach http://127.0.0.1:11434 — is the local provider running? (fetch failed)`.
- **Nonces**: every prompt ends with `(run nonce: <hex>)` and the gateway keeps a `Set` of prompt hashes — a repeat throws `prompt reuse detected`. Repeated-run experiments measure the model, not the cache.

---

## The execution sandbox

`POST /execute { code }` — best-effort, **not a security boundary** (see the warning in the UI and below).

**Layer 1 — static rejection.** The AST allowlist inspects every `Import`, `ImportFrom`, `Call` and `Attribute` node before a single byte executes:

```python
BLOCKED_MODULES = {"os", "subprocess", "socket", "shutil", "requests",
                   "urllib", "pathlib", "ctypes", "importlib", ...}
DANGEROUS_BUILTINS = {"eval", "exec", "compile", "open", "input", "__import__", ...}
DANGEROUS_ATTRS = {"system", "popen", "environ", "connect", "rmtree", ...}
```

```python
>>> analyze("import socket")
[{'kind': 'import', 'detail': "import of blocked module 'socket'", 'line': 1}]
```

Violations are returned to the UI as a `BLOCKED` badge with the exact rule named — the model's mistake becomes part of the story instead of a stack trace.

**Layer 2 — process isolation.** The snippet runs in a fresh temp dir containing *only* `data.csv`, `user_code.py` and the harness runner, with a scrubbed environment (`HOME=tmp`, `TMPDIR=tmp`, `MPLBACKEND=Agg`), a 512 MB `RLIMIT_AS`, and a 20 s hard kill. On macOS the child is wrapped in `sandbox-exec` with `(deny network*)`; if the host refuses to nest sandboxes (containers, CI), the executor falls back to the remaining layers and reports `seatbelt: false`.

**Layer 3 — the harness runner.** `_runner.py` patches `Figure.__init__` to track every figure, then captures the PNG however the model chose to emit it: `savefig(sys.stdout.buffer)`, `savefig("chart.png")`, or nothing at all (open figures are rendered as a courtesy). It prints one machine-readable line:

```
__FIG_META__ [{"figsize_in":[10,5.5],"dpi":110,"axes":1,"lines":3,"patches":0,
               "titles":1,"xlabels":1,"ylabels":1,"legends":1,
               "distinctColors":["#2563eb","#9aa0a6","#e05c4f"]}]
```

> **⚠️ Best-effort means best-effort.** A static allowlist is not a VM. If the code is untrusted, run the executor inside a container. The UI says so; this README says so; don't skip it.

---

## Honest measurement

The comparison is only as honest as its measurements, so they are taken from the **artifact**, never the source:

- **figure metadata** — read from the live `Figure` objects inside the sandboxed process (axes, lines, patches, collections, title/label/legend presence, distinct colours resolved through `matplotlib.colors`);
- **PNG dimensions** — decoded from the `IHDR` chunk of the captured bytes;
- **runtime** — wall-clock around the subprocess.

Proof: a snippet that *claims* `"9 axes, 42 colours, legend present"` in strings and comments measures **1 axis, 1 colour, no legend**. The code can lie; the figure can't.

---

## The judge

One extra model slot, called at **temperature 0, max_tokens 1200**, with the system prompt *"You are a strict JSON API. Output only valid JSON."* It never sees pixels — it sees the measured properties and the code:

```
Chart A (deepseek-v4.1-flash) — measured properties of the rendered figure:
figure size 10x5.5 in at 110.0 DPI
1 axes
3 line objects
0 patches (bars etc.)
3 distinct colours #2563eb #9aa0a6 #e05c4f
title present: yes
x-axis label present: yes
...
```

…for both charts, then:

> Score each chart 1-10 on insight and clarity. Give a one-sentence verdict per chart, and name which chart you would ship.

The UI renders insight/clarity as big numbers, both verdicts, the ship pick, and the judge's raw JSON in a disclosure.

---

## API reference

### `POST /api/graphite` — gateway

```jsonc
// request
{ "question": "Show the trend over time",
  "slots": { "a": { "provider": "particle", "baseUrl": "https://api.particle.ai/v1",
                    "apiKey": "…", "model": "deepseek-v4-flash-0731" },
             "b": { /* … */ } },
  "settings": { "temperature": 0.7, "maxTokens": 1600, "disableReasoning": false } }

// response (per slot)
{ "ok": true, "promptHash": "9d31a534971e",
  "results": { "a": { "code": "import pandas as pd…", "rawReply": "…",
                      "latencyMs": 4120, "promptTokens": 412, "completionTokens": 356,
                      "reasoningTokens": 87, "reasoningSupported": true,
                      "retriedWithLargerBudget": false,
                      "sha256": "cf9a04ccabe9…" } } }
```

### `POST /execute` — executor

```jsonc
// request  { "code": "import pandas as pd…" }
// response
{ "ok": true, "pngBase64": "iVBORw0KGgo…", "stdout": "…", "stderr": "",
  "traceback": null, "runtimeMs": 659, "figureCount": 1, "blocked": false,
  "violations": [], "timedOut": false, "seatbelt": false,
  "figureMeta": [ { "axes": 1, "lines": 3, "titles": 1, "xlabels": 1,
                    "distinctColors": ["#2563eb"] } ],
  "pngInfo": { "width": 1100, "height": 605, "bitDepth": 8, "colorType": 6 } }
```

### `POST /api/repair` — one repair pass

Sends the *same slot* its own traceback appended to the original prompt, re-executes, and returns the new result. The repair outcome is deliberately part of the story: watching a model read its own stack trace and fix itself is the point.

### `POST /api/judge` — the scorecard

Takes both panels' measured properties + code, returns `{ raw, parsed, latencyMs }` where `parsed` is the strict-JSON scorecard (`a.insight`, `a.clarity`, `a.verdict`, …, `ship`, `reason`).

### `POST /api/models` — live model lists

Proxies `GET {base_url}/models` so the browser never talks to providers. Failure returns the real error text; the UI keeps working regardless.

---

## Project structure

```
graphite/
├── data/
│   ├── data.csv              215 rows — the dataset both models receive
│   └── DATASET.md            what's in the data and why it's interesting
├── backend/
│   ├── executor.py           FastAPI :8000 — sandbox, PNG capture, measurement
│   └── sandbox/
│       └── allowlist.py      AST allowlist analyzer
├── server/
│   └── gateway.ts            Node :3001 — all model calls, judge, /models proxy
├── src/
│   ├── App.tsx               run state machine, config, exports
│   ├── types.ts              shared types
│   ├── components/
│   │   ├── ChartPanel.tsx    PNG + badge + runtime + measured facts + repair
│   │   ├── JudgeCard.tsx     scorecard + raw JSON disclosure
│   │   ├── SlotEditor.tsx    provider/baseURL/key/model per slot
│   │   └── CodeBlock.tsx     collapsible code with syntax highlighting
│   └── lib/
│       ├── api.ts            fetch wrappers
│       ├── providers.ts      presets + defaults
│       └── shareCard.ts      canvas 1080×1080 share card
├── scripts/
│   ├── mock-provider.mjs     OpenAI-compatible fake for offline verification
│   └── echo-provider.mjs     request-capture echo server (debugging)
├── index.html · vite.config.ts · tsconfig.json · package.json
└── README.md
```

---

## Verification log

Everything below was executed against this repo, not hand-waved:

1. **Preset-1 run** — chart A rendered a real 1100×605 PNG (1 axes, 3 colours, title + labels + legend); chart B crashed with a verbatim `KeyError` traceback.
2. **Crash & timeout** — a deliberately crashing snippet returns the real traceback; an infinite loop is killed at exactly 20.0 s (`timedOut: true`).
3. **Measured ≠ parsed** — the "9 axes, 42 colours" liar snippet measures 1 axis, 1 colour, no legend.
4. **Judge** — real judge call, parsed scorecard, raw JSON inspectable.
5. **Reasoning tokens** — 87 from a reporting provider; `n/a` (null) from one that doesn't.
6. **`reasoning_content`** — never appears in any response payload.
7. **Repair pass** — traceback back to the same slot; fixed code renders.
8. **Empty-content retry** — budget doubled once (1600→3200), then real code.
9. **Blocked slot** — `import socket` rejected pre-execution, violation named.
10. **Zero prompt reuse** — identical questions produce different prompt hashes.
11. **Control run** — same model on both sides → identical sha256 code, near-identical measured properties; A vs B diverges.

---

## Contributing

Fork, branch, build, verify, PR:

```bash
git clone https://github.com/harishkotra/graphite.git && cd graphite
npm install
python3 -m venv .venv && .venv/bin/pip install fastapi "uvicorn[standard]" pandas matplotlib
git checkout -b feat/your-idea
pnpm typecheck          # tsc --noEmit must stay clean
node scripts/mock-provider.mjs &   # offline provider for local testing
npm run dev
```

Ground rules: no chart-generation APIs, no LLM-authored chart-spec formats (no Vega-Lite/Plotly JSON), no notebooks, no auth, no database, no conversation history. Model calls stay in the gateway; execution stays in the executor; measurement stays in the sandbox — keep those seams.

**Ideas looking for an owner:**

- **Tournament mode** — N models, single-elimination bracket judged pairwise, ELO ladder persisted per dataset.
- **Container sandbox** — a Docker/gVisor runner profile behind the same `/execute` contract, selected by env var, for people who actually need the security boundary.
- **Chart diff overlay** — blend both PNGs at 50 % opacity with a slider; the differences become the story.
- **Judge ensemble** — three judges with median scoring and disagreement surfaced in the UI ("judges split 2–1").
- **Streaming traces** — SSE from the gateway so the code appears token-by-token while the sandbox spins up.
- **Dataset drop zone** — drag any CSV onto the page; the executor mounts it into the temp dir instead of `data.csv`.
- **Cost & carbon meter** — token counts × provider pricing, shown per panel next to the runtime.
- **Replay files** — export a single `.graphite.json` (prompt, code, PNGs, judge) that re-renders the whole run deterministically.
- **Auto-retry ladder** — on crash, escalate: repair pass → simplify-the-ask pass → fall back to a "safe chart" prompt, with the ladder shown in the UI.

Small fixes welcome too — the mock provider (`scripts/mock-provider.mjs`) makes regression tests trivial: add a model persona, drive the pipeline with `curl`, assert on the JSON.
