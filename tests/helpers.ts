import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { setTransport } from '../src/email/mailer.js';
import { createPoll } from '../src/services/pollService.js';
import type { EmailBody } from '../src/email/templates.js';

export interface CapturedInvite {
  email: string;
  token: string;
  code: string;
}

const captured: { to: string; body: EmailBody }[] = [];

export function installCapturingTransport(): void {
  captured.length = 0;
  setTransport(async (to, body) => {
    captured.push({ to, body });
    return { ok: true };
  });
}

export function sentMail(): { to: string; body: EmailBody }[] {
  return captured;
}

export function clearMail(): void {
  captured.length = 0;
}

/** Lets the fire-and-forget invite dispatch settle. */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

export function invitesFromMail(): CapturedInvite[] {
  const out: CapturedInvite[] = [];
  for (const { to, body } of captured) {
    const token = body.text.match(/\/v\/([A-Za-z0-9_-]+)/)?.[1];
    const code = body.text.match(/enter code:\s*([0-9A-Z-]+)/)?.[1];
    if (token && code) out.push({ email: to, token, code });
  }
  return out;
}

/**
 * Moves a poll's clock in the store directly. There is no API that changes a
 * deadline or a finalisation time, which is the point — so tests reach for the
 * database rather than a back door in the application.
 */
export function rewindClock(
  pollId: string,
  change: { closesAtMsAgo?: number; finalizedMsAgo?: number },
): void {
  const db = new Database(path.join(config.DATA_DIR, 'auth.sqlite'));
  if (change.closesAtMsAgo !== undefined) {
    db.prepare('UPDATE polls SET closes_at = ? WHERE poll_id = ?').run(
      new Date(Date.now() - change.closesAtMsAgo).toISOString(),
      pollId,
    );
  }
  if (change.finalizedMsAgo !== undefined) {
    db.prepare('UPDATE polls SET finalized_at = ? WHERE poll_id = ?').run(
      new Date(Date.now() - change.finalizedMsAgo).toISOString(),
      pollId,
    );
  }
  db.close();
}

export const DAY_MS = 24 * 3600_000;

export interface Made {
  pollId: string;
  configHash: string;
  invites: CapturedInvite[];
}

/** Creates a poll end-to-end and hands back the credentials that were mailed out. */
export async function makePoll(
  overrides: Partial<{
    question: string;
    rawOptions: string[];
    voters: string[];
    durationDays: number;
    allowAbstain: boolean;
  }> = {},
): Promise<Made> {
  installCapturingTransport();
  const voters = overrides.voters ?? ['priya@example.com', 'sam@example.com', 'devi@example.com'];
  const result = createPoll({
    question: overrides.question ?? 'Do we take the bridge round?',
    rawOptions: overrides.rawOptions ?? ['Yes', 'No'],
    rawVoters: voters.join(', '),
    rawDurationDays: overrides.durationDays ?? 3,
    creatorEmail: 'ravi@example.com',
    creatorVotes: false,
    allowAbstain: overrides.allowAbstain ?? false,
  });
  if (!result.ok) throw new Error(`poll creation failed: ${result.error}`);
  await flush();
  return { pollId: result.pollId, configHash: result.configHash, invites: invitesFromMail() };
}
