import type { VersioningType } from "../../src/api/types.js";
import { versioningParamKeys } from "../../src/api/versioningText.js";

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object holding only primitives, such as `minDiskFree` or versioning's `params`, whose keys may differ from one value to the next. */
function isFlatDictionary(value: Plain): boolean {
  return Object.values(value).every((entry) => typeof entry !== "object" || entry === null);
}

/** `fromConfig` in the shape `formValue` has, or undefined where the shapes differ: Syncthing's keys hold some values the form keeps its own way. */
function inFormShape(formValue: unknown, fromConfig: unknown): unknown {
  if (Array.isArray(formValue)) {
    const isPrimitiveList = Array.isArray(fromConfig) && fromConfig.every((entry) => typeof entry !== "object" || entry === null);
    return isPrimitiveList && formValue.every((entry) => typeof entry !== "object" || entry === null) ? [...fromConfig] : undefined;
  }
  if (isPlain(formValue)) {
    if (!isPlain(fromConfig)) return undefined;
    if (isFlatDictionary(formValue) && isFlatDictionary(fromConfig)) return { ...fromConfig };
    const shaped = Object.keys(formValue).map((key) => [key, inFormShape(formValue[key], fromConfig[key])] as const);
    return shaped.every(([, value]) => value !== undefined) ? Object.fromEntries(shaped) : undefined;
  }
  return typeof fromConfig === typeof formValue ? fromConfig : undefined;
}

/**
 * A form's saved values and draft after the advanced editor beside it saved `config`: each key the answer carries in the form's shape
 * is taken as saved, and into the draft too where the person had not changed it.
 * @implNote Never emptied and read again: the read might start before the save and refill what it replaced.
 */
export function followSavedConfig<Values extends object>(saved: Values, draft: Values, config: Plain): { saved: Values; draft: Values } {
  const nextSaved: Plain = structuredClone(saved) as Plain;
  const nextDraft: Plain = structuredClone(draft) as Plain;
  for (const key of Object.keys(nextSaved)) {
    const followed = Object.hasOwn(config, key) ? inFormShape(nextSaved[key], config[key]) : undefined;
    if (followed === undefined) continue;
    if (JSON.stringify(nextDraft[key]) === JSON.stringify(nextSaved[key])) nextDraft[key] = structuredClone(followed);
    nextSaved[key] = followed;
  }
  return { saved: nextSaved as Values, draft: nextDraft as Values };
}

/**
 * A folder as the advanced editor answered it, with versioning's `params` cut to its type's own, as the server's folder read shows them.
 * @implNote Syncthing keeps the params of every type a folder had, as a PATCH merges `params`.
 */
export function folderConfigForForm(config: Plain): Plain {
  if (!isPlain(config.versioning) || !isPlain(config.versioning.params)) return config;
  const versioning = config.versioning as Plain & { params: Plain };
  const keys: readonly string[] = versioningParamKeys[versioning.type as VersioningType] ?? [];
  const params = Object.fromEntries(Object.entries(versioning.params).filter(([key]) => keys.includes(key)));
  return { ...config, versioning: { ...versioning, params } };
}
