import { runCommand } from "./commands.js";

export interface SmartSummary {
  model: string | null;
  serial: string | null;
  passed: boolean | null;
  temperatureCelsius: number | null;
  reallocatedSectors: number | null;
  pendingSectors: number | null;
  powerOnHours: number | null;
  percentageUsed: number | null;
}

interface SmartctlAttribute {
  id: number;
  raw: { value: number };
}

interface SmartctlReport {
  model_name?: string;
  serial_number?: string;
  smart_status?: { passed: boolean };
  temperature?: { current: number };
  power_on_time?: { hours: number };
  ata_smart_attributes?: { table: SmartctlAttribute[] };
  nvme_smart_health_information_log?: { percentage_used: number; media_errors: number };
}

const reallocatedSectorCount = 5;
const currentPendingSectors = 197;
const cacheMilliseconds = 60_000;
const cache = new Map<string, { at: number; summary: SmartSummary | null }>();

function rawAttribute(report: SmartctlReport, id: number): number | null {
  return report.ata_smart_attributes?.table.find((attribute) => attribute.id === id)?.raw.value ?? null;
}

function summarise(report: SmartctlReport): SmartSummary {
  const nvme = report.nvme_smart_health_information_log;
  return {
    model: report.model_name ?? null,
    serial: report.serial_number ?? null,
    passed: report.smart_status?.passed ?? null,
    temperatureCelsius: report.temperature?.current ?? null,
    reallocatedSectors: rawAttribute(report, reallocatedSectorCount) ?? nvme?.media_errors ?? null,
    pendingSectors: rawAttribute(report, currentPendingSectors),
    powerOnHours: report.power_on_time?.hours ?? null,
    percentageUsed: nvme?.percentage_used ?? null,
  };
}

/** @implNote USB bridges differ: Realtek NVMe bridges answer `-d auto`, the SATA bridges only `-d sat`. */
async function readReport(devicePath: string): Promise<SmartctlReport | null> {
  for (const deviceType of ["auto", "sat"]) {
    const result = await runCommand("smartctl", ["-j", "-i", "-H", "-A", "-d", deviceType, devicePath]);
    if (!result.stdout) continue;
    const report = JSON.parse(result.stdout) as SmartctlReport;
    if (report.smart_status) return report;
  }
  return null;
}

export async function smartSummary(devicePath: string): Promise<SmartSummary | null> {
  const cached = cache.get(devicePath);
  if (cached && Date.now() - cached.at < cacheMilliseconds) return cached.summary;
  const report = await readReport(devicePath);
  const summary = report ? summarise(report) : null;
  cache.set(devicePath, { at: Date.now(), summary });
  return summary;
}
