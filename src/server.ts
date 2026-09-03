import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { isNoLogPath, log } from './logging.js';
import { creatorRoutes } from './web/routes/creator.js';
import { publicRoutes } from './web/routes/public.js';
import { webhookRoutes } from './web/routes/webhooks.js';
import { messagePage } from './web/views/pages.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // §6.3 — the framework logger is off entirely, not merely filtered. No
    // request line, no header, no body, no path is written by Fastify itself;
    // everything this server logs goes through src/logging.ts, which scrubs.
    logger: false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(cookie);
  await app.register(formbody);

  // Keep the raw JSON body for webhook signature verification.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      if ((body as Buffer).length === 0) return done(null, {});
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /**
   * §8 — headers on every page. `Referrer-Policy: no-referrer` is the one that
   * matters most: without it, a link on the ballot page leaks the magic-link
   * URL in a Referer header.
   */
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    if (!req.url.startsWith('/static/')) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      reply.header('Pragma', 'no-cache');
    }
    if (config.isDeployed) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  await app.register(publicRoutes);
  await app.register(creatorRoutes);
  await app.register(webhookRoutes);

  app.setNotFoundHandler(async (_req, reply) =>
    reply
      .code(404)
      .type('text/html; charset=utf-8')
      .send(
        messagePage({
          title: 'Not found',
          heading: 'Nothing here',
          body: 'Check the link in your invite email.',
          tone: 'bad',
        }),
      ),
  );

  app.setErrorHandler(async (err: Error & { code?: string }, req, reply) => {
    // §10 — a locked volume is a 503 with no partial write, never a 500 blob.
    const busy = /SQLITE_BUSY|SQLITE_LOCKED/i.test(err.message);
    // §6.3 — never the body, never the query, and never on the vote path at all.
    if (!isNoLogPath(req.url)) {
      log.error('request failed', { code: busy ? 'db_busy' : err.code ?? 'error' });
    }
    return reply
      .code(busy ? 503 : 500)
      .type('text/html; charset=utf-8')
      .send(
        messagePage({
          title: 'Something went wrong',
          heading: busy ? 'Voto is busy' : 'Something went wrong',
          body: busy
            ? 'The database was locked. Nothing was written. Try again in a moment.'
            : 'Nothing was recorded. Try again.',
          tone: 'bad',
        }),
      );
  });

  return app;
}
