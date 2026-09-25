import type { JudgeResult } from "../types";

function Score({ value }: { value: number | undefined }) {
  if (value === undefined || Number.isNaN(value)) return <span className="score score-missing">—</span>;
  const tone = value >= 8 ? "score-high" : value >= 6 ? "score-mid" : "score-low";
  return <span className={`score ${tone}`}>{value}</span>;
}

export function JudgeCard({ judge, models }: { judge: JudgeResult | null; models: { a: string; b: string } }) {
  if (!judge) return null;
  const p = judge.parsed;

  return (
    <aside className="judge" aria-label="Judge scorecard">
      <div className="judge-head">
        <span className="judge-eyebrow">Judge scorecard</span>
        {judge.latencyMs !== undefined && <span className="judge-latency">{judge.latencyMs} ms</span>}
      </div>

      {judge.error && (
        <div className="panel-error" role="alert">{judge.error}</div>
      )}

      {p ? (
        <>
          <div className="judge-grid">
            {(["a", "b"] as const).map((k) => (
              <div className={`judge-col judge-col-${k}`} key={k}>
                <div className="judge-model">{models[k]}</div>
                <div className="judge-scores">
                  <div className="judge-score">
                    <span className="judge-score-label">insight</span>
                    <Score value={p[k]?.insight} />
                  </div>
                  <div className="judge-score">
                    <span className="judge-score-label">clarity</span>
                    <Score value={p[k]?.clarity} />
                  </div>
                </div>
                <p className="judge-verdict">{p[k]?.verdict}</p>
              </div>
            ))}
          </div>
          <div className="judge-ship">
            Would ship: <strong>chart {String(p.ship || "?").toUpperCase()}</strong>
            {p.reason && <span className="judge-reason"> — {p.reason}</span>}
          </div>
        </>
      ) : (
        !judge.error && <div className="judge-raw-unparsed">Judge replied but the JSON did not parse — see raw output below.</div>
      )}

      {judge.raw && (
        <details className="judge-raw">
          <summary>Judge raw JSON</summary>
          <pre>{judge.raw}</pre>
        </details>
      )}
    </aside>
  );
}
