import { esc, formatUtc } from '../../domain/escape.js';
import { formatHash } from '../../domain/crypto.js';
import type { PollView } from '../../services/resultsService.js';
import type { DeliveryStatus, Poll } from '../../repos/authRepo.js';
import {
  ALLOWED_DURATION_DAYS,
  MAX_VOTERS,
  MIN_VOTERS,
  RETENTION_DAYS_AFTER_END,
} from '../../domain/validation.js';
import { layout } from './layout.js';

/** §2.2 — the banner we show rather than promise anonymity the maths can't back. */
function smallNBanner(n: number): string {
  return `<p class="note warn">With ${n} voters, a unanimous result reveals everyone's vote. That is arithmetic, not a flaw in Voto.</p>`;
}

function turnoutBlock(view: PollView): string {
  const pct = view.voterCount === 0 ? 0 : Math.round((view.turnout / view.voterCount) * 100);
  return `
<h2>Turnout</h2>
<p class="big">${view.turnout} <span class="muted" style="font-size:16px;font-weight:400">of ${view.voterCount} voted</span></p>
<div class="bar"><span style="width:${pct}%"></span></div>
<p class="muted">A count, and only a count. Voto cannot tell anyone — creator included — which ${view.turnout} of you these are.</p>`;
}

function verifyBlock(view: PollView, roster?: string[]): string {
  return `
<h2>Verify this poll</h2>
${
  roster
    ? `<p class="muted">Everyone voting:</p><ul class="roster">${roster
        .map((e) => `<li>${esc(e)}</li>`)
        .join('')}</ul>`
    : ''
}
<p class="muted" style="margin-top:12px">Config fingerprint — compare it against your invite email and against anyone else's:</p>
<p class="hash">${esc(formatHash(view.configHash))}</p>`;
}

/**
 * §6.4 — every page that shows a poll says when it stops existing. A retention
 * rule nobody is told about is a data-loss bug the first time it fires.
 */
function retentionNote(view: PollView): string {
  if (view.deletesAt) {
    return `<p class="note warn">This poll and its result are deleted on <strong>${esc(
      formatUtc(view.deletesAt),
    )}</strong> — ${RETENTION_DAYS_AFTER_END} days after it ended. Save anything you need before then.</p>`;
  }
  return `<p class="muted">This poll, and whatever it decides, are deleted ${RETENTION_DAYS_AFTER_END} days after voting ends.</p>`;
}

function statusPill(status: string): string {
  const label = status === 'at_risk' ? 'at risk' : status;
  return `<span class="pill ${esc(status)}">${esc(label)}</span>`;
}

/* ------------------------------------------------------------------ ballot */

