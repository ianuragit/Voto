import { config } from '../config.js';
import { esc, formatUtc } from '../domain/escape.js';
import { formatCode, formatHash } from '../domain/crypto.js';
import { RETENTION_DAYS_AFTER_END } from '../domain/validation.js';

export interface EmailBody {
  subject: string;
  html: string;
  text: string;
}

interface InviteInput {
  question: string;
  options: string[];
  roster: string[];
  configHash: string;
  closesAt: string;
  pollId: string;
  token: string;
  code: string;
  voterCount: number;
  reissued?: boolean;
}

const shell = (inner: string): string => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e2dd;border-radius:10px;padding:28px">
${inner}
<p style="margin:28px 0 0;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#888">
Voto — anonymous decisions for small teams. No one, including whoever set up this poll, can see how you voted.
</p>
</div></body></html>`;

/** FR-2.7 / §9 — the invite carries everything a voter needs to verify the poll. */
export function inviteEmail(input: InviteInput): EmailBody {
  const ballotUrl = `${config.PUBLIC_BASE_URL}/v/${input.token}`;
  const codeUrl = `${config.PUBLIC_BASE_URL}/c/${input.pollId}`;
  const pretty = formatCode(input.code);
  const explainer = `Results stay hidden until all ${input.voterCount} of you have voted — then the final counts are emailed to everyone on this list. If anyone misses the deadline, the poll fails and nobody sees anything.`;
  const retention = `This poll and its result are deleted ${RETENTION_DAYS_AFTER_END} days after voting ends.`;
  const prefix = input.reissued ? 'Updated ballot: ' : '';

  const text = [
    `${prefix}${input.question}`,
    '',
    'Options:',
    ...input.options.map((o, i) => `  ${i + 1}. ${o}`),
    '',
    `Vote here: ${ballotUrl}`,
    `Or go to ${codeUrl} and enter code: ${pretty}`,
    '',
    `Closes: ${formatUtc(input.closesAt)}`,
    '',
    explainer,
    retention,
    '',
    `Who is voting (${input.roster.length}):`,
    ...input.roster.map((e) => `  - ${e}`),
    '',
    'Config fingerprint (compare it with anyone else on this list — it must match):',
    formatHash(input.configHash),
    '',
    'Opening the link does not cast anything. You choose, then confirm.',
  ].join('\n');

  const html = shell(`
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888">${
    input.reissued ? 'Updated ballot' : 'You have a vote'
  }</p>
<h1 style="margin:0 0 18px;font-size:21px;line-height:1.3">${esc(input.question)}</h1>
<ul style="margin:0 0 22px;padding-left:20px">
${input.options.map((o) => `  <li style="margin:4px 0">${esc(o)}</li>`).join('\n')}
</ul>
<p style="margin:0 0 22px">
  <a href="${esc(ballotUrl)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Open my ballot</a>
</p>
<p style="margin:0 0 22px;font-size:14px;color:#444">
  On another device? Go to <a href="${esc(codeUrl)}" style="color:#1a1a1a">${esc(codeUrl)}</a> and enter
  <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:.06em">${esc(pretty)}</strong>
</p>
<p style="margin:0 0 6px;font-size:14px"><strong>Closes:</strong> ${esc(formatUtc(input.closesAt))}</p>
<p style="margin:0 0 6px;font-size:14px;color:#444">${esc(explainer)}</p>
<p style="margin:0 0 22px;font-size:14px;color:#444">${esc(retention)}</p>
<div style="background:#faf9f6;border:1px solid #eceae2;border-radius:8px;padding:14px 16px;font-size:13px">
  <p style="margin:0 0 6px;font-weight:600">Who is voting (${input.roster.length})</p>
  <p style="margin:0 0 12px;color:#444">${input.roster.map((e) => esc(e)).join('<br>')}</p>
  <p style="margin:0 0 6px;font-weight:600">Config fingerprint</p>
  <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;color:#444">${esc(
    formatHash(input.configHash),
  )}</p>
  <p style="margin:8px 0 0;color:#777">Compare this with anyone else on the list. If it matches, you are voting on identical terms.</p>
