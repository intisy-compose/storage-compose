import assert from "node:assert/strict";

/**
 * Polls `condition` until it holds, failing after `deadlineMs`.
 * @implNote The deadline is generous on purpose: the suite runs its files in parallel, and a loaded machine must not fail a test that waits for the right thing.
 */
export async function until(condition: () => boolean | Promise<boolean>, what: string, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
