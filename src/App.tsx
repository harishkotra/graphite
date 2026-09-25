import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExecutionResult, JudgeResult, ModelResult, Panel, Phase, RunState, Settings, SlotConfig } from "./types";import { DEFAULT_SETTINGS, DEFAULT_SLOTS, QUESTION_PRESETS } from "./lib/providers";
import { executeCode, fetchModels, judgeCall, repairPanel, runBothSlots } from "./lib/api";
import { ChartPanel } from "./components/ChartPanel";
import { JudgeCard } from "./components/JudgeCard";
import { SlotEditor, SlotModels } from "./components/SlotEditor";
import { downloadDataUrl, drawShareCard } from "./lib/shareCard";

const LS_KEY = "graphite-config-v1";

interface PersistedConfig {
  slots: { a: SlotConfig; b: SlotConfig; judge: SlotConfig };
  settings: Settings;
}

function loadConfig(): PersistedConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedConfig;
      if (parsed.slots && parsed.settings) return parsed;
    }
  } catch { /* fall through to defaults */ }
  return { slots: DEFAULT_SLOTS, settings: DEFAULT_SETTINGS };
}

const IDLE_PANEL: (label: "a" | "b", slot: SlotConfig) => Panel = (label, slot) => ({
  label,
  slot,
  result: null,
  execution: null,
  repairAttempted: false,
});

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Idle",
  asking: "Both models are writing code…",
  executing: "Executing both snippets in the sandbox…",
  judging: "The judge is scoring both charts…",
  finished: "Done",
  error: "Something failed — details below",
};

