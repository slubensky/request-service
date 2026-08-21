/**
 * Regression guard for SDD §changelog #012: drizzle-orm's runtime migrator
 * (`PgDialect.migrate`, node_modules/drizzle-orm/pg-core/dialect.*) does not track
 * applied migrations by hash. It compares each `drizzle/meta/_journal.json` entry's
 * `when` timestamp against the single most-recently-applied `created_at` recorded in
 * `drizzle.__drizzle_migrations`, and only applies a migration whose `when` is
 * strictly greater than that high-water mark.
 *
 * A migration's `when` was once hand-set five days ahead of the next migration's real
 * generation time. The next migration's (correct, real) timestamp was then smaller than
 * the recorded high-water mark, so the migrator silently skipped it forever on any
 * database that had already applied the inflated one -- no error, and no test caught it
 * because PGlite integration tests always run every migration against a fresh database,
 * where journal *order* still resolves correctly even when the timestamps themselves are
 * out of true chronological sequence. Only a database that already has an earlier
 * migration applied exposes the gap, which no test in this suite provisions.
 *
 * This test does not need a database at all: strictly increasing `when` values, in
 * journal order, is the exact invariant the runtime migrator depends on. Guard it directly
 * against the journal file so a future hand-authored entry can't reintroduce this.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const journalPath = path.join(here, '..', 'drizzle', 'meta', '_journal.json');

interface JournalEntry {
  when: number;
  tag: string;
}

test('migration journal entries have strictly increasing `when` timestamps, in order', () => {
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
  assert.ok(journal.entries.length > 0, 'journal must not be empty');

  for (let i = 1; i < journal.entries.length; i += 1) {
    const previous = journal.entries[i - 1]!;
    const current = journal.entries[i]!;
    assert.ok(
      current.when > previous.when,
      `${current.tag} (when=${current.when}) must be strictly greater than the preceding ` +
        `${previous.tag} (when=${previous.when}) -- drizzle-orm's runtime migrator gates on ` +
        `this timestamp ordering, not migration order or content hash, so a non-increasing ` +
        `value here silently skips the migration forever on any already-migrated database.`,
    );
  }
});
