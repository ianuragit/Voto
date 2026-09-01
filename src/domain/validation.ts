import { z } from 'zod';

/** §5.1 — everything that can be wrong about a poll is wrong here, not later. */

export const MIN_VOTERS = 3; // §2.2 / US-2 — below this, anonymity is a lie.
export const MAX_VOTERS = 25;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MIN_LEAD_MINUTES = 15;
export const MAX_LEAD_DAYS = 14;
export const ABSTAIN_LABEL = 'Abstain';

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
  closes_at: z.string().min(1, 'A closing time is required.'),
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
  error: string | null;
}

/** FR-1.5 — 15 minutes to 14 days ahead, stored UTC. */
export function normalizeDeadline(raw: string, now: Date = new Date()): DeadlineResult {
  // Accept both an ISO instant and the `datetime-local` value a browser posts.
  const candidate = /Z$|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    return { closesAtIso: null, error: 'That closing time is not a valid date.' };
  }
  const deltaMs = parsed.getTime() - now.getTime();
  if (deltaMs < MIN_LEAD_MINUTES * 60_000) {
    return { closesAtIso: null, error: `The closing time must be at least ${MIN_LEAD_MINUTES} minutes away.` };
  }
  if (deltaMs > MAX_LEAD_DAYS * 24 * 3600_000) {
    return { closesAtIso: null, error: `The closing time must be within ${MAX_LEAD_DAYS} days.` };
  }
  return { closesAtIso: parsed.toISOString(), error: null };
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