export default function App() {
  const [config, setConfig] = useState<PersistedConfig>(loadConfig);
  const [sameModel, setSameModel] = useState(false);
  const [question, setQuestion] = useState(QUESTION_PRESETS[0]);
  const [run, setRun] = useState<RunState | null>(null);
  const [repairBusy, setRepairBusy] = useState<"a" | "b" | null>(null);
  const [models, setModels] = useState<Record<string, SlotModels[string]>>({
    a: { loading: false, models: [], error: null },
    b: { loading: false, models: [], error: null },
    judge: { loading: false, models: [], error: null },
  });

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(config));
  }, [config]);

  const setSlot = (key: "a" | "b" | "judge") => (next: SlotConfig) =>
    setConfig((c) => ({ ...c, slots: { ...c.slots, [key]: next } }));

  // live model lists — never gates a run; typing a name always works
  const refreshModels = useCallback(async (key: "a" | "b" | "judge") => {
    const slot = config.slots[key];
    if (!slot.baseUrl) {
      setModels((m) => ({ ...m, [key]: { loading: false, models: [], error: "No base URL configured." } }));
      return;
    }
    setModels((m) => ({ ...m, [key]: { ...m[key], loading: true, error: null } }));
    const r = await fetchModels(slot.baseUrl, slot.apiKey);
    setModels((m) => ({
      ...m,
      [key]: r.ok ? { loading: false, models: r.models ?? [], error: null } : { loading: false, models: [], error: r.error ?? "Could not list models." },
    }));
  }, [config.slots]);

  useEffect(() => {
    const slot = config.slots.a;
    if (slot.provider === "ollama" || slot.provider === "lmstudio") void refreshModels("a");
  }, [config.slots.a.provider, config.slots.a.baseUrl, refreshModels]);
  useEffect(() => {
    const slot = config.slots.b;
    if (slot.provider === "ollama" || slot.provider === "lmstudio") void refreshModels("b");
  }, [config.slots.b.provider, config.slots.b.baseUrl, refreshModels]);
  useEffect(() => {
    const slot = config.slots.judge;
    if (slot.provider === "ollama" || slot.provider === "lmstudio") void refreshModels("judge");
  }, [config.slots.judge.provider, config.slots.judge.baseUrl, refreshModels]);

  // per-slot reasoning capability: hide the thinking toggle once a provider
  // proves it does not report reasoning tokens
  const reasoningHidden = useMemo(() => {
    const r = (p: Panel | null) => p?.result && p.result.reasoningTokens === null && p.result.reasoningSupported === false;
    return { a: !!r(run?.panels.a ?? null), b: !!r(run?.panels.b ?? null) };
  }, [run]);

  async function runComparison() {
    const slots = {
      a: config.slots.a,
      b: sameModel ? { ...config.slots.a } : config.slots.b,
    };
    let panelA = IDLE_PANEL("a", slots.a);
    let panelB = IDLE_PANEL("b", slots.b);
    setRun({ phase: "asking", question, panels: { a: panelA, b: panelB }, judge: null, error: null, promptHash: null });

    const both = await runBothSlots(question, slots, config.settings);
    if (!both.ok || !both.results) {
      setRun((r) => r && ({ ...r, phase: "error", error: both.error ?? "The gateway returned an error." }));
      return;
    }

    const attach = (label: "a" | "b", result: ModelResult): Panel => ({
      label,
      slot: slots[label],
      result,
      execution: null,
      repairAttempted: false,
    });

    panelA = attach("a", both.results.a);
    panelB = attach("b", both.results.b);
    setRun((r) => r && ({ ...r, phase: "executing", promptHash: both.promptHash ?? null, panels: { a: panelA, b: panelB } }));

    const [execA, execB] = await Promise.all([
      both.results.a.code ? executeCode(both.results.a.code) : Promise.resolve(null),
      both.results.b.code ? executeCode(both.results.b.code) : Promise.resolve(null),
    ]);
    panelA = { ...panelA, execution: execA };
    panelB = { ...panelB, execution: execB };
    setRun((r) => r && ({ ...r, panels: { a: panelA, b: panelB } }));

    if (!both.results.a.code && !both.results.b.code) {
      setRun((r) => r && ({ ...r, phase: "error", error: "Neither model returned code." }));
      return;
    }

    setRun((r) => r && ({ ...r, phase: "judging" }));

    const buildSide = (label: "a" | "b", panel: Panel) => ({
      label,
      model: panel.slot.model,
      ok: !!panel.execution?.ok,
      crashed: !!panel.execution && !panel.execution.ok && !panel.execution.blocked,
      blocked: !!panel.execution?.blocked,
      timedOut: !!panel.execution?.timedOut,
      runtimeMs: panel.execution?.runtimeMs ?? 0,
      code: panel.result?.code ?? "",
      measured: panel.execution?.figureMeta?.[0] ?? null,
    });

    const judge = await judgeCall(
      question,
      { a: buildSide("a", panelA), b: buildSide("b", panelB) },
      config.slots.judge,
    );

    setRun((r) => r && ({ ...r, phase: "finished", judge }));
  }

  async function doRepair(label: "a" | "b") {
    if (!run) return;
    const panel = run.panels[label];
    const tb = panel.execution?.traceback ?? panel.execution?.stderr ?? "unknown failure";
    setRepairBusy(label);
    const resp = await repairPanel(panel.slot, run.question, panel.result?.code ?? "", tb, config.settings);
    setRepairBusy(null);
    if (!resp.ok || !resp.execution) {
      setRun((r) => r && ({ ...r, error: `Repair call failed: ${resp.error ?? "unknown error"}` }));
      return;
    }
    setRun((r) =>
      r && ({
        ...r,
        panels: {
          ...r.panels,
          [label]: {
            ...panel,
            result: {
              label,
              code: resp.code ?? panel.result?.code ?? null,
              rawReply: resp.rawReply ?? "",
              latencyMs: resp.latencyMs ?? 0,
              promptTokens: null,
              completionTokens: null,
              reasoningTokens: resp.reasoningTokens ?? null,
              reasoningSupported: resp.reasoningSupported ?? false,
              retriedWithLargerBudget: false,
              sha256: resp.sha256 ?? null,
            },
            execution: resp.execution,
            repairAttempted: true,
          },
        },
      }),
    );
  }

  function copyResultsJson() {
    if (!run) return;
    const side = (label: "a" | "b") => {
      const p = run.panels[label];
      return {
        model: p.slot.model,
        code: p.result?.code,
        sha256: p.result?.sha256,
        latencyMs: p.result?.latencyMs,
        promptTokens: p.result?.promptTokens,
        completionTokens: p.result?.completionTokens,
        reasoningTokens: p.result?.reasoningTokens,
        execution: p.execution
          ? {
              ok: p.execution.ok,
              blocked: p.execution.blocked,
              timedOut: p.execution.timedOut,
              runtimeMs: p.execution.runtimeMs,
              figureMeta: p.execution.figureMeta,
              pngInfo: p.execution.pngInfo,
              traceback: p.execution.traceback,
              violations: p.execution.violations,
            }
          : null,
        repaired: p.repairAttempted,
      };
    };
    const dump = {
      app: "graphite",
      exportedAt: new Date().toISOString(),
      question: run.question,
      promptHash: run.promptHash,
      settings: config.settings,
      sameModelControl: sameModel,
      panels: { a: side("a"), b: side("b") },
      judge: run.judge ? { raw: run.judge.raw, parsed: run.judge.parsed, latencyMs: run.judge.latencyMs } : null,
    };
    void navigator.clipboard.writeText(JSON.stringify(dump, null, 2)).then(
      () => alert("Results copied to the clipboard as JSON."),
      () => alert("Clipboard write was blocked — select and copy manually instead."),
    );
  }

  async function downloadBoth() {
    if (!run) return;
    for (const label of ["a", "b"] as const) {
      const png = run.panels[label].execution?.pngBase64;
      if (png) downloadDataUrl(`data:image/png;base64,${png}`, `graphite-chart-${label}.png`);
    }
  }

  async function downloadShareCard() {
    if (!run) return;
    const dataUrl = await drawShareCard({
      question: run.question,
      panels: run.panels,
      judge: run.judge?.parsed ?? null,
    });
    downloadDataUrl(dataUrl, "graphite-share-card.png");
  }

  const busy = run && (run.phase === "asking" || run.phase === "executing" || run.phase === "judging");
  const phase = run?.phase ?? "idle";

  return (
    <div className="app">
      <header className="masthead">
        <div className="wordmark">
          GRAPHITE<span className="wordmark-dot">.</span>
        </div>
        <p className="tagline">
          Two models get the same CSV. Both write matplotlib code. The sandbox runs it. The judge picks the chart that
          actually answers the question.
        </p>
      </header>

      <section className="askbar" aria-label="Question">
        <textarea
          className="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="Ask for the one chart that matters…"
          disabled={!!busy}
        />
        <div className="presets">
          {QUESTION_PRESETS.map((q) => (
            <button key={q} className={`preset ${question === q ? "preset-active" : ""}`} onClick={() => setQuestion(q)} disabled={!!busy}>
              {q}
            </button>
          ))}
        </div>
        <div className="runrow">
          <button className="btn btn-primary" onClick={runComparison} disabled={!!busy || !question.trim()}>
            {busy ? PHASE_LABEL[phase] : "Run both models"}
          </button>
          <label className="toggle">
            <input type="checkbox" checked={sameModel} onChange={(e) => setSameModel(e.target.checked)} disabled={!!busy} />
            <span>Same model on both sides (control run)</span>
          </label>
          {phase !== "idle" && <span className={`phase phase-${phase}`}>{PHASE_LABEL[phase]}</span>}
        </div>
        {run?.error && (
          <div className="run-error" role="alert">{run.error}</div>
        )}
      </section>

      {run && (phase === "finished" || phase === "error" || run.panels.a.result || run.panels.b.result) && (
        <section className="arena" aria-label="Results">
          <ChartPanel panel={run.panels.a} onRepair={() => doRepair("a")} repairBusy={repairBusy === "a"} />
          <div className="spine" aria-hidden="true">
            <div className="spine-rule" />
            <div className="spine-vs">VS</div>
            <div className="spine-rule" />
          </div>
          <ChartPanel panel={run.panels.b} onRepair={() => doRepair("b")} repairBusy={repairBusy === "b"} />
          <JudgeCard judge={run.judge} models={{ a: run.panels.a.slot.model, b: run.panels.b.slot.model }} />
        </section>
      )}

      {run && phase === "finished" && (
        <section className="exports" aria-label="Export">
          <button className="btn" onClick={downloadBoth}>Download both PNGs</button>
          <button className="btn" onClick={downloadShareCard}>Download 1080×1080 share card</button>
          <button className="btn" onClick={copyResultsJson}>Copy results as JSON</button>
          {run.promptHash && <span className="sha">prompt hash {run.promptHash} · fresh nonce per call, zero prompt reuse</span>}
        </section>
      )}

      <details className="config" open={!run}>
        <summary className="config-summary">Providers, keys &amp; run settings</summary>
        <div className="config-grid">
          <SlotEditor
            title="Slot A — the older model"
            slotKey="a"
            slot={config.slots.a}
            onChange={setSlot("a")}
            models={models.a}
            hideThinking={reasoningHidden.a}
            disabled={!!busy}
          />
          <SlotEditor
            title="Slot B — the newer model"
            slotKey="b"
            slot={config.slots.b}
            onChange={setSlot("b")}
            models={models.b}
            hideThinking={reasoningHidden.b}
            disabled={!!busy}
          />
          <div className="config-right">
            <SlotEditor
              title="Judge"
              slotKey="judge"
              slot={config.slots.judge}
              onChange={setSlot("judge")}
              models={models.judge}
              hideThinking={false}
              disabled={!!busy}
            />
            <fieldset className="slot-editor run-settings">
              <legend>Run settings</legend>
              <label className="field">
                <span>Temperature</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={config.settings.temperature}
                  onChange={(e) => setConfig((c) => ({ ...c, settings: { ...c.settings, temperature: Number(e.target.value) } }))}
                  disabled={!!busy}
                />
              </label>
              <label className="field">
                <span>Max tokens</span>
                <input
                  type="number"
                  step="100"
                  min="900"
                  max="4000"
                  value={config.settings.maxTokens}
                  onChange={(e) => setConfig((c) => ({ ...c, settings: { ...c.settings, maxTokens: Number(e.target.value) } }))}
                  disabled={!!busy}
                />
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={config.settings.disableReasoning}
                  onChange={(e) => setConfig((c) => ({ ...c, settings: { ...c.settings, disableReasoning: e.target.checked } }))}
                  disabled={!!busy}
                />
                <span>Disable reasoning (Particle deepseek-* only)</span>
              </label>
            </fieldset>
          </div>
        </div>
        <p className="sandbox-note">
          Sandboxing is best-effort: fresh temp dir, AST allowlist, 20&nbsp;s kill, memory cap, Seatbelt when the OS
          allows it. It is <strong>not</strong> a security boundary — run untrusted code in a container.
        </p>
      </details>

      <footer className="foot">
        The models are drawing their own comparison. data/data.csv · 215 working days of a real build log.
        <div className="credits">
          Built by{" "}
          <a href="https://harishkotra.me" target="_blank" rel="noreferrer">
            Harish Kotra
          </a>{" "}
          · Checkout my{" "}
          <a href="https://dailybuild.xyz" target="_blank" rel="noreferrer">
            other builds
          </a>
        </div>
      </footer>
    </div>
  );
}
