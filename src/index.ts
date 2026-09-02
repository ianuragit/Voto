import { config } from './config.js';
import { log } from './logging.js';
import { buildServer } from './server.js';
import { startSweeper, sweepExpiredPolls } from './services/lifecycle.js';
import { verifyMailer } from './email/mailer.js';

/**
 * Startup runs as named stages so a crash says which one failed.
 *
 * The previous version reported every boot failure as the single word
 * "failed to start" with the cause tucked into a scrubbed context field, which
 * is precisely the wrong trade: a crash loop is when you need the most detail,
 * and there is no ballot data in a configuration or filesystem error.
 */
class StartupError extends Error {
  readonly stage: string;
  override readonly cause: unknown;

  constructor(stage: string, cause: unknown) {
    super(`startup failed during: ${stage}`);
    this.name = 'StartupError';
    this.stage = stage;
    this.cause = cause;
  }
}

async function stage<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new StartupError(name, err);
  }
}

/**
 * A boot failure is printed in full — message and stack — because none of it
 * describes a voter. The one thing that could is an address quoted inside a
 * mail or config error, so those are masked on the way out (§6.3).
 */
function reportFatal(err: unknown): void {
  const failed = err instanceof StartupError ? err.stage : 'startup';
  const cause = err instanceof StartupError ? err.cause : err;
  const detail =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}\n${cause.stack ?? ''}`
      : String(cause);
  const masked = detail.replace(/[^\s<>"']+@[^\s<>"']+/g, '[address]');

  process.stderr.write(
    `\nVOTO FAILED TO START — stage: ${failed}\n${masked}\n\n` +
      `  DATA_DIR=${config.DATA_DIR} PORT=${config.PORT} NODE_ENV=${config.NODE_ENV}\n` +
      `  If this names a database or path, check the Railway volume is mounted at DATA_DIR.\n` +
      `  If it names SMTP, run: npm run check:email\n\n`,
  );
}

async function main(): Promise<void> {
  const app = await stage('build server', () => buildServer());

  // §11 — one sweep at boot (the process may have been down over a deadline,
  // or died owing voters a results email), then every 60 seconds. Reads
  // evaluate deadlines lazily regardless. This is also the first thing to
  // touch the databases, so it is where a bad volume surfaces.
  await stage('open databases and sweep deadlines', () => sweepExpiredPolls());
  const sweeper = startSweeper();

  await stage('listen', () => app.listen({ port: config.PORT, host: config.HOST }));

  // Deliberately at warn: production runs at warn, and "the service is up" is
  // the one line worth having in a deploy log.
  log.warn('voto listening', { port: config.PORT, env: config.NODE_ENV });

  // Check the relay once at boot. A poll needs 100% turnout, so an invite that
  // cannot be delivered means the poll cannot complete — that deserves a loud
  // line in the deploy logs, not a discovery three days later. Never fatal:
  // ballots must stay servable even when mail is down.
  void verifyMailer();

  const shutdown = async (signal: string): Promise<void> => {
    log.warn('shutting down', { signal });
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
  reportFatal(err);
  process.exit(1);
});
