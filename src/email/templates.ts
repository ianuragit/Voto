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
  const explainer = `Results stay hidden until all ${input.voterCount} of you have voted. If anyone misses the deadline, the poll fails and nobody sees anything.`;
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

/** §12 Q6 — completion mail carries a link, never the numbers. */
export function resultsReadyEmail(input: { question: string; pollId: string }): EmailBody {
  const url = `${config.PUBLIC_BASE_URL}/p/${input.pollId}`;
  const text = [
    'Everyone has voted. The result is available.',
    '',
    input.question,
    '',
    url,
    '',
    'The numbers are deliberately not in this email.',
    `The poll and its result are deleted ${RETENTION_DAYS_AFTER_END} days from now — save what you need.`,
  ].join('\n');
  const html = shell(`
<h1 style="margin:0 0 14px;font-size:20px">Everyone voted. The result is in.</h1>
<p style="margin:0 0 18px;color:#444">${esc(input.question)}</p>
<p style="margin:0 0 18px"><a href="${esc(url)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">See the result</a></p>
<p style="margin:0 0 6px;font-size:13px;color:#777">The numbers are deliberately not in this email.</p>
<p style="margin:0;font-size:13px;color:#777">The poll and its result are deleted ${RETENTION_DAYS_AFTER_END} days from now — save what you need.</p>`);
  return { subject: `Result: ${truncate(input.question, 110)}`, html, text };
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
