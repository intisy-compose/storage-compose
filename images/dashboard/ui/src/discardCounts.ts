import type { DiscardCounts, ReadResult } from "./api.js";
import type { FolderActionState } from "./state.js";

type CountsState = Pick<FolderActionState, "discardOpen" | "discardCounts" | "discardCountsReading">;

const latestReads = new WeakMap<CountsState, number>();

/** Starts a read of the counts for the form as it opens now; the token names this read. */
export function startCountsRead(state: CountsState): number {
  const token = (latestReads.get(state) ?? 0) + 1;
  latestReads.set(state, token);
  state.discardCounts = null;
  state.discardCountsReading = true;
  return token;
}

/** The form was closed: an answer still on its way belongs to no open form. */
export function forgetCountsRead(state: CountsState): void {
  latestReads.set(state, (latestReads.get(state) ?? 0) + 1);
  state.discardCountsReading = false;
}

/**
 * Takes the answer of the read `token` started; false, changing nothing, when the form was closed or reopened since.
 * @implNote A slow answer for an earlier opening must neither show its count nor end a newer read's waiting.
 */
export function acceptCountsRead(state: CountsState, token: number, answer: ReadResult<DiscardCounts>): boolean {
  if (latestReads.get(state) !== token || !state.discardOpen) return false;
  state.discardCounts = answer.ok ? answer.value : null;
  state.discardCountsReading = false;
  return true;
}
