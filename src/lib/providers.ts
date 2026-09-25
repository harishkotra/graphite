import type { SlotConfig } from "../types";

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  local: boolean;
  models?: string[]; // only for Particle — Ollama/LM Studio lists are read live, never hardcoded
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "particle",
    label: "Particle.ai",
    baseUrl: "https://api.particle.ai/v1",
    needsKey: true,
    local: false,
    models: ["deepseek-v4.1-flash", "deepseek-v4-flash-0731", "glm5.3flash"],
  },
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false, local: true },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false, local: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, local: false },
  { id: "custom", label: "Custom", baseUrl: "", needsKey: false, local: false },
];

export const DEFAULT_SLOTS: { a: SlotConfig; b: SlotConfig; judge: SlotConfig } = {
  a: { provider: "particle", baseUrl: "https://api.particle.ai/v1", apiKey: "", model: "deepseek-v4-flash-0731" },
  b: { provider: "particle", baseUrl: "https://api.particle.ai/v1", apiKey: "", model: "deepseek-v4.1-flash" },
  judge: { provider: "particle", baseUrl: "https://api.particle.ai/v1", apiKey: "", model: "deepseek-v4.1-flash" },
};

export const DEFAULT_SETTINGS = { temperature: 0.7, maxTokens: 1600, disableReasoning: false };

export const QUESTION_PRESETS = [
  "What is the most insightful chart in this data?",
  "Show the trend over time",
  "Show the relationship between two variables",
  "Find and visualise the anomaly",
];
