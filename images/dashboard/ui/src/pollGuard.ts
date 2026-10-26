/**
 * Wraps `task` so calls while it runs do not pile up behind it: however many there were, it runs once more after the current run, and they all settle with that run.
 * @implNote A failed run is passed on only when no call asked for another meanwhile; otherwise the run asked for is the answer, as it read after the failure.
 */
export function coalesceWhileRunning(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let isAskedAgain = false;
  const runUntilNotAskedAgain = async () => {
    try {
      do {
        isAskedAgain = false;
        try {
          await task();
        } catch (error) {
          if (!isAskedAgain) throw error;
        }
      } while (isAskedAgain);
    } finally {
      running = null;
    }
  };
  return () => {
    if (running) {
      isAskedAgain = true;
      return running;
    }
    running = runUntilNotAskedAgain();
    return running;
  };
}

/** Reads again while `changeCount` moved during a read, so an answer that started before a saved write never shows the state the write replaced. */
export async function readUntilSettled<T>(read: () => Promise<T>, changeCount: () => number): Promise<T> {
  let countBefore: number;
  let answer: T;
  do {
    countBefore = changeCount();
    answer = await read();
  } while (changeCount() !== countBefore);
  return answer;
}
