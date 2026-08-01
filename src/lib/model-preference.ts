// Author: Navjyot Nishant
// Created: 2026-07-31
// Last updated: 2026-07-31
// Description: Shared default agent/model preference used to seed new workflow nodes.

import { useCallback, useEffect, useState } from "react";

export type ModelPreference = { agent: string; model: string };

const STORAGE_KEY = "specter_default_model_v1";
const EVENT = "specter:model-preference";
const FALLBACK: ModelPreference = { agent: "codex", model: "" };

export function readModelPreference(): ModelPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return FALLBACK;
    const parsed = JSON.parse(raw) as Partial<ModelPreference>;
    return { agent: parsed.agent || FALLBACK.agent, model: parsed.model ?? "" };
  } catch {
    return FALLBACK;
  }
}

export function writeModelPreference(next: ModelPreference) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — keep the in-memory value */
  }
  // `storage` only fires in *other* tabs, so notify this one explicitly.
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

/** Subscribes to preference changes from anywhere in the app (and other tabs). */
export function useModelPreference(): [ModelPreference, (next: ModelPreference) => void] {
  const [preference, setPreference] = useState<ModelPreference>(readModelPreference);

  useEffect(() => {
    const sync = () => setPreference(readModelPreference());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((next: ModelPreference) => {
    writeModelPreference(next);
    setPreference(next);
  }, []);

  return [preference, update];
}
