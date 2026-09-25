import type { ExecutionResult, JudgeResult, ModelResult, Settings, SlotConfig } from "../types";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `Gateway returned non-JSON (HTTP ${res.status})` }));
  return data as T;
}

export interface GraphiteResponse {
  ok: boolean;
  promptHash?: string;
  results?: { a: ModelResult; b: ModelResult };
  error?: string;
}

export function runBothSlots(
  question: string,
  slots: { a: SlotConfig; b: SlotConfig },
  settings: Settings,
): Promise<GraphiteResponse> {
  return post<GraphiteResponse>("/api/graphite", { question, slots, settings });
}

export function executeCode(code: string): Promise<ExecutionResult> {
  return post<ExecutionResult>("/api/execute", { code });
}

export interface RepairResponse {
  ok: boolean;
  code?: string;
  rawReply?: string;
  latencyMs?: number;
  reasoningTokens?: number | null;
  reasoningSupported?: boolean;
  sha256?: string;
  execution?: ExecutionResult;
  error?: string;
}

export function repairPanel(
  slot: SlotConfig,
  question: string,
  code: string,
  traceback: string,
  settings: Settings,
): Promise<RepairResponse> {
  return post<RepairResponse>("/api/repair", { slot, question, code, traceback, settings });
}

export function judgeCall(
  question: string,
  panels: {
    a: { label: string; model: string; ok: boolean; crashed: boolean; blocked: boolean; timedOut: boolean; runtimeMs: number; code: string; measured: unknown };
    b: { label: string; model: string; ok: boolean; crashed: boolean; blocked: boolean; timedOut: boolean; runtimeMs: number; code: string; measured: unknown };
  },
  slot: SlotConfig,
): Promise<JudgeResult> {
  return post<JudgeResult>("/api/judge", { question, panels, slot });
}

export async function fetchModels(baseUrl: string, apiKey: string): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  return post<{ ok: boolean; models?: string[]; error?: string }>("/api/models", { baseUrl, apiKey });
}
