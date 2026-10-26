export type ThemeChoice = "system" | "light" | "dark";

const themeKey = "storage-dashboard.theme";

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
