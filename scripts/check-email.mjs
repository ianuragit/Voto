#!/usr/bin/env node
/**
 * Checks the SMTP configuration without running a poll.
 *
 *   npm run check:email                 # connect + authenticate only
 *   npm run check:email you@domain.com  # also sends one real test email
 *
 * Run it from a Railway shell when invites are not arriving. It reports the
 * SMTP reply code, which names the problem far better than a delivery status
 * on the console does.
 *
 * It never prints the password, and it prints a recipient only if you passed
 * one on the command line yourself.
 */
import nodemailer from 'nodemailer';

const host = (process.env.SMTP_HOST ?? '')
  .trim()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  .replace(/\/.*$/, '')
  .replace(/:\d+$/, '')
  .toLowerCase();
const port = Number(process.env.SMTP_PORT ?? 587);
const secureRaw = process.env.SMTP_SECURE;
const secure = secureRaw ? /^(1|true|yes|on)$/i.test(secureRaw) : port === 465;
const user = process.env.SMTP_USER ?? '';
const pass = process.env.SMTP_PASSWORD ?? '';
const from = process.env.MAIL_FROM_ADDRESS ?? '';
const fromName = process.env.MAIL_FROM_NAME ?? 'Voto';
const to = process.argv[2];

console.log(`SMTP_HOST         ${host || 'MISSING'}`);
console.log(`SMTP_PORT         ${port}${secureRaw ? '' : '  (SMTP_SECURE derived from port)'}`);
console.log(`SMTP_SECURE       ${secure}  ${secure ? '(implicit TLS)' : '(STARTTLS)'}`);
console.log(`SMTP_USER         ${user || 'MISSING'}`);
console.log(`SMTP_PASSWORD     ${pass ? `set (${pass.length} chars)` : 'MISSING'}`);
console.log(`MAIL_FROM_ADDRESS ${from || 'MISSING'}`);

const missing = [
  !host && 'SMTP_HOST',
  !user && 'SMTP_USER',
  !pass && 'SMTP_PASSWORD',
  !from && 'MAIL_FROM_ADDRESS',
].filter(Boolean);

if (missing.length > 0) {
  console.error(`\n✗ Missing: ${missing.join(', ')}`);
  console.error('  Without these Voto runs in dry-run and delivers nothing.');
  process.exit(1);
}

if (secure && port === 587) {
  console.log('\n! Port 587 with implicit TLS usually hangs. Use 465, or unset SMTP_SECURE.');
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  requireTLS: !secure,
  auth: { user, pass },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  logger: false,
});

const explain = (err) => {
  const code = err?.responseCode;
  const hint =
    err?.code === 'EAUTH' || code === 535
      ? 'The credential was refused. For ZeptoMail the username is the literal string "emailapikey" and the password is the Mail Agent SMTP token — which is NOT the Send Mail API token.'
      : err?.code === 'ECONNECTION' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT'
        ? 'Could not reach the relay. Check SMTP_HOST and SMTP_PORT, and that the platform allows outbound SMTP on that port.'
        : err?.code === 'ESOCKET'
          ? 'TLS negotiation failed — usually SMTP_SECURE not matching the port. Use secure=true only on 465.'
          : code >= 500
            ? 'The server refused permanently. Check that MAIL_FROM_ADDRESS is on a verified sending domain.'
            : null;
  console.log(`\n✗ ${['smtp', code, err?.code].filter(Boolean).join('_')}`);
  if (hint) console.log(`\n→ ${hint}`);
};

try {
  await transporter.verify();
  console.log('\n✓ Relay reachable and credential accepted.');
} catch (err) {
  explain(err);
  transporter.close();
  process.exit(1);
}

if (to) {
  try {
    await transporter.sendMail({
      from: { address: from, name: fromName },
      to,
      subject: 'Voto configuration check',
      text: 'If you are reading this, Voto can send mail.',
    });
    console.log(`✓ Sent. Check ${to} — including its spam folder.`);
  } catch (err) {
    explain(err);
    transporter.close();
    process.exit(1);
  }
} else {
  console.log('\nPass an address to send a real test: npm run check:email you@yourdomain.com');
}

console.log(
  '\n! Voto cannot disable click/open tracking over SMTP — the API parameters are gone.\n' +
    '  Turn both OFF in the provider console. A tracked link records when each\n' +
    '  person opened their ballot, which is what the privacy design exists to prevent.',
);

transporter.close();
