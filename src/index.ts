import { config } from './config.js';
import { log } from './logging.js';
import { buildServer } from './server.js';
import { startSweeper, sweepExpiredPolls } from './services/lifecycle.js';
import { verifyMailer } from './email/mailer.js';

async function main(): Promise<void> {
  const app = await buildServer();

  // §11 — one sweep at boot (the process may have been down over a deadline,
  // or died owing voters a results email), then every 60 seconds. Reads
  // evaluate deadlines lazily regardless.
  sweepExpiredPolls();
  const sweeper = startSweeper();

  await app.listen({ port: config.PORT, host: config.HOST });
  log.info('voto listening', { port: config.PORT, env: config.NODE_ENV });

  // Check the relay once at boot. A poll needs 100% turnout, so an invite that
  // cannot be delivered means the poll cannot complete — that deserves a loud
  // line in the deploy logs, not a discovery three days later. Never fatal:
  // ballots must stay servable even when mail is down.
  void verifyMailer();

  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutting down', { signal });
    clearInterval(sweeper);
    await app.close();
    // The stores are opened with synchronous = FULL; there is nothing buffered
    // to flush, and neither connection module is imported here (§7.4).
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('failed to start', { reason: err instanceof Error ? err.message : 'unknown' });
  process.exit(1);
});
