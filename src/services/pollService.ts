import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logging.js';
import { generateCode, generateToken, hashCode, hashToken, computeConfigHash } from '../domain/crypto.js';
import {
  ABSTAIN_LABEL,
  MAX_VOTERS,
  MIN_VOTERS,
  isEmail,
  parseEmailList,
  parseOptions,
  resolveDeadline,
} from '../domain/validation.js';
import * as authRepo from '../repos/authRepo.js';
import * as tallyRepo from '../repos/tallyRepo.js';
import { inviteEmail, pollCancelledEmail } from '../email/templates.js';
import { sendEmail } from '../email/mailer.js';

export interface CreatePollRequest {
  question: string;
  rawOptions: string[];
  rawVoters: string;
  /** One of the standard durations: 3, 5 or 7 days. */
  rawDurationDays: unknown;
  creatorEmail: string;
  creatorVotes: boolean;
  allowAbstain: boolean;
}

export type CreatePollResult =
  | { ok: true; pollId: string; configHash: string; voterCount: number }
  | { ok: false; error: string };

interface Issued {
  email: string;
  token: string;
  code: string;
  tokenHash: string;
}

function issueFor(pollId: string, email: string): Issued {
  const token = generateToken();
  const code = generateCode();
  return { email, token, code, tokenHash: hashToken(token) };
}

/** §5.1 — create the poll, seed the tallies, mint the tokens, send the mail. */
export function createPoll(req: CreatePollRequest): CreatePollResult {
  const question = req.question.trim();
  if (question.length === 0 || question.length > 280) {
    return { ok: false, error: 'The question must be between 1 and 280 characters.' };
  }

  const { options, error: optionError } = parseOptions(req.rawOptions);
  if (optionError) return { ok: false, error: optionError };

  const { emails, invalid } = parseEmailList(req.rawVoters);
  if (invalid.length > 0) {
    return { ok: false, error: `These addresses don't look valid: ${invalid.join(', ')}` };
  }

  const creatorEmail = req.creatorEmail.trim().toLowerCase();
  // FR-1.4 — the creator is on the roster only when they ask to be.
  const roster = [...emails];
  if (req.creatorVotes && !roster.includes(creatorEmail)) roster.push(creatorEmail);
  if (!req.creatorVotes && roster.includes(creatorEmail)) {
    return {
      ok: false,
      error: 'Your own address is in the voter list. Tick "I am voting too", or remove it.',
    };
  }

  // US-2 / §2.2 — below three voters, the tool refuses rather than promise anonymity it can't keep.
  if (roster.length < MIN_VOTERS) {
    return {
      ok: false,
      error: `Voto needs at least ${MIN_VOTERS} voters. With two people a split result tells each of you exactly how the other voted — that is arithmetic, not a setting. Go and talk instead.`,
    };
  }
  if (roster.length > MAX_VOTERS) {
    return { ok: false, error: `A poll can have at most ${MAX_VOTERS} voters.` };
  }

  // One instant for both timestamps, so closes_at is exactly N days after
  // created_at rather than a few milliseconds short of it.
  const now = new Date();
  const { closesAtIso, error: deadlineError } = resolveDeadline(req.rawDurationDays, now);
  if (deadlineError || !closesAtIso) return { ok: false, error: deadlineError ?? 'Invalid duration.' };

  // §12 Q7 — abstention is participation, and it is visible as an option to everyone.
  const finalOptions = req.allowAbstain ? [...options, ABSTAIN_LABEL] : options;

  const pollId = randomUUID();
  const configHash = computeConfigHash({
    question,
    options: finalOptions,
    voterEmails: roster,
    closesAt: closesAtIso,
  });
  const issued = roster.map((email) => issueFor(pollId, email));

  // FR-1.6 — seed the counters first. A tally row that exists with nobody able
  // to reach it is harmless; a vote arriving at a missing row is not.
  tallyRepo.seedTallies(pollId, finalOptions.length);
  authRepo.createPoll({
    pollId,
    question,
    options: finalOptions,
    voterCount: roster.length,
    creatorEmail,
    configHash,
    createdAt: now.toISOString(),
    closesAt: closesAtIso,
    tokens: issued.map((i) => ({
      tokenHash: i.tokenHash,
      codeHash: hashCode(pollId, i.code),
      email: i.email,
    })),
  });

  void dispatchInvites({
    pollId,
    question,
    options: finalOptions,
    roster,
    configHash,
    closesAt: closesAtIso,
    issued,
  });

  log.info('poll created', { poll_id: pollId, voter_count: roster.length });
  return { ok: true, pollId, configHash, voterCount: roster.length };
}

interface DispatchInput {
  pollId: string;
  question: string;
  options: string[];
  roster: string[];
  configHash: string;
  closesAt: string;
  issued: Issued[];
  reissued?: boolean;
}

/** FR-2.7 / §9 — one API call per recipient, never BCC: each mail carries a unique token. */
async function dispatchInvites(input: DispatchInput): Promise<void> {
  await Promise.all(
    input.issued.map(async (i) => {
      const body = inviteEmail({
        question: input.question,
        options: input.options,
        roster: input.roster,
        configHash: input.configHash,
        closesAt: input.closesAt,
        pollId: input.pollId,
        token: i.token,
        code: i.code,
        voterCount: input.roster.length,
        reissued: input.reissued ?? false,
      });
      const result = await sendEmail(i.email, body);
      try {
        authRepo.setDeliveryStatusByHash(i.tokenHash, result.ok ? 'sent' : 'failed');
      } catch (err) {
        log.error('could not record delivery status', { poll_id: input.pollId });
      }
    }),
  );
}

export type SimpleResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * US-4 — cancel destroys the tallies. Everyone is told; nobody, creator
 * included, ever learns the partial count.
 */