</div>
<p style="margin:18px 0 0;font-size:13px;color:#777">Opening the link does not cast anything — you pick, then confirm.</p>`);

  return { subject: `${prefix}${truncate(input.question, 120)}`, html, text };
}

export interface ResultsEmailInput {
  question: string;
  options: string[];
  pollId: string;
  counts: number[];
  totalBallots: number;
  rosterSize: number;
  deletesAt: string | null;
}

/**
 * Sent to every voter the moment the last ballot lands: the final counts and
 * the total ballot count, in the body.
 *
 * Note what this means, because it is a deliberate trade: the tally now lives
 * in everyone's inbox permanently, outliving the 7-day deletion of the poll
 * itself, and it can be forwarded anywhere. On a small roster a unanimous
 * result is therefore a permanent, portable record of how every named person
 * voted — so the mail says so when that happens rather than leaving the reader
 * to work it out.
 */
export function pollResultsEmail(input: ResultsEmailInput): EmailBody {
  const url = `${config.PUBLIC_BASE_URL}/p/${input.pollId}`;
  const top = Math.max(...input.counts);
  const winners = input.options.filter((_, i) => input.counts[i] === top);
  const tied = winners.length > 1;
  const unanimous = top === input.rosterSize && input.rosterSize > 0;

  const headline = tied
    ? `It is a tie: ${winners.join(' / ')}, ${top} each.`
    : `${winners[0]} — ${top} of ${input.totalBallots}.`;

  const caveat = unanimous
    ? `This result is unanimous, so it tells you how each of the ${input.rosterSize} of you voted. That is arithmetic, not a leak.`
    : null;

  const rows = input.options.map((option, i) => ({ option, count: input.counts[i] ?? 0 }));

  const text = [
    'Everyone has voted. Here is the result.',
    '',
    input.question,
    '',
    headline,
    '',
    'Counts:',
    ...rows.map((r) => `  ${r.option}: ${r.count}`),
    '',
    `Total ballots cast: ${input.totalBallots}`,
    `Voters invited: ${input.rosterSize}`,
    `Integrity: PASS — every invited voter cast exactly one ballot, and no extra ballot exists.`,
    ...(caveat ? ['', caveat] : []),
    '',
    `Full result: ${url}`,
    input.deletesAt
      ? `This poll and its result are deleted from Voto on ${formatUtc(input.deletesAt)}. This email is not deleted — keep it if you need the record.`
      : `This poll and its result are deleted from Voto ${RETENTION_DAYS_AFTER_END} days after it ended.`,
  ].join('\n');

  const max = Math.max(top, 1);
  const html = shell(`
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888">Everyone voted</p>
<h1 style="margin:0 0 8px;font-size:21px;line-height:1.3">${esc(input.question)}</h1>
<p style="margin:0 0 22px;font-size:18px;font-weight:600">${esc(headline)}</p>
${rows
  .map(
    (r) => `<div style="margin:0 0 12px">
  <div style="font-size:14px"><strong>${esc(r.option)}</strong> — ${r.count}</div>
  <div style="background:#f1efe8;border-radius:5px;height:20px;margin-top:4px">
    <div style="background:#1a1a1a;border-radius:5px;height:20px;width:${Math.round(
      (r.count / max) * 100,
    )}%"></div>
  </div>
</div>`,
  )
  .join('\n')}
<table style="width:100%;border-collapse:collapse;font-size:14px;margin:22px 0 0">
  <tr><td style="padding:7px 0;border-bottom:1px solid #eee;color:#666">Total ballots cast</td><td style="padding:7px 0;border-bottom:1px solid #eee;text-align:right"><strong>${
    input.totalBallots
  }</strong></td></tr>
  <tr><td style="padding:7px 0;border-bottom:1px solid #eee;color:#666">Voters invited</td><td style="padding:7px 0;border-bottom:1px solid #eee;text-align:right"><strong>${
    input.rosterSize
  }</strong></td></tr>
  <tr><td style="padding:7px 0;border-bottom:1px solid #eee;color:#666">Integrity</td><td style="padding:7px 0;border-bottom:1px solid #eee;text-align:right"><strong>PASS</strong></td></tr>
