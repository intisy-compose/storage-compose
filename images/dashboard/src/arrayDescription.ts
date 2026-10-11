import { readFile } from "node:fs/promises";
import { arrayDescriptionFile } from "./settings.js";

export interface RoleAsset {
  asset: string;
  url: string | null;
  serial: string | null;
}

/**
 * @implNote Reads only the subset `array.toml` uses: top-level and `[role]` sections of
 * `key = "string"` or `key = number` pairs, so the image needs no TOML dependency.
 */
function parseSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>([["", new Map()]]);
  let current = sections.get("")!;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (header) {
      current = new Map();
      sections.set(header[1], current);
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|(\d+))$/);
    if (pair) current.set(pair[1], pair[2] ?? pair[3]);
  }
  return sections;
}

export async function roleAssets(): Promise<Map<string, RoleAsset>> {
  let text: string;
  try {
    text = await readFile(arrayDescriptionFile, "utf8");
  } catch {
    return new Map();
  }
  const sections = parseSections(text);
  const inventoryItemUrl = sections.get("")?.get("inventory_item_url") ?? null;
  const assets = new Map<string, RoleAsset>();
  for (const [role, values] of sections) {
    const asset = values.get("asset");
    if (!role || !asset) continue;
    const item = values.get("item");
    assets.set(role, {
      asset,
      url: inventoryItemUrl && item ? `${inventoryItemUrl}${item}` : null,
      serial: values.get("serial") ?? null,
    });
  }
  return assets;
}

/** Null when either serial is unknown, which is the case for every drive without SMART. */
export function isSerialMismatch(recorded: string | null, reported: string | null): boolean | null {
  if (!recorded || !reported) return null;
  return recorded.trim().toUpperCase() !== reported.trim().toUpperCase();
}
