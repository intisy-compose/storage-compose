import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Notification {
  /** ntfy's 1 to 5. */
  priority: number;
  tags: string;
  title: string;
  message: string;
}

let sequence = 0;

/**
 * Queues a notification in the outbox on the status volume, which the mounter alone sends to ntfy, in name order, keeping what it could
 * not send (`images/mounter/lib/notify.sh`): the title, the priority, the tags, then the message.
 * @implNote Named as the mounter names its own, nanoseconds then a writer tag, and written as `.tmp` first, which the mounter skips.
 */
export async function queueNotification(outbox: string, notification: Notification, now = Date.now()): Promise<void> {
  await mkdir(outbox, { recursive: true });
  sequence = (sequence + 1) % 1_000_000;
  const file = join(outbox, `${BigInt(now) * 1_000_000n + BigInt(sequence)}-dashboard`);
  await writeFile(`${file}.tmp`, `${notification.title}\n${notification.priority}\n${notification.tags}\n${notification.message}\n`);
  await rename(`${file}.tmp`, file);
}