</table>
<p style="margin:14px 0 0;font-size:13px;color:#777">Every invited voter cast exactly one ballot, and no extra ballot exists.</p>
${
  caveat
    ? `<p style="margin:18px 0 0;padding:13px 15px;background:#fdf5e3;border:1px solid #f0e0bb;border-radius:8px;font-size:13px;color:#8a5a00">${esc(
        caveat,
      )}</p>`
    : ''
}
<p style="margin:22px 0 0"><a href="${esc(url)}" style="color:#1a1a1a">See it on Voto</a></p>
<p style="margin:10px 0 0;font-size:13px;color:#777">${
    input.deletesAt
      ? `This poll and its result are deleted from Voto on ${esc(
          formatUtc(input.deletesAt),
        )}. This email is not — keep it if you need the record.`
      : `This poll and its result are deleted from Voto ${RETENTION_DAYS_AFTER_END} days after it ended.`
  }</p>`);

  return { subject: `Result: ${truncate(input.question, 110)}`, html, text };
}

/**
 * FR-4.5 — when the count does not reconcile, the numbers are suppressed
 * everywhere, this email included. Voters are told why, and told nothing else.
 */
export function resultsWithheldEmail(input: {
  question: string;
  pollId: string;
  discrepancy: string;
}): EmailBody {
  const url = `${config.PUBLIC_BASE_URL}/p/${input.pollId}`;
  const text = [
    'Everyone voted, but the result did not pass its integrity check, so no numbers are being released.',
    '',
    input.question,
    '',
    input.discrepancy,
    '',
    'Voto shows counts only when they are provably complete. Run the decision again.',
    '',
    url,
  ].join('\n');
  const html = shell(`
<h1 style="margin:0 0 14px;font-size:20px">Result withheld — integrity check failed</h1>
<p style="margin:0 0 12px;color:#444">${esc(input.question)}</p>
<p style="margin:0 0 12px;padding:13px 15px;background:#fdeeee;border:1px solid #f2d5d5;border-radius:8px;font-size:14px;color:#8a1c1c">${esc(
    input.discrepancy,
  )}</p>
<p style="margin:0 0 18px;color:#444">Voto shows counts only when they are provably complete. Run the decision again.</p>
<p style="margin:0"><a href="${esc(url)}" style="color:#1a1a1a">${esc(url)}</a></p>`);
  return { subject: `Result withheld: ${truncate(input.question, 100)}`, html, text };
}

export function pollFailedEmail(input: {
  question: string;
  pollId: string;
  turnout: number;
  voterCount: number;
}): EmailBody {
  const url = `${config.PUBLIC_BASE_URL}/p/${input.pollId}`;
  const text = [
    'The deadline passed before everyone voted, so this poll failed.',
    '',
    input.question,
    '',
    `Turnout reached ${input.turnout} of ${input.voterCount}.`,
    'The counts have been deleted. Nobody sees them — not even whoever set the poll up.',
    '',
    url,
  ].join('\n');
  const html = shell(`
<h1 style="margin:0 0 14px;font-size:20px">No consensus — the poll failed</h1>
<p style="margin:0 0 12px;color:#444">${esc(input.question)}</p>
<p style="margin:0 0 12px">Turnout reached <strong>${input.turnout} of ${input.voterCount}</strong>.</p>
<p style="margin:0 0 18px;color:#444">The counts have been deleted. Nobody sees them — not even whoever set the poll up.</p>
<p style="margin:0"><a href="${esc(url)}" style="color:#1a1a1a">${esc(url)}</a></p>`);
  return { subject: `Failed: ${truncate(input.question, 110)}`, html, text };
}

export function pollCancelledEmail(input: { question: string }): EmailBody {
  const text = [
    'This poll was cancelled before it completed.',
    '',
    input.question,
    '',
    'Any votes already cast have been deleted. No count was ever revealed.',
  ].join('\n');
  const html = shell(`
<h1 style="margin:0 0 14px;font-size:20px">Poll cancelled</h1>
<p style="margin:0 0 12px;color:#444">${esc(input.question)}</p>
<p style="margin:0">Any votes already cast have been deleted. No count was ever revealed.</p>`);
  return { subject: `Cancelled: ${truncate(input.question, 110)}`, html, text };
}

export function creatorSignInEmail(input: { link: string }): EmailBody {
  const text = ['Sign in to Voto:', '', input.link, '', 'The link is good for 15 minutes.'].join('\n');
  const html = shell(`
<h1 style="margin:0 0 14px;font-size:20px">Sign in to Voto</h1>
<p style="margin:0 0 18px"><a href="${esc(input.link)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Sign in</a></p>
<p style="margin:0;font-size:13px;color:#777">The link is good for 15 minutes.</p>`);
  return { subject: 'Sign in to Voto', html, text };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
