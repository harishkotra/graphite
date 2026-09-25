import type { SlotConfig } from "../types";
import { PROVIDER_PRESETS } from "../lib/providers";

export interface SlotModels {
  [slotKey: string]: { loading: boolean; models: string[]; error: string | null };
}

export function SlotEditor({
  title,
  slotKey,
  slot,
  onChange,
  models,
  hideThinking,
  disabled,
}: {
  title: string;
  slotKey: string;
  slot: SlotConfig;
  onChange: (next: SlotConfig) => void;
  models: SlotModels[string];
  hideThinking: boolean;
  disabled: boolean;
}) {
  const preset = PROVIDER_PRESETS.find((p) => p.id === slot.provider) ?? PROVIDER_PRESETS[4];

  function pickProvider(id: string) {
    const p = PROVIDER_PRESETS.find((x) => x.id === id)!;
    onChange({ ...slot, provider: id, baseUrl: p.baseUrl });
  }

  const suggestions = preset.models ?? models.models;

  return (
    <fieldset className="slot-editor" disabled={disabled}>
      <legend>{title}</legend>

      <label className="field">
        <span>Provider</span>
        <select value={slot.provider} onChange={(e) => pickProvider(e.target.value)}>
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Base URL</span>
        <input
          type="text"
          value={slot.baseUrl}
          placeholder="https://…/v1"
          onChange={(e) => onChange({ ...slot, baseUrl: e.target.value.trim() })}
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span>API key {preset.needsKey ? "(required)" : "(not needed)"}</span>
        <input
          type="password"
          value={slot.apiKey}
          placeholder={preset.needsKey ? "paste key — stored in this browser only" : ""}
          onChange={(e) => onChange({ ...slot, apiKey: e.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span>Model {suggestions.length > 0 ? "(pick or type)" : "(type a name)"}</span>
        <input
          type="text"
          value={slot.model}
          list={`models-${slotKey}`}
          placeholder="model name"
          onChange={(e) => onChange({ ...slot, model: e.target.value.trim() })}
          spellCheck={false}
        />
        <datalist id={`models-${slotKey}`}>
          {(suggestions ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      {models.error && <div className="models-error">{models.error}</div>}
      {hideThinking && <div className="models-note">This provider does not report reasoning tokens — shown as n/a.</div>}
    </fieldset>
  );
}
