/**
 * Mock OpenAI-compatible provider for Graphite verification.
 *
 * Listens on :8100 and impersonates /v1/models + /v1/chat/completions so the
 * full gateway → executor pipeline can be exercised without a real API key.
 *
 * Models:
 *   mock-good   — returns a working matplotlib snippet; reports reasoning tokens
 *   mock-crash  — returns a snippet that raises KeyError; reports NO reasoning tokens
 *   mock-empty  — returns empty content on the first call, real code on the second
 *   mock-block  — returns code that imports socket (sandbox must block it)
 *
 * The judge call (system prompt contains "strict JSON") always returns a scorecard.
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8100);

const GOOD_CODE = `import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

df = pd.read_csv("data.csv")
df["date"] = pd.to_datetime(df["date"])
daily = df.groupby("date")["build_seconds"].mean()
roll = daily.rolling(10).mean()

fig, ax = plt.subplots(figsize=(10, 5.5))
ax.plot(daily.index, daily.values, color="#9aa0a6", linewidth=0.9, alpha=0.6, label="daily mean")
ax.plot(roll.index, roll.values, color="#2563eb", linewidth=2.2, label="10-day rolling mean")
cache_start = df.loc[df["cache_warm"] == 1, "date"].min()
ax.axvline(cache_start, color="#e05c4f", linestyle="--", linewidth=1.4, label="build cache enabled")
ax.set_title("Mean build time per day, with the cache cutover")
ax.set_xlabel("Date")
ax.set_ylabel("Build time (seconds)")
ax.legend()
fig.autofmt_xdate()
fig.tight_layout()
import sys
fig.savefig(sys.stdout.buffer, format="png", dpi=110)
`;

const CRASH_CODE = `import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

df = pd.read_csv("data.csv")
daily = df.groupby("stack")["build_time_seconds"].mean()
fig, ax = plt.subplots(figsize=(9, 5))
ax.bar(daily.index, daily.values, color="#1f77b4")
ax.set_title("Mean build seconds per stack")
ax.set_xlabel("Stack")
ax.set_ylabel("Seconds")
fig.tight_layout()
fig.savefig("chart.png", dpi=110)
`;

const BLOCK_CODE = `import socket
print("hello")
`;

function pickBody(body) {
  const sys = body?.messages?.[0]?.content ?? "";
  const model = body?.model ?? "mock-good";
  const user = body?.messages?.[1]?.content ?? "";

  if (sys.includes("strict JSON")) {
    const scorecard = {
      a: { insight: 9, clarity: 8, verdict: "The rolling-mean trend with the cache cutover marker directly answers the question." },
      b: { insight: 3, clarity: 2, verdict: "A bar of raw per-row values with no aggregation reads as noise." },
      ship: "a",
      reason: "Chart A isolates the step change the dataset actually contains; Chart B buries it.",
    };
    return {
      choices: [{ message: { content: JSON.stringify(scorecard) } }],
      usage: { prompt_tokens: 620, completion_tokens: 96 },
    };
  }

  if (model === "mock-empty") {
    // empty on first call (per process lifetime), code on any later call
    if (!pickBody.emptied) {
      pickBody.emptied = true;
      return { choices: [{ message: { content: "" } }], usage: { prompt_tokens: 100, completion_tokens: 0 } };
    }
  }

  if (user.includes("crashed with this Python traceback")) {
    // repair pass: the model fixes its mistake and returns working code
    return {
      choices: [{ message: { content: "```python\n" + GOOD_CODE + "\n```" } }],
      usage: { prompt_tokens: 640, completion_tokens: 380, completion_tokens_details: { reasoning_tokens: 41 } },
    };
  }

  const code = model === "mock-crash" ? CRASH_CODE : model === "mock-block" ? BLOCK_CODE : GOOD_CODE;
  const usage = { prompt_tokens: 412, completion_tokens: 356 };
  if (model !== "mock-crash" && model !== "mock-block") {
    usage.completion_tokens_details = { reasoning_tokens: 87 };
  }
  return {
    choices: [{ message: { content: "```python\n" + code + "\n```" } }],
    usage,
    _echo_prompt_head: user.slice(0, 80),
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url ?? "").includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-good" }, { id: "mock-crash" }, { id: "mock-empty" }, { id: "mock-block" }] }));
    return;
  }
  if (req.method === "POST" && (req.url ?? "").includes("/chat/completions")) {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data || "{}");
      const sys = body?.messages?.[0]?.content ?? "";
      console.log(`[mock] ${body.model} | sys="${String(sys).slice(0, 40)}" | user=${String(body?.messages?.[1]?.content ?? "").length}ch`);
      const out = pickBody(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "no such route on the mock" }));
});

server.listen(PORT, () => console.log(`[mock-provider] http://127.0.0.1:${PORT}/v1`));
