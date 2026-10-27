type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `fromConfig` in the shape `formValue` has, or undefined where the shapes differ: Syncthing's keys hold some values the form keeps its own way. */
function inFormShape(formValue: unknown, fromConfig: unknown): unknown {
  if (Array.isArray(formValue)) {
    const isPrimitiveList = Array.isArray(fromConfig) && fromConfig.every((entry) => typeof entry !== "object" || entry === null);
    return isPrimitiveList && formValue.every((entry) => typeof entry !== "object" || entry === null) ? [...fromConfig] : undefined;
  }
  if (isPlain(formValue)) {
    if (!isPlain(fromConfig)) return undefined;
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
