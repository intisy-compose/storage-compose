import { execFile } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCommand(file: string, args: string[], timeoutMs = 30_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
}
