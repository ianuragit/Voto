import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { log } from '../../logging.js';
import * as authRepo from '../../repos/authRepo.js';

/**
 * FR-2.8 — ZeptoMail bounce and delivery callbacks. Signature-verified, and
 * the only thing we take from the payload is an address and a status.
 *
 * Confirm the current signature scheme and payload shape against ZeptoMail's
 * webhook documentation when you configure this in the console.
 */

function verifySignature(req: FastifyRequest): boolean {
  if (!config.ZEPTOMAIL_WEBHOOK_SECRET) return false;
  const header = req.headers[config.ZEPTOMAIL_WEBHOOK_SIGNATURE_HEADER.toLowerCase()];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;
  const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (!raw) return false;
  const expected = createHmac('sha256', config.ZEPTOMAIL_WEBHOOK_SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.replace(/^sha256=/, ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const BOUNCE_EVENTS = new Set(['bounce', 'hardbounce', 'soft_bounce', 'softbounce', 'bounced']);
const FAIL_EVENTS = new Set(['dropped', 'spam', 'complaint', 'failed', 'rejected']);

/** Pulls addresses out of whatever shape the callback arrives in. */
function extract(payload: unknown): { email: string; event: string }[] {
  const out: { email: string; event: string }[] = [];
  const walk = (node: unknown, event: string): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const nextEvent =
      typeof obj.event_name === 'string'
        ? obj.event_name
        : typeof obj.event === 'string'
          ? obj.event
          : typeof obj.type === 'string'
            ? obj.type
            : event;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && /address|email/i.test(key) && value.includes('@')) {
        out.push({ email: value.toLowerCase(), event: nextEvent.toLowerCase() });
      } else if (Array.isArray(value)) {
        for (const item of value) walk(item, nextEvent);
      } else if (value && typeof value === 'object') {
        walk(value, nextEvent);
      }
    }
  };
  walk(payload, '');
  return out;
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/zeptomail', async (req, reply) => {
    if (!verifySignature(req)) return reply.code(401).send({ error: 'bad_signature' });

    let updated = 0;
    for (const { email, event } of extract(req.body)) {
      if (BOUNCE_EVENTS.has(event)) updated += authRepo.setDeliveryStatusByEmail(email, 'bounced');
      else if (FAIL_EVENTS.has(event)) updated += authRepo.setDeliveryStatusByEmail(email, 'failed');
    }
    // The address is deliberately absent from this line (§6.3).
    if (updated > 0) log.warn('invite delivery problem reported by provider', { updated });
    return reply.code(200).send({ ok: true });
  });
}
