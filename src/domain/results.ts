/**
 * FR-4.5 — the integrity verdict, as a pure function of three numbers.
 *
 * It lives here, with no database access, so both the page and the results
 * email reach the same verdict by the same route, and so the rule itself can
 * be read without reading a repository.
 */

export type Integrity = 'PASS' | 'INVALID';

export interface Results {
  /** Empty when the verdict is INVALID: suppressed, not annotated. */
  counts: number[];
  totalBallots: number;
  rosterSize: number;
  integrity: Integrity;
  discrepancy: string | null;
}

/**
 * Results are released only when the counter total, the number of consumed
 * ballots and the roster size all agree. Any disagreement suppresses the
 * numbers entirely — it is not a warning printed next to them.
 */
export function summarise(counts: number[], turnout: number, rosterSize: number): Results {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum === turnout && turnout === rosterSize) {
    return { counts, totalBallots: sum, rosterSize, integrity: 'PASS', discrepancy: null };
  }
  return {
    counts: [],
    totalBallots: sum,
    rosterSize,
    integrity: 'INVALID',
    discrepancy: `Counted ballots: ${sum}. Ballots consumed: ${turnout}. Roster size: ${rosterSize}. These must be equal, so the result is withheld.`,
  };
}
