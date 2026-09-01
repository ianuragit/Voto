import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runs before the test file is imported, so `src/config.ts` sees these values.
 * Every test file gets its own pair of SQLite files.
 */
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'voto-test-'));
process.env.SESSION_SECRET = 'test-secret-not-for-production';
process.env.ALLOWED_CREATORS = 'ravi@example.com';
process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
process.env.EMAIL_DRY_RUN = '1';
process.env.LOG_LEVEL = 'silent';
