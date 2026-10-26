/** Wraps `task` so a call while an earlier one still runs is skipped instead of piling up behind it. */
export function skipWhileRunning(task: () => Promise<void>): () => Promise<void> {
  let isRunning = false;
  return async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await task();
    } finally {
      isRunning = false;
    }
  };
}