export function ballotPage(input: {
  view: PollView;
  roster: string[];
  csrf: string;
  action: string;
  hidden: Record<string, string>;
}): string {
  const { view } = input;
  const hidden = Object.entries(input.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');

  return layout(
    'Your ballot',
    `
<div class="card">
  <p class="kicker">Your ballot</p>
  <h1>${esc(view.question)}</h1>
  ${smallNBanner(view.voterCount)}
  <form method="post" action="${esc(input.action)}">
    ${hidden}
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    <ul class="choices">
${view.options
  .map(
    (option, i) => `      <li><label class="choice">
        <input type="radio" name="option_index" value="${i}"${i === 0 ? ' checked' : ''}>
        <span>${esc(option)}</span>
      </label></li>`,
  )
  .join('\n')}
    </ul>
    <button type="submit">Continue</button>
    <p class="hint">Nothing is cast yet. You will confirm on the next screen.</p>
  </form>
</div>
<div class="card">
  <p class="muted"><strong>Closes ${esc(formatUtc(view.closesAt))}.</strong> Results appear only when all ${
    view.voterCount
  } of you have voted. If anyone misses the deadline the poll fails and nobody sees anything.</p>
  ${retentionNote(view)}
  ${turnoutBlock(view)}
  ${verifyBlock(view, input.roster)}
</div>`,
  );
}

export function confirmPage(input: {
  view: PollView;
  optionIndex: number;
  csrf: string;
  action: string;
  hidden: Record<string, string>;
}): string {
  const chosen = input.view.options[input.optionIndex] ?? '';
  const hidden = Object.entries(input.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');
  return layout(
    'Confirm your vote',
    `
<div class="card">
  <p class="kicker">Confirm</p>
  <h1>${esc(input.view.question)}</h1>
  <p>You are about to vote for:</p>
  <p class="big">${esc(chosen)}</p>
  <p class="muted">This cannot be undone or changed, and it cannot be traced back to you afterwards — not by the creator, not by whoever runs the server.</p>
  <form method="post" action="${esc(input.action)}">
    ${hidden}
    <input type="hidden" name="option_index" value="${input.optionIndex}">
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    <div class="actions">
      <button type="submit">Cast my vote</button>
    </div>
  </form>
</div>`,
  );
}

export function votedPage(input: { view: PollView; completed: boolean }): string {
  const { view } = input;
  return layout(
    'Vote recorded',
    `
<div class="card">
  <p class="kicker">Done</p>
  <h1>Your vote is in.</h1>
  <p class="muted">It is now a number in a counter. There is no record anywhere linking it to you.</p>
  ${turnoutBlock(view)}
  ${
    input.completed
      ? `<p class="note good">That was the last ballot. <a href="/p/${esc(view.pollId)}">See the result</a>.</p>`
      : `<p class="muted">You will get an email when everyone has voted. <a href="/p/${esc(
          view.pollId,
        )}">Check turnout here</a> any time.</p>`
  }
</div>`,
  );
}

/* ------------------------------------------------------------------ status */

export function pollPage(view: PollView): string {
  if (view.status === 'completed' && view.results) return resultsPage(view);

  const body: Record<string, string> = {
    open: `<p class="muted">Voting is open until <strong>${esc(
      formatUtc(view.closesAt),
    )}</strong>. No results — not even a hint of one — until every ballot is in.</p>`,
    at_risk: `<p class="note warn">A ballot could not be recorded, so this poll can no longer complete cleanly. It will fail at its deadline and no numbers will ever be shown.</p>`,
    failed: `<p class="note bad"><strong>Failed — no consensus.</strong> The deadline passed with ballots missing. The counts have been deleted and are unrecoverable.</p>`,
    cancelled: `<p class="note bad"><strong>Cancelled.</strong> The creator cancelled this poll before it completed. Any votes cast were deleted without being counted.</p>`,
  };

  return layout(
    'Poll',
    `
<div class="card">
  <p class="kicker">${statusPill(view.status)}</p>
  <h1>${esc(view.question)}</h1>
  <h2>Options</h2>
  <ul class="roster">${view.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
  ${body[view.status] ?? ''}
  ${retentionNote(view)}
  ${turnoutBlock(view)}
  ${verifyBlock(view)}
</div>`,
  );
}

function resultsPage(view: PollView): string {
  const r = view.results!;
  if (r.integrity === 'INVALID') {
    return layout(
      'Result withheld',
      `
<div class="card">
  <p class="kicker">${statusPill('failed')}</p>
  <h1>${esc(view.question)}</h1>
  <p class="note bad"><strong>Integrity check: INVALID.</strong> ${esc(r.discrepancy ?? '')}</p>
  <p class="muted">Voto shows counts only when they are provably complete. They are withheld here rather than shown with a caveat.</p>
  ${retentionNote(view)}
  ${verifyBlock(view)}
</div>`,
    );
  }

  const max = Math.max(...r.counts, 1);
  const top = Math.max(...r.counts);
  const tied = r.counts.filter((c) => c === top).length > 1;

  return layout(
    'Result',
    `
<div class="card">
  <p class="kicker">${statusPill('completed')}</p>
  <h1>${esc(view.question)}</h1>
  ${smallNBanner(view.voterCount)}
  ${
    tied
      ? `<p class="note warn"><strong>It is a tie.</strong> Voto has no tiebreak — that is a conversation, not a calculation.</p>`
      : ''
  }
  <h2>Counts</h2>
${view.options
  .map((option, i) => {
    const count = r.counts[i] ?? 0;
    return `  <div style="margin-bottom:14px">
    <div style="display:flex;justify-content:space-between"><strong>${esc(
      option,
    )}</strong><strong>${count}</strong></div>
    <div class="rowbar"><span style="width:${Math.round((count / max) * 100)}%"></span></div>
  </div>`;
  })
  .join('\n')}
  <h2>Audit</h2>
  <table>
    <tr><th>Ballots counted</th><td>${r.totalBallots}</td></tr>
    <tr><th>Ballots consumed</th><td>${view.turnout}</td></tr>
    <tr><th>Roster size</th><td>${r.rosterSize}</td></tr>
    <tr><th>Integrity</th><td><strong>PASS</strong> — every invited voter cast exactly one ballot, and no extra ballot exists.</td></tr>
  </table>
  ${retentionNote(view)}
  ${verifyBlock(view)}
</div>`,
  );
}

/* ------------------------------------------------------------------ code entry */

export function codeEntryPage(input: {
  pollId: string;
  question: string;
  csrf: string;
  error?: string;
}): string {
  return layout(
    'Enter your code',
    `
<div class="card">
  <p class="kicker">Enter your code</p>
  <h1>${esc(input.question)}</h1>
  ${input.error ? `<p class="note bad">${esc(input.error)}</p>` : ''}
  <form method="post" action="/api/polls/${esc(input.pollId)}/verify-code">
    <div class="field">
      <label for="code">The code from your invite email</label>
      <input class="code-in" id="code" name="code" type="text" inputmode="latin" autocomplete="off"
             spellcheck="false" placeholder="XXXX-XXXX" maxlength="20" required>
      <p class="hint">Eight characters. Dashes and capitals don't matter.</p>
    </div>
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    <button type="submit">Open my ballot</button>
  </form>
</div>`,
  );
}

/* ------------------------------------------------------------------ creator */

export function signInPage(input: { sent?: boolean; error?: string }): string {
  return layout(
    'Sign in',
    `
<div class="card">
  <p class="kicker">Voto</p>
  <h1>Anonymous decisions for people who have to keep working together afterwards.</h1>
  <p class="muted">Sign in to create a poll. Only addresses on this server's creator allowlist can.</p>
  ${input.error ? `<p class="note bad">${esc(input.error)}</p>` : ''}
  ${
    input.sent
      ? `<p class="note good">If that address can create polls, a sign-in link is on its way. It is good for 15 minutes.</p>`
      : ''
  }
  <form method="post" action="/api/auth/request-link">
    <div class="field">
      <label for="email">Your email</label>
      <input id="email" name="email" type="email" autocomplete="email" required>
    </div>
    <button type="submit">Email me a sign-in link</button>
  </form>
</div>`,
  );
}

export function createFormPage(input: {
  creatorEmail: string;
  csrf: string;
  error?: string;
  polls: Poll[];
}): string {
  return layout(
    'New poll',
    `
<div class="card">
  <p class="kicker">Signed in as ${esc(input.creatorEmail)}</p>
  <h1>New poll</h1>
  ${input.error ? `<p class="note bad">${esc(input.error)}</p>` : ''}
  <form method="post" action="/api/polls">
    <div class="field">
      <label for="question">The decision</label>
      <input id="question" name="question" type="text" maxlength="280" required
             placeholder="Do we take the bridge round at a $12M cap?">
    </div>
    <div class="field">
      <label>Options</label>
      ${[0, 1, 2, 3, 4, 5]
        .map(
          (i) =>
            `<input style="margin-bottom:8px" name="options" type="text" maxlength="80" placeholder="${
              i < 2 ? `Option ${i + 1} (required)` : `Option ${i + 1} (optional)`
            }"${i < 2 ? ' required' : ''}>`,
        )
        .join('\n      ')}
      <p class="hint">Two to six. Fixed at creation — no write-ins, no edits, no comments.</p>
    </div>
    <div class="field">
      <label for="voters">Voters</label>
      <textarea id="voters" name="voters" required placeholder="priya@example.com, ravi@example.com, sam@example.com"></textarea>
      <p class="hint">${MIN_VOTERS}–${MAX_VOTERS} addresses, separated by commas, semicolons or newlines. Every one of them must vote or the poll fails.</p>
    </div>
    <div class="field">
      <label>How long voting stays open</label>
      <ul class="choices">
${ALLOWED_DURATION_DAYS.map(
  (days, i) => `        <li><label class="choice">
          <input type="radio" name="duration_days" value="${days}"${i === 0 ? ' checked' : ''}>
          <span>${days} days</span>
        </label></li>`,
).join('\n')}
      </ul>
      <p class="hint">Three standard durations, and nothing else. A custom deadline is a lever — "closes in 40 minutes" shapes who manages to vote at all.</p>
      <p class="hint"><strong>The poll and its result are deleted ${RETENTION_DAYS_AFTER_END} days after voting ends.</strong> Voto is not the record of what you decided — write that down somewhere else.</p>
    </div>
    <div class="field">
      <label><input type="checkbox" name="creator_votes" value="1"> I am voting too</label>
      <p class="hint">You are not a voter unless you tick this. It changes N.</p>
    </div>
    <div class="field">
      <label><input type="checkbox" name="allow_abstain" value="1"> Offer "Abstain" as an option</label>
      <p class="hint">An abstention counts as participation, so it keeps the poll alive. Without it, anyone who won't choose kills the poll.</p>
    </div>
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    <button type="submit">Create poll and send invites</button>
  </form>
</div>
${
  input.polls.length > 0
    ? `<div class="card">
  <h2 style="margin-top:0">Your polls</h2>
  <table>
    <tr><th>Question</th><th>Status</th><th>Closes</th></tr>
    ${input.polls
      .map(
        (p) => `<tr>
      <td><a href="/console/${esc(p.pollId)}">${esc(
        p.question.length > 46 ? `${p.question.slice(0, 45)}…` : p.question,
      )}</a></td>
      <td>${statusPill(p.status)}</td>
      <td class="muted">${esc(formatUtc(p.closesAt))}</td>
    </tr>`,
      )
      .join('\n    ')}
  </table>
</div>`
    : ''
}`,
  );
}

export function consolePollPage(input: {
  view: PollView;
  delivery: { email: string; status: DeliveryStatus }[];
  csrf: string;
  message?: string;
  error?: string;
}): string {
  const { view } = input;
  const bounced = input.delivery.filter((d) => d.status === 'bounced' || d.status === 'failed');
  const editable = view.status === 'open' && view.turnout === 0;

  return layout(
    'Poll admin',
    `
<div class="card">
  <p class="kicker">${statusPill(view.status)}</p>
  <h1>${esc(view.question)}</h1>
  ${input.message ? `<p class="note good">${esc(input.message)}</p>` : ''}
  ${input.error ? `<p class="note bad">${esc(input.error)}</p>` : ''}
  <p class="muted">Voter link: <a href="/p/${esc(view.pollId)}">/p/${esc(view.pollId)}</a></p>
  ${turnoutBlock(view)}
  <p class="note warn">You cannot see who has voted, and neither can anyone else. If someone is holding out, this tool will not tell you who — by design (US-5).</p>
  ${retentionNote(view)}
</div>

<div class="card">
  <h2 style="margin-top:0">Invite delivery</h2>
  ${
    bounced.length > 0
      ? `<p class="note bad">${bounced.length} invite${
          bounced.length === 1 ? '' : 's'
        } did not arrive. <strong>This poll cannot complete until that is fixed</strong> — every invited voter must vote.</p>`
      : ''
  }
  <table>
    <tr><th>Address</th><th>Delivery</th></tr>
    ${
      input.delivery.length > 0
        ? input.delivery
            .map((d) => `<tr><td>${esc(d.email)}</td><td>${esc(d.status)}</td></tr>`)
            .join('\n    ')
        : '<tr><td colspan="2" class="muted">Addresses have been purged — this poll is finished.</td></tr>'
    }
  </table>
  <p class="hint">Delivery state only. It says nothing about who has voted.</p>
</div>

${
  view.status === 'open' || view.status === 'at_risk'
    ? `<div class="card">
  <h2 style="margin-top:0">Actions</h2>
  <form method="post" action="/api/polls/${esc(view.pollId)}/resend" style="margin-bottom:20px">
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    <button class="secondary" type="submit">Resend invites to everyone</button>
    <p class="hint">Goes to the whole roster and reissues every ballot. There is no way to nudge one person — that would reveal who hasn't voted.</p>
  </form>

  ${
    editable
      ? `<form method="post" action="/api/polls/${esc(view.pollId)}/roster" style="margin-bottom:20px">
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    <div class="field">
      <label for="old_email">Fix a typo'd address</label>
      <input id="old_email" name="old_email" type="email" placeholder="wrong@example.com" required>
      <input style="margin-top:8px" name="new_email" type="email" placeholder="right@example.com" required>
      <p class="hint">Allowed only while nobody has voted. It changes the config fingerprint, so everyone is re-invited.</p>
    </div>
    <button class="secondary" type="submit">Replace address</button>
  </form>`
      : `<p class="muted">The roster is frozen: someone has already voted.</p>`
  }

  <form method="post" action="/api/polls/${esc(view.pollId)}/cancel">
    <input type="hidden" name="csrf" value="${esc(input.csrf)}">
    <button class="danger" type="submit">Cancel poll and destroy all votes</button>
    <p class="hint">Deletes the counters. You will not be shown the partial count — nobody is.</p>
  </form>
</div>`
    : ''
}`,
  );
}

/* ------------------------------------------------------------------ errors */

export function messagePage(input: {
  title: string;
  heading: string;
  body: string;
  tone?: 'warn' | 'bad' | 'good';
  link?: { href: string; label: string };
}): string {
  return layout(
    input.title,
    `
<div class="card">
  <h1>${esc(input.heading)}</h1>
  <p class="note ${input.tone ?? 'warn'}">${esc(input.body)}</p>
  ${input.link ? `<p><a href="${esc(input.link.href)}">${esc(input.link.label)}</a></p>` : ''}
</div>`,
  );
}
