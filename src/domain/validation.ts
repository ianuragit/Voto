import { z } from 'zod';

/** §5.1 — everything that can be wrong about a poll is wrong here, not later. */

export const MIN_VOTERS = 3; // §2.2 / US-2 — below this, anonymity is a lie.
export const MAX_VOTERS = 25;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const ABSTAIN_LABEL = 'Abstain';

/**
 * Voting runs for one of three standard durations. An arbitrary closing time
 * is not offered: a deadline is a lever — "closes in 40 minutes" is a way to
 * shape who manages to vote — and standard durations take that lever away.
 * They also make every poll's clock legible to voters without arithmetic.
 */
export const ALLOWED_DURATION_DAYS = [3, 5, 7] as const;
export type DurationDays = (typeof ALLOWED_DURATION_DAYS)[number];

/** A poll and everything it produced are deleted this long after it ends. */
export const RETENTION_DAYS_AFTER_END = 7;

/**
 * Pragmatic RFC-5322 subset: the addresses that actually deliver. Rejects
 * display names, quoted local parts and bare domains.
 */
const EMAIL_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** FR-1.3 — comma / newline / semicolon separated, trimmed, lowercased, deduped. */
export function parseEmailList(raw: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[,\n;]/)) {
    const candidate = part.trim().toLowerCase();
    if (candidate.length === 0) continue;
    if (!isEmail(candidate)) {
      invalid.push(part.trim());
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    emails.push(candidate);
  }
  return { emails, invalid };
}

/** FR-1.2 — 2–6 options, each 1–80 chars, unique (case-insensitively), order preserved. */
export function parseOptions(rawOptions: string[]): { options: string[]; error: string | null } {
  const options = rawOptions.map((o) => o.trim()).filter((o) => o.length > 0);
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return { options, error: `Give between ${MIN_OPTIONS} and ${MAX_OPTIONS} options.` };
  }
  if (options.some((o) => o.length > 80)) {
    return { options, error: 'Each option must be 80 characters or fewer.' };
  }
  const lowered = options.map((o) => o.toLowerCase());
  if (new Set(lowered).size !== options.length) {
    return { options, error: 'Options must be distinct.' };
  }
  if (lowered.includes(ABSTAIN_LABEL.toLowerCase())) {
    return {
      options,
      error: `"${ABSTAIN_LABEL}" is added by the checkbox below, not as an option.`,
    };
  }
  return { options, error: null };
}

export const createPollSchema = z.object({
  question: z.string().trim().min(1, 'A question is required.').max(280),
  options: z.array(z.string()).min(1).max(MAX_OPTIONS),
  voters: z.string().min(1, 'List the voters.'),
  duration_days: z.union([z.string(), z.number()]),
  /** FR-1.4 — the creator is a voter only if they say so. */
  creator_votes: z.union([z.string(), z.boolean()]).optional(),
  /** §12 Q7 — opt-in explicit abstention. */
  allow_abstain: z.union([z.string(), z.boolean()]).optional(),
});

export function checkboxOn(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return /^(1|true|on|yes)$/i.test(value.trim());
}

export interface DeadlineResult {
  closesAtIso: string | null;
  durationDays: DurationDays | null;
  error: string | null;
}

export function isAllowedDuration(value: number): value is DurationDays {
  return (ALLOWED_DURATION_DAYS as readonly number[]).includes(value);
}

/**
 * FR-1.5 — the deadline is derived from one of the standard durations, never
 * supplied directly, and stored UTC. There is no code path that accepts an
 * arbitrary closing time.
 */
export function resolveDeadline(rawDays: unknown, now: Date = new Date()): DeadlineResult {
  const days = Number(typeof rawDays === 'string' ? rawDays.trim() : rawDays);
  if (!Number.isFinite(days) || !isAllowedDuration(days)) {
    return {
      closesAtIso: null,
      durationDays: null,
      error: `Voting runs for ${ALLOWED_DURATION_DAYS.join(', ')} days. Pick one of those.`,
    };
  }
  const closesAt = new Date(now.getTime() + days * 24 * 3600_000);
  return { closesAtIso: closesAt.toISOString(), durationDays: days, error: null };
}

export const voteSchema = z.object({
  token: z.string().min(1).max(200),
  option_index: z.coerce.number().int().min(0).max(MAX_OPTIONS),
  csrf: z.string().min(1).max(200),
});

export const verifyCodeSchema = z.object({
  code: z.string().min(1).max(40),
  csrf: z.string().min(1).max(200),
});

export const rosterPatchSchema = z.object({
  old_email: z.string().min(3).max(254),
  new_email: z.string().min(3).max(254),
});
