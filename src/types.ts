export interface SlotConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Settings {
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
}

export interface ModelResult {
  label: "a" | "b";
  code: string | null;
  rawReply: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  reasoningSupported: boolean;
  retriedWithLargerBudget: boolean;
  sha256: string | null;
  error?: string;
}

export interface FigMeta {
  figsize_in: number[];
  dpi: number;
  axes: number;
  lines: number;
  patches: number;
  collections: number;
  images: number;
  titles: number;
  xlabels: number;
  ylabels: number;
  legends: number;
  suptitle: boolean;
  distinctColors: string[];
}

export interface ExecutionResult {
  ok: boolean;
  pngBase64: string | null;
  stdout: string;
  stderr: string;
  traceback: string | null;
  runtimeMs: number;
  figureCount: number;
  blocked: boolean;
  violations: { kind: string; detail: string; line?: number }[];
  figureMeta: FigMeta[];
  pngInfo: { width: number; height: number; bitDepth: number; colorType: number } | null;
  timedOut?: boolean;
  seatbelt?: boolean;
}

export interface JudgeParsed {
  a: { insight: number; clarity: number; verdict: string };
  b: { insight: number; clarity: number; verdict: string };
  ship: string;
  reason: string;
}

export interface JudgeResult {
  ok: boolean;
  raw?: string;
  parsed?: JudgeParsed | null;
  latencyMs?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  error?: string;
}

export interface Panel {
  label: "a" | "b";
  slot: SlotConfig;
  result: ModelResult | null;
  execution: ExecutionResult | null;
  repairAttempted: boolean;
}

export type Phase = "idle" | "asking" | "executing" | "judging" | "finished" | "error";

export interface RunState {
  phase: Phase;
  question: string;
  panels: { a: Panel; b: Panel };
  judge: JudgeResult | null;
  error: string | null;
  promptHash: string | null;
}
