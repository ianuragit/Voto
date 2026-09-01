import { config } from './config.js';
import { log } from './logging.js';
import { buildServer } from './server.js';
import { startSweeper, sweepExpiredPolls } from './services/lifecycle.js';

async function main(): Promise<void> {
  const app = await buildServer();

  // §11 — one sweep at boot (the process may have been down over a deadline),
  // then every 60 seconds. Reads evaluate deadlines lazily regardless.
  sweepExpiredPolls();
  const sweeper = startSweeper();

  await app.listen({ port: config.PORT, host: config.HOST });
  log.info('voto listening', { port: config.PORT, env: config.NODE_ENV });

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
