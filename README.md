# Voto

Anonymous, all-or-nothing decision polling for founding teams. *(Codename: Quorum.)*

Voto lets a small group make a binding decision where **how each person voted is never
recoverable**, but **whether everyone participated is fully visible**. Options are fixed at
creation. Every invited voter must vote. If anyone doesn't, the poll fails and nobody learns
anything — not the creator, not the person who runs the server.

---

## Contents

- [What it guarantees, and what it can't](#what-it-guarantees-and-what-it-cant)
- [How the anonymity works](#how-the-anonymity-works)
- [Deploying to Railway — step by step](#deploying-to-railway--step-by-step)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Verifying the privacy guarantee](#verifying-the-privacy-guarantee)
- [Using it](#using-it)
- [API](#api)
- [Operational notes](#operational-notes)
- [Decisions made from the PRD's open questions](#decisions-made-from-the-prds-open-questions)

---

## What it guarantees, and what it can't

**Guaranteed**

- No party — including an operator with full filesystem access — can link a vote to a voter.
  There is no join key between the two databases, and the tally store holds counters, not rows.
- Exactly one vote per invited voter. Single-use tokens, hashed at rest, consumed by a
  conditional `UPDATE`.
- Turnout is a count, never a roster. There is no API, page, or query in this codebase that
  returns who has voted.
- Fail closed. Partial results are never rendered, and a failed poll's counts are deleted.
- When the last ballot lands, every voter is emailed the final counts and the total ballot count
  — or, if the count does not reconcile, told that and given no numbers.
- Nothing outlives its purpose. Voting runs for a standard 3, 5 or 7 days, and 7 days after a
  poll ends the poll and everything it produced are deleted outright.

**Not guaranteed — read this before a contentious vote**

- **Small groups leak by arithmetic.** With 3 voters, a unanimous result tells everyone how
  everyone voted. With 2 voters a split result is fully deanonymizing, which is why Voto
  refuses to create a 2-person poll at all. The app shows this warning on every ballot and
  result page rather than implying a guarantee the maths can't back.
- **A live operator watching the volume.** Someone with shell access on the running production
  container, polling both SQLite files every second, could correlate a token flipping to
  consumed with a counter incrementing. Voto removes every stored correlate — no timestamps,
  no insertion order, no per-vote rows — but it cannot defeat an observer watching in real
  time. Restrict production shell access accordingly.
- **Railway's edge logs.** The platform logs request paths and source IPs outside our control.
  Because the vote is a `POST` to a shared path with the option in the body, those logs reveal
  *that* an IP voted, never *what* they voted. Documented, not solved.
- **This is not end-to-end verifiable voting.** No voter receipts, no homomorphic tallying.
  You are trusting this code to do what it says; you are not trusting the creator, which is the
  problem it was built for.

---

## How the anonymity works

```
                    ┌──────────────────────────────┐
   invite email ──▶ │  AUTH STORE   auth.sqlite    │
                    │  polls, ballot_tokens        │
                    │  knows: WHO was invited      │
                    │         WHETHER they voted   │
                    │  never:  WHAT they voted     │
                    └──────────────┬───────────────┘
                                   │
                    token consumed (txn A, atomic)
                                   │
                          ── air gap ──
                    no shared identifier crosses here
                                   │
                    counter incremented (txn B)
                                   │
                    ┌──────────────▼───────────────┐
                    │  TALLY STORE  tally.sqlite   │
                    │  tallies (poll_id, opt, n)   │
                    │  knows: HOW MANY chose each  │
                    │  never:  WHO, WHEN, IN WHAT  │
                    │          ORDER               │
                    └──────────────────────────────┘
```

Two SQLite files, two connections, two repository modules. **No module may import both
connections** — `npm run check:airgap` fails the build if one ever does, so a `JOIN` across the
boundary is not expressible in this codebase.

Five things deliberately not stored:

1. **No per-vote row.** Counter rows are pre-seeded at zero when the poll is created, so voting
   performs an `UPDATE` and never an `INSERT`. There is no insertion order to correlate against.
   This single decision removes the largest real-world deanonymization vector.
2. **No consumption timestamp.** A boolean. Turnout is `COUNT(*) WHERE consumed = 1`.
3. **No timestamp on tallies.**
4. **No IP addresses** — not in the database, not in application logs. Rate-limit state lives in
   memory, keyed by an HMAC of the address, with a 15-minute TTL.
5. **No raw tokens.** Only `SHA-256(token)`. A leaked auth database cannot be used to vote.

The vote path's ordering is the whole guarantee: **consume the token first, increment the
counter second.** A crash between the two loses a ballot and the poll fails at its deadline with
results suppressed. The reverse ordering would risk a silent double count, which is worse.

Every invite email carries the full voter roster and a **config fingerprint** —
`SHA-256(question ‖ options ‖ sorted emails ‖ closes_at)`. Any voter can compare theirs against
anyone else's. A creator who quietly adds a sock-puppet address is visible to everyone. This
turns "trust the creator" into "verify the creator."

---

## Deploying to Railway — step by step

Voto runs as **one service, one volume, exactly one replica**. The single replica is
non-negotiable: SQLite has one writer, and both stores live on a local volume.

### Step 0 — Before you touch Railway: set up the sending domain

Do this first. It takes the longest and everything else is blocked on it. **Without SPF, DKIM
and DMARC, the invite emails land in spam and the poll silently fails**, because a poll needs
100% turnout to produce any result at all.

1. Create a ZeptoMail account and add your sending domain (e.g. `yourdomain.com`).
2. Add the SPF, DKIM and DMARC DNS records ZeptoMail gives you, and wait for verification.
3. Create a **Mail Agent**, then generate a **Send Mail token** for it. Copy it — it is shown once.
4. In the Mail Agent's settings, **turn off click tracking and open tracking.** This matters:
   a tracked link creates a server-side record tying a person to the moment they opened their
   ballot, which is exactly what the privacy architecture exists to prevent. Voto also sends
   `track_clicks: false` and `track_opens: false` on every request, but the account setting is
   the one that binds.
5. Send yourself a test email from the ZeptoMail console and confirm it reaches the inbox, not
   spam.

### Step 1 — Create the project and service

**Using the dashboard**

1. Push this repository to GitHub.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Pick this repository. Railway detects Node via Nixpacks and reads `railway.json` for the
   build and start commands, the health check, and `numReplicas: 1`.
4. The first build will fail or start unconfigured — that is expected. Finish steps 2–4 first.

**Using the CLI**

```bash
npm i -g @railway/cli
railway login
railway init                 # creates the project
railway up                   # deploys the current directory
```

### Step 2 — Attach the volume (do this before the first real deploy)

1. In the service, open the **Variables / Settings** area and choose **+ Volume** (or
   right-click the service canvas → **Attach Volume**).
2. Set the **mount path** to exactly:

   ```
   /data
   ```

3. Size: 1 GB is far more than enough. A poll is a few kilobytes.

`auth.sqlite`, `tally.sqlite` and their WAL/SHM files all live here. **If you skip this step the
databases live on ephemeral container storage and every redeploy destroys every poll.**

### Step 3 — Set the environment variables

Service → **Variables** → **Raw Editor**, and paste the block below with your own values. See
[Environment variables](#environment-variables) for what each one does.

```bash
NODE_ENV=production
DATA_DIR=/data
PUBLIC_BASE_URL=https://voto.up.railway.app
SESSION_SECRET=<paste output of: openssl rand -base64 48>
ALLOWED_CREATORS=ravi@yourdomain.com,priya@yourdomain.com

ZEPTOMAIL_API_URL=https://api.zeptomail.com/v1.1/email
ZEPTOMAIL_API_KEY=<your ZeptoMail Send Mail token>
ZEPTOMAIL_FROM_ADDRESS=voto@yourdomain.com
ZEPTOMAIL_FROM_NAME=Voto
ZEPTOMAIL_BOUNCE_ADDRESS=bounces@yourdomain.com
ZEPTOMAIL_WEBHOOK_SECRET=<any long random string you also paste into ZeptoMail>
```

Notes:

- Do **not** set `PORT`. Railway injects it, and Voto reads it.
- `DATA_DIR` must match the volume mount path from step 2 exactly.
- `PUBLIC_BASE_URL` must match the final public domain **exactly**, including `https://` and no
  trailing slash. It is what the magic links in the invite emails are built from. Set it after
  step 4 if you are using a custom domain, then redeploy.
- The service refuses to boot in production if `SESSION_SECRET` is unset or `ALLOWED_CREATORS`
  is empty. That is deliberate — an open creator console would let anyone convene a binding vote.

### Step 4 — Generate the public domain

1. Service → **Settings** → **Networking** → **Generate Domain**, or add your own custom domain
   and point the CNAME as instructed.
2. Copy the resulting URL into `PUBLIC_BASE_URL` (step 3) and redeploy.

### Step 5 — Pin the replica count to 1

`railway.json` already declares `"numReplicas": 1`, and Railway honours it. Confirm it anyway,
because a second replica means two processes writing two independent copies of the databases:

- Service → **Settings** → **Deploy** → confirm **Replicas = 1**.
- Leave autoscaling off.

Also set **Settings → Deploy → Serverless / App Sleeping to OFF**. A sleeping service does not
run the 60-second deadline sweeper. Deadlines are also evaluated lazily on every read, so a
sleeping service still cannot show a stale result — but a poll would not fail (and its counts
would not be deleted) until someone next loads the page.

### Step 6 — Deploy and check health

The Node version comes from `.nvmrc` and `package.json` `engines.node`, both pinned to 20. Leave
them alone unless you have read the Node-version note under
[Operational notes](#operational-notes) — a newer Node breaks the build at `npm ci`, because
`better-sqlite3` has no prebuilt binary for it and the build image has no Python. If you ever
need to override the version from Railway rather than the repo, set `NIXPACKS_NODE_VERSION=20`
as a service variable; Nixpacks gives it precedence over both files.

Trigger a deploy (push to the branch, or `railway up`). When it is live:

```bash
curl https://<your-domain>/healthz
# {"ok":true}
```

Railway's health check hits the same path and will not promote a deploy that fails it.

### Step 7 — Point the bounce webhook at the service

1. In ZeptoMail: **Mail Agent → Webhooks → Add webhook**.
2. URL: `https://<your-domain>/webhooks/zeptomail`
3. Subscribe to bounce, soft-bounce and spam/complaint events.
4. Set the signing secret to the same value you put in `ZEPTOMAIL_WEBHOOK_SECRET`. If ZeptoMail
   sends its signature under a header other than `x-zoho-signature`, set
   `ZEPTOMAIL_WEBHOOK_SIGNATURE_HEADER` to match.

Unsigned callbacks are rejected with a 401. A bounced address raises a creator-visible warning
saying the poll cannot complete until it is fixed — which is true, since every invited voter
must vote.

### Step 8 — Run one real poll end to end before you trust it

Create a throwaway 3-person poll among addresses you control, vote from all three, and confirm:
the invites arrive in inboxes, the two-tap flow works on a phone, and the results page shows
`Integrity: PASS` with ballots counted equal to roster size.

### Step 9 — Back it up

Railway volume backups: **Service → Volume → Backups**. Schedule a nightly snapshot.

Snapshot both files in a single operation — two snapshots taken at different instants could in
principle be diffed against each other to correlate a consumed token with an incremented
counter. Restrict snapshot access to the same trust boundary as production.

### Upgrading later

Push to the branch. Railway rebuilds and restarts the single replica. The volume, and every
poll on it, survives. In-flight polls are unaffected: nothing is held in memory except rate-limit
counters, and a restart re-sweeps deadlines at boot.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | yes in prod | `development` | `production` enables secure cookies, HSTS, and `warn`-level logging |
| `PORT` | no | `3000` | Injected by Railway; don't set it manually |
| `HOST` | no | `0.0.0.0` | Bind address |
| `PUBLIC_BASE_URL` | **yes** | `http://localhost:3000` | Origin used to build magic links. Must match the deployed domain exactly |
| `DATA_DIR` | **yes** | `./data` | Directory holding both SQLite files. `/data` on Railway |
| `SESSION_SECRET` | **yes** | — | HMAC key for creator sessions, sign-in links, CSRF, and rate-limit keying. Boot fails in production without it |
| `ALLOWED_CREATORS` | **yes** | — | Comma-separated addresses allowed to create polls. Boot fails in production if empty |
| `ZEPTOMAIL_API_URL` | no | `https://api.zeptomail.com/v1.1/email` | Use `api.zeptomail.in` for India-region accounts |
| `ZEPTOMAIL_API_KEY` | **yes** | — | Send Mail token. Without it, Voto runs in dry-run and prints subjects instead of sending |
| `ZEPTOMAIL_FROM_ADDRESS` | **yes** | — | Must be on the verified sending domain |
| `ZEPTOMAIL_FROM_NAME` | no | `Voto` | Display name |
| `ZEPTOMAIL_BOUNCE_ADDRESS` | no | — | Return path for bounces |
| `ZEPTOMAIL_WEBHOOK_SECRET` | recommended | — | HMAC secret for bounce callbacks. Unsigned callbacks are rejected |
| `ZEPTOMAIL_WEBHOOK_SIGNATURE_HEADER` | no | `x-zoho-signature` | Header carrying the callback signature |
| `EMAIL_DRY_RUN` | no | `false` | Print emails instead of sending them |
| `LOG_LEVEL` | no | `warn` in prod | `fatal`…`trace`, or `silent` |

---

## Local development

```bash
npm install
cp .env.example .env          # then edit SESSION_SECRET and ALLOWED_CREATORS
npm run dev                   # http://localhost:3000
```

With no `ZEPTOMAIL_API_KEY`, Voto runs in dry-run: emails are printed as subject lines rather
than sent. The magic link and code are in the printed body during development only — set
`LOG_LEVEL=info` and read the console, or point the app at a real ZeptoMail sandbox.

```bash
npm run verify      # air-gap check + typecheck + tests. Run before pushing.
npm run build       # compile to dist/
npm start           # run the compiled build
```

---

## Verifying the privacy guarantee

The privacy claims are tested, not asserted. `npm run verify` runs all of it; each item below is
an acceptance criterion from the PRD's Appendix A and has a corresponding test:

| Criterion | Where |
|---|---|
| `tally.sqlite` has no column but `poll_id`, `option_index`, `count` | `tests/privacy.test.ts`, plus `scripts/check-air-gap.mjs` (build-time) |
| No module imports both database connections | `scripts/check-air-gap.mjs`, run in CI |
| A mid-poll dump of both files cannot attribute a vote | `tests/privacy.test.ts` |
| Logs from a complete poll contain no token, email, code or option | `tests/privacy.test.ts` |
| 50 `GET`s on a magic link leave `consumed = 0` | `tests/privacy.test.ts` |
| A poll expiring at 4/5 leaves zero tally rows | `tests/privacy.test.ts` |
| A crash between consume and tally yields `INVALID`, results withheld | `tests/privacy.test.ts` |
| The results page renders `total_ballots == roster_size` | `tests/privacy.test.ts`, `tests/http.test.ts` |
| A poll and its results are gone 7 days after it ends, by sweeper and by lazy read | `tests/privacy.test.ts`, `tests/http.test.ts` |
| Every voter is emailed the counts and total ballot count, exactly once, on completion | `tests/privacy.test.ts` |
| An INVALID integrity verdict withholds the numbers from the email too | `tests/privacy.test.ts` |
| Only 3, 5 and 7 day durations are accepted, and `closes_at` is derived from them | `tests/privacy.test.ts` |

To audit a live deployment yourself:

```bash
# In a Railway shell on the running service:
sqlite3 /data/tally.sqlite '.schema tallies'
# -> poll_id, option_index, count. Nothing else. No timestamps, no rowid.

sqlite3 /data/auth.sqlite  '.schema ballot_tokens'
# -> token_hash, poll_id, code_hash, email, consumed, delivery_status.
#    No consumed_at. No ip. No user_agent.
```

---

## Using it

**Creating a poll.** Sign in at `/` with an address on `ALLOWED_CREATORS` — you get a magic link,
there is no password. Enter the question, 2–6 fixed options, the voter addresses, and a closing
voting window of **3, 5 or 7 days** — those are the only durations, because a custom deadline is
a lever ("closes in 40 minutes" shapes who manages to vote at all). You are not a voter unless
you tick "I am voting too."
Invites go out immediately.

You will not be able to see who has voted. That is the point: it means nobody can lean on a
specific holdout, and your view is no better than any voter's.

**Voting.** Each voter gets an email with a one-tap link and a typeable code — either works, both
lead to the same single ballot. Opening the link renders the ballot and casts nothing, so a
corporate mail scanner pre-fetching the URL doesn't burn anyone's vote. Choosing an option leads
to a confirmation screen; the vote is cast on the second, explicit tap.

**Results.** Nothing but turnout (`k of N`) is visible while the poll is open — there is no code
path that reads the tallies before completion, so early results cannot influence late voters.
The moment the last ballot lands, every voter is emailed the final counts, the total ballot count
and the integrity verdict, and the same appears on the poll page. If the count fails its
integrity check the email withholds the numbers exactly as the page does. If the deadline passes
with anyone missing, the poll fails, the counts are deleted, and nobody ever sees them.

Note the trade this makes: the result email is permanent and forwardable, and it outlives the
7-day deletion below. On a small roster a unanimous result is a lasting record of how each named
person voted — the email says so when that happens.

**Fixing a typo'd address.** Allowed only while nobody has voted. It changes the config
fingerprint, so every voter is re-invited with the new one. Once a single vote exists, the
electorate is frozen.

**Nudging someone.** You can resend invites, but only to everyone. A targeted resend would
reveal who hasn't voted, so it isn't available.

---

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Creator | Sign-in, or the create-poll form |
| `POST` | `/api/polls` | Creator | Create poll, mint tokens, send invites → `201 { poll_id, config_hash }` |
| `GET` | `/p/:poll_id` | None | Public status: question, options, turnout, status, fingerprint. Results only if completed |
| `GET` | `/v/:token` | Token | **Read-only** ballot render. Validates, never consumes. Issues CSRF |
| `GET` | `/c/:poll_id` | None | Manual code entry form |
| `POST` | `/api/polls/:poll_id/verify-code` | Code | Exchange a code for a ballot render. Rate limited. Does not consume |
| `POST` | `/api/polls/:poll_id/confirm` | Token/code + CSRF | Renders the confirmation step. Consumes nothing |
| `POST` | `/api/polls/:poll_id/vote` | Token/code + CSRF | **Consume + tally.** `200 { turnout, total }`, `409` reused, `410` closed, `404` unknown |
| `GET` | `/api/polls/:poll_id/results` | None | `403` until completed → `{ counts[], total_ballots, roster_size, integrity, config_hash }` |
| `GET` | `/api/polls/:poll_id/turnout` | None | `{ turnout, total, status }` — a count, never a roster |
| `POST` | `/api/polls/:poll_id/resend` | Creator | Re-send to everyone. Never targeted |
| `POST`/`PATCH` | `/api/polls/:poll_id/roster` | Creator | Replace one address. `409` if any vote exists |
| `POST` | `/api/polls/:poll_id/cancel` | Creator | Cancel and destroy all tallies |
| `POST` | `/webhooks/zeptomail` | HMAC | Bounce and delivery status |
| `GET` | `/healthz` | None | Liveness |

Ballot and results pages are served with `Cache-Control: no-store`, `Referrer-Policy:
no-referrer` (without which a link would leak the magic-link URL in a `Referer` header),
`X-Robots-Tag: noindex, nofollow`, and a CSP of `script-src 'none'`. There is no JavaScript
anywhere in this application and no analytics of any kind.

---

## Operational notes

**Failure modes and what they do**

| Scenario | Behaviour |
|---|---|
| Deadline passes below 100% turnout | Status → `failed`, tallies deleted, turnout shown, counts never |
| Process dies between completing a poll and mailing the result | The next sweep (or boot) sends it; delivery is claimed atomically so it is sent exactly once |
| Email bounces | `delivery_status = 'bounced'`, creator warned that the poll cannot complete |
| Voter clicks their link twice | Second render is harmless; a second vote is a `409` |
| Mail scanner pre-fetches the link | Nothing consumed — `GET` never mutates |
| Crash between consume and tally | Ballot lost, poll `at_risk`, fails at deadline, results suppressed |
| `SUM(tallies) != consumed_count` | Integrity `INVALID`, results suppressed entirely |
| Volume locked | `503`, no partial write (5s busy timeout) |
| Two voters submit at once | Both succeed; both writes are atomic single statements |
| 100% turnout before the deadline | Completes immediately; nobody waits |

**Retention**

| Data | Kept until |
|---|---|
| Roster addresses | Poll completion, failure or cancellation — purged once the result email has gone out |
| **Everything else about a poll** | **7 days after the poll ends — then the poll, its ballots and its counts are deleted outright and the URL 404s** |
| Tallies of a failed or cancelled poll | Deleted at the moment of failure, not 7 days later |
| Rate-limit state | In memory, 15-minute TTL, never persisted |

**Voto is not your system of record.** Seven days after a poll ends — completed, failed or
cancelled alike — the question, the options, the roster, the token hashes, the turnout and the
counts are all deleted, and `/p/:poll_id` returns 404. Write the decision down somewhere else.
Every voter is told the exact deletion date on the ballot, on the results page, and in both the
invite and the results email.

Deletion is enforced twice, like the deadline: by the 60-second sweeper, and lazily on every
read, so a poll can never be served past its window even if the sweeper never runs.

**Stack.** Node 20 (pinned), TypeScript, Fastify, `better-sqlite3`, Zod, server-rendered HTML. No
client framework, no build step for the frontend, no JavaScript shipped to the browser.

**The Node version is pinned on purpose — don't bump it casually.** `better-sqlite3` is a native
module, and it only installs cleanly on a Node release it publishes a prebuilt binary for. On
anything newer, npm falls back to compiling from source with `node-gyp`, which needs Python and a
C toolchain that the Railway build image does not have — so the deploy fails at `npm ci` with
`Could not find any Python installation to use`.

The version lives in **`.nvmrc`**, and everything reads from there:

- `package.json` `engines.node` (`20.x`) is what Nixpacks resolves for the Railway build.
- CI uses `node-version-file: .nvmrc`, so CI and Railway can never disagree about the runtime.
  They did once, and the result was a green CI badge on a deploy that could not build.

To move to a newer Node, first check that a prebuilt binary exists for that ABI, upgrading
`better-sqlite3` if needed:

```bash
# Node 20 = ABI 115, Node 22 = 127, Node 24 = 137
curl -sLo /dev/null -w '%{http_code}\n' \
  https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better_sqlite3-v11.10.0-node-v137-linux-x64.tar.gz
```

`200` means it is safe to bump; `404` means the deploy will fail. Then update `.nvmrc` and
`engines.node` together, and confirm a clean install needs no compiler:

```bash
rm -rf node_modules && npm_config_python=/nonexistent npm ci   # must succeed
```

**Scaling.** It doesn't, and shouldn't. One replica, 3–25 voters per poll. If you need more than
that, you need a different threat model, not a bigger server.

---

## Decisions made from the PRD's open questions

The PRD left ten questions open (§12). This build takes a position on each; every one is a
one-line change if you disagree. Rationale is in [`DECISIONS.md`](DECISIONS.md).

| # | Question | Decision |
|---|---|---|
| 1 | Creator auth | Env-var allowlist + magic-link console session |
| 2 | Is the creator always a voter? | No — opt-in checkbox |
| 3 | Manual code format | 8-character Crockford base32, shown as `XXXX-XXXX` |
| 4 | Minimum N | Refuse 2-person polls outright, with a standing small-N banner |
| 5 | Failed-poll re-run | Manual re-creation only |
| 6 | Completion notification | Email everyone the final counts and total ballot count |
| 7 | Abstention | Opt-in "Abstain" option that counts as participation |
| 8 | Ties | Counts are shown with a plain "it's a tie" note and no tiebreak |
| 9 | Retention of completed polls | Deleted 7 days after the poll ends |
| 10 | Results access | Anyone with the `poll_id` URL (a 122-bit UUID) |

---

## Licence

Private and internal. Not intended for public or external-facing polls.
