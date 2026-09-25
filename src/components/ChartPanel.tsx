import type { Panel } from "../types";
import { CodeBlock } from "./CodeBlock";

export type SlotBadge = "ran" | "crashed" | "blocked" | "timeout" | "empty";

export function panelStatus(p: Panel): { badge: SlotBadge; text: string } {
  if (!p.result || !p.execution) return { badge: "empty", text: "—" };
  if (p.execution.blocked) return { badge: "blocked", text: "BLOCKED" };
  if (p.execution.timedOut) return { badge: "timeout", text: "TIMEOUT" };
  if (!p.execution.ok) return { badge: "crashed", text: "CRASHED" };
  return { badge: "ran", text: "RAN" };
}

const BADGE_CLASS: Record<SlotBadge, string> = {
  ran: "badge badge-ran",
  crashed: "badge badge-crashed",
  blocked: "badge badge-blocked",
  timeout: "badge badge-timeout",
  empty: "badge badge-empty",
};

function Measured({ panel }: { panel: Panel }) {
  const metas = panel.execution?.figureMeta ?? [];
  const m = metas[0];
  const png = panel.execution?.pngInfo;
  if (!m && !png) return null;
  const facts: [string, string][] = [];
  if (png) facts.push(["png", `${png.width}×${png.height}px`]);
  if (m) {
    facts.push(["figure", `${m.figsize_in[0]}×${m.figsize_in[1]} in @ ${m.dpi} DPI`]);
    facts.push(["axes", String(m.axes)]);
    facts.push(["lines", String(m.lines)]);
    facts.push(["patches", String(m.patches)]);
    facts.push(["colours", String(m.distinctColors.length)]);
    facts.push(["title", m.titles || m.suptitle ? "yes" : "no"]);
    facts.push(["x label", m.xlabels ? "yes" : "no"]);
    facts.push(["y label", m.ylabels ? "yes" : "no"]);
    facts.push(["legend", m.legends ? "yes" : "no"]);
  }
  return (
    <div className="measured">
      <div className="measured-title">Measured from the rendered figure</div>
      <dl className="measured-grid">
        {facts.map(([k, v]) => (
          <div className="measured-cell" key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {m && m.distinctColors.length > 0 && (
        <div className="swatches" aria-label="distinct colours">
          {m.distinctColors.slice(0, 12).map((c) => (
            <span key={c} className="swatch" style={{ background: c }} title={c} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ChartPanel({
  panel,
  onRepair,
  repairBusy,
}: {
  panel: Panel;
  onRepair: () => void;
  repairBusy: boolean;
}) {
  const { badge, text } = panelStatus(panel);
  const exec = panel.execution;
  const crashed = badge === "crashed" || badge === "timeout";
  const showRepair = (crashed || badge === "blocked") && !panel.repairAttempted && !!panel.result;

  return (
    <section className={`panel panel-${panel.label}`} aria-label={`Chart ${panel.label.toUpperCase()}`}>
      <header className="panel-head">
        <div className="panel-id">
          <span className={`slot-dot dot-${panel.label}`} aria-hidden="true" />
          <span className="panel-label">Model {panel.label.toUpperCase()}</span>
        </div>
        <div className="panel-head-right">
          {panel.repairAttempted && <span className="badge badge-repaired">REPAIRED</span>}
          <span className={BADGE_CLASS[badge]}>{text}</span>
          {exec && <span className="runtime">{exec.runtimeMs} ms</span>}
        </div>
      </header>

      <div className="panel-model">{panel.slot.model || "no model configured"}</div>

      {panel.result?.error && (
        <div className="panel-error" role="alert">
          {panel.result.error}
        </div>
      )}

      {exec?.pngBase64 ? (
        <img
          className="chart-img"
          src={`data:image/png;base64,${exec.pngBase64}`}
          alt={`Chart produced by model ${panel.label.toUpperCase()}`}
        />
      ) : (
        <div className="chart-empty">
          {exec?.blocked
            ? "Blocked before execution by the sandbox allowlist."
            : badge === "empty"
              ? "No run yet."
              : "No chart rendered."}
        </div>
      )}

      {exec?.blocked && exec.violations.length > 0 && (
        <div className="violation">
          <div className="violation-title">Sandbox violations</div>
          <ul>
            {exec.violations.map((v, i) => (
              <li key={i}>
                <code>{v.detail}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {exec?.traceback && (
        <div className="traceback">
          <div className="traceback-title">Python traceback (verbatim)</div>
          <pre>{exec.traceback}</pre>
        </div>
      )}

      {exec && !exec.ok && !exec.blocked && !exec.traceback && (exec.stderr || exec.stdout) && (
        <div className="traceback">
          <div className="traceback-title">stderr</div>
          <pre>{(exec.stderr || exec.stdout).slice(-1200)}</pre>
        </div>
      )}

      <Measured panel={panel} />

      {panel.result && (
        <div className="tokens">
          <span>{panel.result.promptTokens ?? "—"} prompt</span>
          <span>{panel.result.completionTokens ?? "—"} completion</span>
          <span>{panel.result.reasoningTokens ?? "n/a"} reasoning</span>
          {panel.result.retriedWithLargerBudget && <span className="token-flag">budget doubled</span>}
        </div>
      )}

      <div className="panel-foot">
        {panel.result?.sha256 && <span className="sha" title="sha256 of the executed code">sha256 {panel.result.sha256.slice(0, 12)}…</span>}
        {showRepair && (
          <button className="btn btn-repair" onClick={onRepair} disabled={repairBusy}>
            {repairBusy ? "Repairing…" : "Send the traceback back and retry"}
          </button>
        )}
      </div>

      {panel.result?.code && <CodeBlock code={panel.result.code} label="The code it wrote" />}
    </section>
  );
}
