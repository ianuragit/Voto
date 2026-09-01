# Decisions taken on the PRD's open questions

The PRD (§12) left ten decisions to be made before build. Rather than block, this build takes a
position on each and documents it here. Every one of them is a small, localised change if you
want it the other way — the file to edit is named in each entry.

---

### Q1 — Creator authentication

**Decision: `ALLOWED_CREATORS` env-var allowlist plus magic-link console sign-in.** (The PRD's
own proposal.)

A shared admin passphrase has no revocation story and no attribution — you can't remove one
cofounder's access without rotating everyone's, and the audit trail says only "someone with the
passphrase." The allowlist costs one env var and makes revocation a variable edit. The
allowlist is re-checked on every request, so removing an address invalidates that person's
existing session immediately.

Sign-in responses are identical whether or not the address is on the list, so the endpoint is
not an allowlist oracle. *(`src/web/session.ts`, `src/web/routes/creator.ts`)*

### Q2 — Is the creator always a voter?

**Decision: no. Opt-in checkbox, unticked by default.** (The PRD's proposal.)

A creator who is not voting is a genuine case — someone convening a decision they're recused
from. Auto-enrolling them would silently change N, which changes what "everyone voted" means.
The form rejects a roster containing the creator's own address unless the box is ticked, so the
two can't disagree. *(`src/services/pollService.ts`)*

### Q3 — Manual code format

**Decision: 8 characters of Crockford base32, displayed `XXXX-XXXX`.** Not 6 digits.

The brief specified 6 digits. With a 5-voter poll that leaves ~5 valid values in 10⁶ — about
2×10⁵ guesses per hit, which is hours of scripted attempts, and the mitigation is aggressive
lockout that a legitimate voter will eventually trip. 8 Crockford characters is ~10¹² and no
harder to type. Crockford's alphabet drops I, L, O and U, and the parser folds `I`/`L` → `1` and
`O` → `0`, so the common misreadings are accepted rather than rejected.

Codes are stored as `SHA-256(poll_id ‖ code)`, and code entry is still rate limited: 5 failures
per poll per client per hour on top of the per-IP limit. *(`src/domain/crypto.ts`,
`src/web/rateLimit.ts`)*

If you must have 6 digits, the PRD's fallback applies: entry additionally requires the voter's
email address, which weakens the anonymity story, since the entry endpoint then sees an address.

### Q4 — Minimum N = 3

**Decision: refuse 2-person polls outright. No acknowledgement override.**

An "I understand this isn't anonymous" checkbox produces a tool that promises anonymity in its
name and withdraws it in a checkbox nobody reads. For a 2-person decision the honest answer is
that the tool cannot help, and the error message says so and suggests talking.

For N ≥ 3, a standing banner appears on the ballot, confirmation and results pages: *"With N
voters, a unanimous result reveals everyone's vote."* That is stated as arithmetic, not as a
limitation to be fixed. *(`src/domain/validation.ts`, `src/web/views/pages.ts`)*

### Q5 — Failed-poll re-run

**Decision: manual re-creation. No one-click re-run.**

This is the governance question the PRD flagged, not a UX one. One-click re-run makes it
frictionless to re-poll until you get the answer you want, and the second run's result is not
comparable to the first — the electorate now knows a poll failed. Re-creating by hand takes
thirty seconds and forces the creator to restate the question, which is the right amount of
friction. *(Nothing to implement; the absence is the decision.)*

### Q6 — Notification on completion

**Decision: email every voter a link. Never the numbers.** (The PRD's proposal.)

Returning to the app is worse UX than an email, and worse UX means people don't see the outcome.
But putting counts in an email puts the decision record in inboxes, forwarded threads and mail
provider indexes forever, where it can be quoted out of context and can't be revoked. A link
keeps the numbers on a page with `no-store` and `noindex`. Failure and cancellation notices work
the same way. *(`src/email/templates.ts`)*

### Q7 — Abstention

**Decision: an opt-in "Abstain" option the creator can add at creation.**

The PRD called this "a genuine gap," and it is: without it, abstaining is indistinguishable from
not voting, so the only way to decline is to kill everyone's poll. Making abstention an explicit
option means it counts as participation — the poll completes — and the abstention is visible in
the result, which is honest.

It is opt-in rather than automatic because on some decisions "everyone must actually choose" is
the point, and an always-present escape hatch would undermine that. When enabled, `Abstain` is
appended after the creator's own options, so it never displaces one of the 2–6.
*(`src/domain/validation.ts`, `src/services/pollService.ts`)*

### Q8 — Result ties

**Decision: show the counts, name the tie, offer no tiebreak.**

With fixed options and small N, ties are common. The results page says "It is a tie" and adds
that Voto has no tiebreak — that's a conversation, not a calculation. Anything more (runoff,
casting vote, creator decides) is a governance mechanism that would need to be agreed before the
vote, not invented by the tool afterwards. *(`src/web/views/pages.ts`)*

### Q9 — Retention of completed polls

**Decision: everything is deleted 7 days after the poll ends.**

Not indefinite. Seven days after a poll leaves `open` — completed, failed or cancelled alike —
the poll row, its ballot tokens and its tally rows are all deleted, and `/p/:poll_id` returns
404. Roster addresses still go earlier, at completion.

The trade-off is real and worth stating plainly: **Voto stops being the record of what was
decided.** A cofounder who wants to point at last month's vote will find a 404. That is
acceptable only because the alternative — an indefinitely retained tally on a small-N poll — is
itself a disclosure risk: with 3 voters and a unanimous result, that row is a permanent record
of how three named people voted, sitting on a volume, in every backup snapshot, forever. A
7-day window means the tool holds that exposure for a week rather than for years.

So the app says so, loudly and in four places: the create form, the ballot page, the results
page, and both the invite and results emails, the last three naming the exact deletion date.
A retention rule nobody is told about is a data-loss bug the first time it fires. Write the
decision down somewhere that is meant to hold records.

Deletion is enforced twice, like the voting deadline: by the 60-second sweeper, and lazily on
every read, so a poll is never served past its window even if the sweeper has not run.
*(`src/services/lifecycle.ts`, `RETENTION_DAYS_AFTER_END` in `src/domain/validation.ts`)*

### Voting duration — standard 3, 5 or 7 days

**Decision: three fixed durations. No arbitrary closing time.**

The PRD's FR-1.5 allowed anything from 15 minutes to 14 days. Fixed durations are better on two
counts. A deadline is a lever — "closes in 40 minutes" is a way to shape who manages to vote at
all, and in a tool whose entire purpose is to stop the convener putting a thumb on the scale,
that lever should not exist. And a standard duration is legible: every voter knows what "3 days"
means without doing arithmetic against a timestamp in someone else's timezone.

`closes_at` is derived from the chosen duration at creation and is still stored UTC and still
part of the config fingerprint, so the deadline remains something voters can verify against each
other. There is no code path that accepts a caller-supplied closing time.
*(`resolveDeadline` in `src/domain/validation.ts`)*

### Q10 — Read access to results

**Decision: anyone holding the `poll_id` URL. No token required.**

`poll_id` is a UUIDv4 — 122 bits of entropy, unguessable, and never indexed (`X-Robots-Tag:
noindex`, CSP, `no-store`). Requiring a ballot token to view results would mean voters lose
access to the decision once their tokens are purged, and would make it impossible to share the
outcome with anyone outside the roster — including the person who has to act on it. The page
exposes counts, roster size and the config fingerprint; it never exposes the roster itself once
addresses are purged, and never exposes who voted at any point.

---

## One deviation from the PRD's schema, and why

`polls` carries three columns beyond the PRD's table: `finalized_at`, `final_ballot_count` and
`emails_purged`.

`finalized_at` is what the 7-day retention clock runs on — it records when the poll ended, not
when any person acted. `final_ballot_count` freezes the turnout at finalisation so the FR-4.5
integrity verdict does not depend on re-counting rows. `emails_purged` makes FR-4.7's purge
idempotent across repeated result renders.

All three are poll-level aggregates. None records when an individual acted, and none is a join
key. `tally.sqlite` is unchanged from the PRD: three columns, `WITHOUT ROWID`, and
`scripts/check-air-gap.mjs` fails the build if that ever stops being true.
