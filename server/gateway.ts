/**
 * Graphite gateway — the ONLY place model calls happen.
 *
 * Why a gateway: local providers (Ollama, LM Studio) have no CORS headers, and
 * API keys must never reach the browser. The frontend talks to this process;
 * this process talks to providers and to the FastAPI executor on :8000.
 *
 * Plain fetch to OpenAI-compatible /chat/completions. No SDK.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.GRAPHITE_GATEWAY_PORT ?? 3001);
const EXECUTOR = process.env.GRAPHITE_EXECUTOR ?? "http://127.0.0.1:8000";
const REPO_ROOT = path.resolve(__dirname, "..");

const SYSTEM_PROMPT = "You are a precise assistant. Answer the user's request directly.";
const JUDGE_SYSTEM_PROMPT = "You are a strict JSON API. Output only valid JSON.";

// ---------------------------------------------------------------------------
// Provider presets (mirrored in the UI; the UI sends back whichever was chosen)
// ---------------------------------------------------------------------------
export const PROVIDER_PRESETS: Record<string, { baseUrl: string; needsKey: boolean; local: boolean }> = {
  particle: { baseUrl: "https://api.particle.ai/v1", needsKey: true, local: false },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", needsKey: false, local: true },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", needsKey: false, local: true },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", needsKey: true, local: false },
  custom: { baseUrl: "", needsKey: false, local: false },
};

// ---------------------------------------------------------------------------
// Data preview — the SAME bytes go to both slots
// ---------------------------------------------------------------------------
function buildDataPreview(): { preview: string; rowCount: number } {
  const csv = fs.readFileSync(path.join(REPO_ROOT, "data", "data.csv"), "utf8");
  const lines = csv.trim().split("\n");
  const rowCount = lines.length - 1;
  const previewLines = [lines[0], ...lines.slice(1, 26)];
  return { preview: previewLines.join("\n"), rowCount };
}

// ---------------------------------------------------------------------------
// Prompt construction + the zero-reuse assertion
// ---------------------------------------------------------------------------
const seenPrompts = new Set<string>();

function buildUserPrompt(question: string): string {
  const { preview, rowCount } = buildDataPreview();
  const nonce = crypto.randomBytes(8).toString("hex"); // fresh every call — kills cache "determinism"
  return [
    `Here is data.csv (${rowCount} data rows). The first rows look like this:`,
    "",
    preview,
    "",
    "...",
    "The full file is at ./data.csv.",
    "",
    `Task: ${question}`,
    "",
    "Write Python code using pandas and matplotlib that produces the single most insightful chart of this data.",
    "The code runs with data.csv as its working directory and must render exactly one chart.",
    "Save the figure to stdout as PNG bytes (fig.savefig(sys.stdout.buffer, format=\"png\")) or to a file like chart.png.",
    "Output only code. No explanations, no markdown fences.",
    "",
    `(run nonce: ${nonce})`,
  ].join("\n");
}

function assertFreshPrompt(prompt: string): void {
  const h = crypto.createHash("sha256").update(prompt).digest("hex");
  if (seenPrompts.has(h)) {
    throw new Error("internal: prompt reuse detected — nonces must make every prompt unique");
  }
  seenPrompts.add(h);
}

// ---------------------------------------------------------------------------
// The one chat-call primitive every slot (and the judge) goes through
// ---------------------------------------------------------------------------
export interface SlotConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatSettings {
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
}

export interface ChatResult {
  content: string;          // message.content only — reasoning_content is stripped at this boundary
  rawReply: string;         // same as content; kept as an alias for the UI
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;  // null => provider does not report it => UI shows "n/a"
  reasoningSupported: boolean;     // false => UI hides the thinking toggle
  retriedWithLargerBudget: boolean;
  error?: string;
}

function stripFences(text: string): string {
  const m = text.match(/```(?:python)?\s*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

function localHint(baseUrl: string, err: string): string {
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(err)) {
    try {
      const u = new URL(baseUrl);
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
        return `Cannot reach ${u.origin} — is the local provider running? (${err})`;
      }
    } catch { /* not a URL — fall through */ }
  }
  return err;
}