export function cancelPoll(pollId: string, creatorEmail: string): SimpleResult {
  const poll = authRepo.getPoll(pollId);
  if (!poll) return { ok: false, status: 404, error: 'No such poll.' };
  if (poll.creatorEmail !== creatorEmail.toLowerCase()) {
    return { ok: false, status: 403, error: 'Only the creator can cancel this poll.' };
  }
  if (poll.status !== 'open' && poll.status !== 'at_risk') {
    return { ok: false, status: 409, error: `This poll is already ${poll.status}.` };
  }

  const roster = authRepo.listRosterEmails(pollId);
  authRepo.setStatus(pollId, 'cancelled');
  tallyRepo.deleteTallies(pollId);
  authRepo.purgeEmails(pollId);

  const body = pollCancelledEmail({ question: poll.question });
  void Promise.all(roster.map((email) => sendEmail(email, body)));
  log.info('poll cancelled', { poll_id: pollId });
  return { ok: true };
}

/**
 * §8 `POST /resend` — goes to everyone, never one person (FR-4.1). Fresh tokens
 * for the whole roster, so a targeted resend is not even expressible.
 */
export function resendInvites(pollId: string, creatorEmail: string): SimpleResult {
  const poll = authRepo.getPoll(pollId);
  if (!poll) return { ok: false, status: 404, error: 'No such poll.' };
  if (poll.creatorEmail !== creatorEmail.toLowerCase()) {
    return { ok: false, status: 403, error: 'Only the creator can resend invites.' };
  }
  if (poll.status !== 'open' && poll.status !== 'at_risk') {
    return { ok: false, status: 409, error: `This poll is ${poll.status}.` };
  }

  const tokens = authRepo.listTokens(pollId);
  const roster = tokens.map((t) => t.email).filter((e): e is string => e !== null);

  // Every ballot is reissued, consumed or not. Reissuing only the unused ones
  // would make the mailing list a turnout roster.
  const issued: Issued[] = [];
  for (const existing of tokens) {
    if (!existing.email) continue;
    const next = issueFor(pollId, existing.email);
    const replaced = authRepo.reissueToken({
      pollId,
      oldTokenHash: existing.tokenHash,
      tokenHash: next.tokenHash,
      codeHash: hashCode(pollId, next.code),
    });
    if (replaced) issued.push(next);
  }

  void dispatchInvites({
    pollId,
    question: poll.question,
    options: poll.options,
    roster,
    configHash: poll.configHash,
    closesAt: poll.closesAt,
    issued,
    reissued: true,
  });
  log.info('invites resent', { poll_id: pollId });
  return { ok: true };
}

/** FR-1.8 — one address may be corrected, and only while nobody has voted. */
export function correctRoster(
  pollId: string,
  creatorEmail: string,
  oldEmailRaw: string,
  newEmailRaw: string,
): SimpleResult {
  const poll = authRepo.getPoll(pollId);
  if (!poll) return { ok: false, status: 404, error: 'No such poll.' };
  if (poll.creatorEmail !== creatorEmail.toLowerCase()) {
    return { ok: false, status: 403, error: 'Only the creator can edit the roster.' };
  }
  if (poll.status !== 'open') return { ok: false, status: 409, error: `This poll is ${poll.status}.` };

  // The electorate freezes the moment anybody votes.
  if (authRepo.countConsumed(pollId) > 0 || tallyRepo.sumTallies(pollId) > 0) {
    return { ok: false, status: 409, error: 'Someone has already voted. The roster is frozen.' };
  }

  const oldEmail = oldEmailRaw.trim().toLowerCase();
  const newEmail = newEmailRaw.trim().toLowerCase();
  if (!isEmail(newEmail)) return { ok: false, status: 400, error: 'That replacement address is not valid.' };

  const roster = authRepo.listRosterEmails(pollId);
  if (!roster.includes(oldEmail)) {
    return { ok: false, status: 404, error: 'That address is not on this roster.' };
  }
  if (roster.includes(newEmail)) {
    return { ok: false, status: 409, error: 'That address is already on the roster.' };
  }

  const nextRoster = roster.map((e) => (e === oldEmail ? newEmail : e));
  const configHash = computeConfigHash({
    question: poll.question,
    options: poll.options,
    voterEmails: nextRoster,
    closesAt: poll.closesAt,
  });
  const replacement = issueFor(pollId, newEmail);
  const replaced = authRepo.replaceRosterEmail({
    pollId,
    oldEmail,
    newEmail,
    tokenHash: replacement.tokenHash,
    codeHash: hashCode(pollId, replacement.code),
    configHash,
  });
  if (!replaced) return { ok: false, status: 409, error: 'That ballot could not be reissued.' };

  // FR-1.8 — the hash changed, so everyone gets the new one. That means fresh
  // ballots for the whole roster, which is also why this is only allowed at zero votes.
  const issued: Issued[] = [replacement];
  for (const existing of authRepo.listTokens(pollId)) {
    if (!existing.email || existing.email === newEmail) continue;
    const next = issueFor(pollId, existing.email);
    const ok = authRepo.reissueToken({
      pollId,
      oldTokenHash: existing.tokenHash,
      tokenHash: next.tokenHash,
      codeHash: hashCode(pollId, next.code),
    });
    if (ok) issued.push(next);
  }

  void dispatchInvites({
    pollId,
    question: poll.question,
    options: poll.options,
    roster: nextRoster,
    configHash,
    closesAt: poll.closesAt,
    issued,
    reissued: true,
  });
  log.info('roster corrected', { poll_id: pollId });
  return { ok: true };
}

export function creatorIsAllowed(email: string): boolean {
  return config.ALLOWED_CREATORS.includes(email.trim().toLowerCase());
}
