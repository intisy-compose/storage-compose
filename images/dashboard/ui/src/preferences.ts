export type ThemeChoice = "system" | "light" | "dark";

const themeKey = "storage-dashboard.theme";
const inventoryKey = "storage-dashboard.inventory-item-url";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null || value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private window): the choice lasts for this page only.
  }
}

export function storedTheme(): ThemeChoice {
  const stored = readStored(themeKey);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
  writeStored(themeKey, choice === "system" ? null : choice);
}

export function nextTheme(choice: ThemeChoice): ThemeChoice {
  if (choice === "system") return "light";
  if (choice === "light") return "dark";
  return "system";
}

export function storedInventoryItemUrl(): string {
  return readStored(inventoryKey) ?? "";
}

export function storeInventoryItemUrl(pattern: string): void {
  writeStored(inventoryKey, pattern.trim());
}

/**
 * The pattern holds `{asset}` where the asset code goes, e.g.
 * `https://inventree.example.ts.net/web/stock?search={asset}`; without it the code is appended.
 */
export function inventoryLink(pattern: string, asset: string): string | null {
  if (!pattern) return null;
  const encoded = encodeURIComponent(asset);
  return pattern.includes("{asset}") ? pattern.replaceAll("{asset}", encoded) : `${pattern}${encoded}`;
}