export async function chatCall(
  slot: SlotConfig,
  userPrompt: string,
  settings: ChatSettings,
  opts: { system?: string; temperature?: number; maxTokens?: number; isJudge?: boolean } = {},
): Promise<ChatResult> {
  const started = Date.now();
  const system = opts.system ?? SYSTEM_PROMPT;
  const temperature = opts.temperature ?? settings.temperature;
  let maxTokens = opts.maxTokens ?? settings.maxTokens;

  const body: Record<string, unknown> = {
    model: slot.model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
  };
  // Capability rule: only Particle.ai deepseek-* models get the thinking switch.
  if (
    settings.disableReasoning &&
    slot.provider.toLowerCase() === "particle" &&
    slot.model.toLowerCase().startsWith("deepseek-")
  ) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const url = slot.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (slot.apiKey) headers.Authorization = `Bearer ${slot.apiKey}`;

  let retried = false;
  let lastErr: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(attempt === 0 ? body : { ...body, max_tokens: Math.min(maxTokens * 2, 4000) }),
      });
    } catch (e) {
      lastErr = localHint(slot.baseUrl, e instanceof Error ? e.message : String(e));
      break; // network failure — retrying won't help
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastErr = `HTTP ${res.status} from ${url}: ${text.slice(0, 500) || res.statusText}`;
      break; // provider said no — show the real error, don't retry blindly
    }

    let data: any;
    try {
      data = await res.json();
    } catch (e) {
      lastErr = `Provider returned non-JSON body: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }

    const msg = data?.choices?.[0]?.message ?? {};
    // STRIP reasoning_content here — it never leaves this function's scope.
    // Only the token COUNT from usage may survive.
    const content: string = typeof msg.content === "string" ? msg.content : "";
    const usage = data?.usage ?? {};
    const reasoningTokens =
      typeof usage?.completion_tokens_details?.reasoning_tokens === "number"
        ? usage.completion_tokens_details.reasoning_tokens
        : null;

    const result: ChatResult = {
      content,
      rawReply: content,
      latencyMs: Date.now() - started,
      promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
      completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
      reasoningTokens,
      reasoningSupported: reasoningTokens !== null,
      retriedWithLargerBudget: retried,
    };

    // HTTP 200 with empty content = the hidden CoT ate the budget. Retry once, double, cap 4000.
    if (!content.trim() && attempt === 0 && !opts.isJudge) {
      maxTokens = Math.min(maxTokens * 2, 4000);
      retried = true;
      continue;
    }
    return result;
  }

  return {
    content: "",
    rawReply: "",
    latencyMs: Date.now() - started,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    reasoningSupported: false,
    retriedWithLargerBudget: retried,
    error: lastErr ?? "unknown provider error",
  };
}

// ---------------------------------------------------------------------------
// Measured-properties block for the judge (never pixels, never the raw PNG)
// ---------------------------------------------------------------------------
interface PanelForJudge {
  label: string;
  model: string;
  ok: boolean;
  crashed: boolean;
  blocked: boolean;
  timedOut: boolean;
  runtimeMs: number;
  code: string;
  measured: Record<string, unknown> | null;
}

function describePanel(p: PanelForJudge): string {
  if (p.blocked) return `Chart ${p.label}: BLOCKED by the sandbox allowlist before execution.`;
  if (!p.ok) {
    return `Chart ${p.label} (${p.model}): DID NOT RENDER — ${p.timedOut ? "killed by the 20s timeout" : "crashed at runtime"}. Runtime ${p.runtimeMs}ms.`;
  }
  const m = (p.measured ?? {}) as Record<string, any>;
  const fig = Array.isArray(m.figsize_in) ? `${m.figsize_in[0]}x${m.figsize_in[1]} in` : "unknown";
  const facts = [
    `figure size ${fig} at ${m.dpi} DPI`,
    `${m.axes} axes`,
    `${m.lines} line objects`,
    `${m.patches} patches (bars etc.)`,
    `${(m.distinctColors ?? []).length} distinct colours ${(m.distinctColors ?? []).slice(0, 8).join(" ")}`,
    `title present: ${m.titles ? "yes" : "no"}`,
    `x-axis label present: ${m.xlabels ? "yes" : "no"}`,
    `y-axis label present: ${m.ylabels ? "yes" : "no"}`,
    `legend present: ${m.legends ? "yes" : "no"}`,
    `runtime ${p.runtimeMs}ms`,
  ];
  return `Chart ${p.label} (${p.model}) — measured properties of the rendered figure:\n${facts.join("\n")}\n\nCode that produced it:\n\`\`\`\n${p.code}\n\`\`\``;
}

