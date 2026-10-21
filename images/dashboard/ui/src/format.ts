const byteUnits = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "unknown";
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < byteUnits.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${byteUnits[unitIndex]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(fraction: number): string {
  return `${Math.floor(fraction * 100)}%`;
}

export function usedFraction(space: { size: number; used: number } | null | undefined): number | null {
  if (!space || space.size <= 0) return null;
  return Math.min(1, Math.max(0, space.used / space.size));
}

/** Completion arrives either as 0 to 1 or as 0 to 100 depending on the source (Syncthing uses percent). */
export function normaliseCompletion(completion: number): number {
  return completion > 1 ? completion / 100 : completion;
}

const timeUnits: [number, string][] = [
  [86_400_000, "d"],
  [3_600_000, "h"],
  [60_000, "min"],
];

export function formatAge(timestamp: string | null | undefined, now: number = Date.now()): string {
  if (!timestamp) return "never";
  const elapsed = now - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed)) return "unknown";
  if (elapsed < 60_000) return "just now";
  for (const [milliseconds, unit] of timeUnits) {
    if (elapsed >= milliseconds) return `${Math.floor(elapsed / milliseconds)} ${unit} ago`;
  }
  return "just now";
}

export function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

export function formatDate(timestamp: string | null | undefined): string {
  if (!timestamp) return "never";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function shortDeviceId(deviceId: string): string {
  return deviceId.split("-")[0] ?? deviceId;
}

export function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}
