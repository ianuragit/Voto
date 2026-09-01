#!/usr/bin/env node
/**
 * Checks the ZeptoMail configuration without sending a poll.
 *
 *   npm run check:email                 # config + credential check only
 *   npm run check:email you@domain.com  # also sends one real test email
 *
 * Run it from a Railway shell when invites are not arriving. It reports the
 * provider's own error codes, which name the problem far better than the
 * delivery status on the console does.
 *
 * It never prints the API key, and it prints a recipient only if you passed
 * one on the command line yourself.
 */

const SEND_PATH = '/v1.1/email';

const raw = process.env.ZEPTOMAIL_API_URL ?? 'https://api.zeptomail.com/v1.1/email';
const key = process.env.ZEPTOMAIL_API_KEY ?? '';
const from = process.env.ZEPTOMAIL_FROM_ADDRESS ?? '';
const fromName = process.env.ZEPTOMAIL_FROM_NAME ?? 'Voto';
const to = process.argv[2];

function normalize(value) {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '' ? SEND_PATH : path}`;
}

let endpoint;
try {
  endpoint = normalize(raw);
} catch {
  console.error(`✗ ZEPTOMAIL_API_URL is not a URL: ${raw}`);
  process.exit(1);
}

console.log(`ZEPTOMAIL_API_URL   ${raw}`);
if (endpoint !== raw) console.log(`  -> normalized to   ${endpoint}`);
console.log(`ZEPTOMAIL_API_KEY   ${key ? `set (${key.length} chars)` : 'MISSING — Voto runs in dry-run and sends nothing'}`);
console.log(`FROM                ${from || 'MISSING'}`);

if (!key || !from) {
  console.error('\n✗ Set ZEPTOMAIL_API_KEY and ZEPTOMAIL_FROM_ADDRESS, then run this again.');
  process.exit(1);
}

// With no recipient we still exercise auth and the endpoint: the provider
// validates the credential before it validates the payload.
const recipient = to ?? 'probe@example.invalid';
const res = await fetch(endpoint, {
  method: 'POST',
  headers: {
    Authorization: `Zoho-enczapikey ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  body: JSON.stringify({
    from: { address: from, name: fromName },
    to: [{ email_address: { address: recipient } }],
    subject: 'Voto configuration check',
    textbody: 'If you are reading this, Voto can send mail.',
    track_clicks: false,
    track_opens: false,
  }),
});

const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = null;
}

console.log(`\nHTTP ${res.status}`);

if (res.ok) {
  console.log(to ? `✓ Sent. Check ${to} — including its spam folder.` : '✓ Endpoint and credential are good.');
  process.exit(0);
}

const err = parsed?.error ?? {};
const subCodes = Array.isArray(err.details)
  ? err.details.map((d) => d?.code).filter(Boolean).join(', ')
  : '';
console.log(`✗ ${err.code ?? '(no code)'} ${err.message ?? ''}${subCodes ? ` [${subCodes}]` : ''}`);

const hint = {
  404: 'The URL has no path. Set ZEPTOMAIL_API_URL to the full endpoint, ending in /v1.1/email.',
  403: 'The path is wrong — often a trailing slash. It must end in /v1.1/email with no slash after it.',
  401: 'The API key is wrong. Use a Mail Agent "Send Mail" token, sent as Zoho-enczapikey.',
  400: 'The payload or the from-address was rejected. The from-address must be on a verified domain.',
}[res.status];
if (hint) console.log(`\n→ ${hint}`);
if (!to) console.log('\nPass an address to send a real test: npm run check:email you@yourdomain.com');
process.exit(1);