function buildJudgePrompt(question: string, a: PanelForJudge, b: PanelForJudge): string {
  const nonce = crypto.randomBytes(8).toString("hex"); // judge is a model call too — fresh nonce, no cache reuse
  return [
    `Two AI models were each given the same dataset (data.csv) and this request:`,
    `"${question}"`,
    "",
    "Each produced Python/pandas/matplotlib code that was executed in a sandbox. Below are the MEASURED properties of what each one actually rendered (not their claims).",
    "",
    describePanel(a),
    "",
    describePanel(b),
    "",
    "Score each chart 1-10 on insight (does it reveal something non-obvious about the data?) and 1-10 on clarity (can a stranger read it unaided?).",
    "Give a one-sentence verdict per chart, and name which chart you would ship.",
    "Respond with ONLY a JSON object of this exact shape:",
    '{"a": {"insight": <1-10>, "clarity": <1-10>, "verdict": "<one sentence>"}, "b": {"insight": <1-10>, "clarity": <1-10>, "verdict": "<one sentence>"}, "ship": "<\"a\" or \"b\">", "reason": "<one sentence why>"}',
    "",
    `(run nonce: ${nonce})`,
  ].join("\n");
}

function parseJudgeJson(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function proxyExecute(code: string): Promise<Record<string, unknown>> {
  const res = await fetch(EXECUTOR + "/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return (await res.json()) as Record<string, unknown>;
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "";
  try {
    if (req.method === "GET" && url === "/health") {
      return sendJson(res, 200, { ok: true, executor: EXECUTOR });
    }

    // live model list for the dropdowns — proxied so the browser never hits the provider
    if (req.method === "POST" && url === "/api/models") {
      const { baseUrl, apiKey } = JSON.parse(await readBody(req));
      if (!baseUrl) return sendJson(res, 400, { ok: false, error: "No base URL configured for this provider." });
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      try {
        const r = await fetch(baseUrl.replace(/\/+$/, "") + "/models", { headers });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          return sendJson(res, 200, { ok: false, error: `HTTP ${r.status} from ${baseUrl}/models: ${t.slice(0, 300)}` });
        }
        const data = await r.json();
        const models = (data?.data ?? []).map((m: { id: string }) => m.id).filter(Boolean);
        return sendJson(res, 200, { ok: true, models });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: localHint(baseUrl, e instanceof Error ? e.message : String(e)) });
      }
    }

    // THE main endpoint: same prompt to both slots, concurrently
    if (req.method === "POST" && url === "/api/graphite") {
      const { question, slots, settings } = JSON.parse(await readBody(req)) as {
        question: string; slots: { a: SlotConfig; b: SlotConfig }; settings: ChatSettings;
      };
      if (!question?.trim()) return sendJson(res, 400, { ok: false, error: "Question is empty." });
      const prompt = buildUserPrompt(question.trim());
      assertFreshPrompt(prompt);

      const callSlot = async (slot: SlotConfig, label: "a" | "b") => {
        if (!slot.baseUrl || !slot.model) {
          return { label, error: `Slot ${label.toUpperCase()} has no ${slot.baseUrl ? "model" : "base URL"} configured.` };
        }
        const chat = await chatCall(slot, prompt, settings);
        if (chat.error || !chat.content.trim()) {
          return { label, ...chat, code: null, sha256: null, error: chat.error ?? "Model returned empty content even after a doubled budget." };
        }
        const code = stripFences(chat.content);
        return {
          label,
          code,
          rawReply: chat.rawReply,
          latencyMs: chat.latencyMs,
          promptTokens: chat.promptTokens,
          completionTokens: chat.completionTokens,
          reasoningTokens: chat.reasoningTokens,
          reasoningSupported: chat.reasoningSupported,
          retriedWithLargerBudget: chat.retriedWithLargerBudget,
          sha256: crypto.createHash("sha256").update(code).digest("hex"),
        };
      };

      const [a, b] = await Promise.all([callSlot(slots.a, "a"), callSlot(slots.b, "b")]);
      return sendJson(res, 200, { ok: true, promptHash: crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 12), results: { a, b } });
    }

    // execute proxy
    if (req.method === "POST" && url === "/api/execute") {
      const { code } = JSON.parse(await readBody(req));
      return sendJson(res, 200, await proxyExecute(code));
    }

    // one repair pass: same slot, traceback appended, then re-execute
    if (req.method === "POST" && url === "/api/repair") {
      const { slot, question, code, traceback, settings } = JSON.parse(await readBody(req)) as {
        slot: SlotConfig; question: string; code: string; traceback: string; settings: ChatSettings;
      };
      const basePrompt = buildUserPrompt(question.trim());
      assertFreshPrompt(basePrompt);
      const repairPrompt =
        basePrompt +
        "\n\nYour previous attempt was:\n```python\n" + code + "\n```\n" +
        "It crashed with this Python traceback:\n\n" + traceback +
        "\n\nReturn corrected Python code only. Output only code, no markdown fences.";
      const chat = await chatCall(slot, repairPrompt, settings, { maxTokens: Math.max(settings.maxTokens, 1600) });
      if (chat.error || !chat.content.trim()) {
        return sendJson(res, 200, { ok: false, error: chat.error ?? "Repair call returned empty content." });
      }
      const newCode = stripFences(chat.content);
      const execution = await proxyExecute(newCode);
      return sendJson(res, 200, {
        ok: true,
        code: newCode,
        rawReply: chat.rawReply,
        latencyMs: chat.latencyMs,
        promptTokens: chat.promptTokens,
        completionTokens: chat.completionTokens,
        reasoningTokens: chat.reasoningTokens,
        reasoningSupported: chat.reasoningSupported,
        sha256: crypto.createHash("sha256").update(newCode).digest("hex"),
        execution,
      });
    }

    // judge call
    if (req.method === "POST" && url === "/api/judge") {
      const { question, panels, slot } = JSON.parse(await readBody(req)) as {
        question: string; panels: { a: PanelForJudge; b: PanelForJudge }; slot: SlotConfig;
      };
      if (!slot.baseUrl || !slot.model) {
        return sendJson(res, 200, { ok: false, error: "Judge slot has no model configured." });
      }
      const prompt = buildJudgePrompt(question.trim(), panels.a, panels.b);
      assertFreshPrompt(prompt);
      const chat = await chatCall(slot, prompt, { temperature: 0, maxTokens: 1200, disableReasoning: false }, {
        system: JUDGE_SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 1200,
        isJudge: true,
      });
      if (chat.error) return sendJson(res, 200, { ok: false, error: chat.error });
      const parsed = parseJudgeJson(chat.content);
      return sendJson(res, 200, { ok: true, raw: chat.content, parsed, latencyMs: chat.latencyMs, promptTokens: chat.promptTokens, completionTokens: chat.completionTokens, reasoningTokens: chat.reasoningTokens, reasoningSupported: chat.reasoningSupported });
    }

    sendJson(res, 404, { ok: false, error: `No route: ${req.method} ${url}` });
  } catch (e) {
    console.error("[gateway] handler error:", e);
    sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`[graphite-gateway] listening on http://127.0.0.1:${PORT} (executor: ${EXECUTOR})`);
});
