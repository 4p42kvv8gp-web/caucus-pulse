# Archive operations

The live SQLite archive holds source posts, captured records, account evidence, analysis, reviews and the spending ledger. Keep it on one host's local persistent disk. Code belongs in Git; this private data does not.

All commands below run from the application directory, use Node 24.19.x, and make no X, model-provider or storage-provider requests. `CAUCUS_DB_PATH` or `--database` selects the archive; the default is `data/pulse.sqlite`. Directories must be owner-only real directories (0700), files owner-only regular files (0600), and neither symbolic links nor hard links. Errors retain the source and block unsafe continuation.

## Inspect and back up

```sh
node scripts/archive.js status
node scripts/archive.js backup
node scripts/archive.js verify --backup /absolute/path/to/data/backups/backup-TIMESTAMP-ID.sqlite
```

`status` reads integrity, schema, record counts, accounted spending, removal-journal size and maintenance-lock presence. It does not open or print credentials. `backup` creates a consistent SQLite snapshot while ordinary archive access may continue. It migrates the copy to the current schema, applies source removals, rebuilds search, compacts it and seals it as a self-contained database. The active database is not replaced. A JSON manifest records the snapshot's SHA-256, byte size, schema and record counts; verification checks those against the file and runs SQLite integrity/foreign-key checks. Credentials live outside the database and are excluded.

Schema 10 gives the search projection an explicit integer primary key. This preserves its FTS document identities across compaction. The migration preserves existing search IDs transactionally and rebuilds the index; a failure rolls back the migration. Do not edit the schema version manually.

Schema 11 keeps tentative labels from an unresolved human review out of topic counts and filters. It updates the disposable search projection while retaining source text, model proposals, all review history and stable search IDs. A failed migration rolls back the view and projected labels together. New backups migrate their copy to schema 11; an older application cannot open the upgraded live archive.

Backups remain **plaintext private local files**. They protect against some accidental changes, but a lost or failed host can lose both archive and backups. Encrypted off-host storage, a separately protected removal ledger, backup retention and a restore drill on the chosen host are required before calling this disaster recovery. No off-host copy or retention scheduler is active. New backups intentionally have no automatic pruning; inspect disk usage and retain only the agreed recovery window.

SQLite's [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html) provides a consistent snapshot and may require substantial temporary space. Keep at least twice the live database size available for compaction, plus the additional backup and normal growth. Do not copy only a live `.sqlite` file while ignoring its write-ahead log.

## Stage recovery without replacing the archive

```sh
node scripts/archive.js restore --backup /absolute/path/to/data/backups/backup-TIMESTAMP-ID.sqlite
```

This creates a new `data/restores/restore-*.sqlite` candidate. It never overwrites or activates the current archive. It verifies the backup first, migrates the copy, reapplies the current removal journal and tombstones, and conservatively merges the current spending ledger. Higher reservations/costs are retained; ambiguous settlements remain uncertain. Old balance observations and collection leases are cleared. The candidate receives a `restore-reconciliation-required` fault, so paid reads remain blocked even if a fresh balance is later supplied.

Inspect its manifest, counts, source/review history, deletion ledger, collection checkpoints and spending against the current archive and provider records. Stop the application and all workers before an operator performs an approved activation. Preserve the newest removal journal beside the activated database. There is deliberately no automatic activation or command that clears the reconciliation fault. Restoring an old archive must never revive a removed post, reduce accounted spending, or imply that an old collection checkpoint is complete.

Legacy snapshots without manifests can be inspected and staged, but report `manifestVerified: false`; their contents have no previously recorded integrity proof. Snapshots with an attached nonempty WAL must be closed and inspected before restoration. Opening a snapshot as a writable archive may change it and invalidate its manifest.

## Remove a source and managed copies

Only execute this for a requested or verified source removal. Preview first:

```sh
node scripts/archive.js remove --ids 123456789
node scripts/archive.js remove --ids 123456789 --execute
```

The first command returns affected current records and managed copies, with `executed: false`. Execution writes the source ID and deletion time to the durable, checksummed `source-removals.json` **before** deleting records. Startup replays this journal before serving the archive. If a crash interrupts cleanup, `removal-cleanup-pending` keeps paid reads blocked until cleanup succeeds.

Removal cascades through stored source content, reviews, model runs, search/vector projections, incident links and captures. It deletes entire matching managed backups and staged restores, and matching diagnostic JSON files under `data/reports` and `data/operations`. It then rebuilds FTS, compacts the database and checkpoints the WAL. An open snapshot, unsafe file, oversized inventory or unreadable artifact remains explicitly uninspectable; cleanup is incomplete and the fault remains. Close that snapshot or resolve the reported artifact, then rerun removal for the same ID. Repeating it is safe and checks all journaled removals again.

The managed scope is intentionally explicit: `backup-*`/`before-*` snapshots under `data/backups`, `restore-*` candidates under `data/restores`, and JSON diagnostics with matching numeric source IDs under the two diagnostic directories. Original imports, user-supplied reference files, exports elsewhere, OS/cloud snapshots, third-party datasets and manual copies are outside this command. Inventory and delete those separately when applicable. Future external storage must participate in the same removal process. An X deletion-event/compliance feed is not connected yet, so this command does not discover provider removals automatically.

[SQLite secure deletion](https://www.sqlite.org/pragma.html#pragma_secure_delete), FTS rebuilding and compaction reduce retained data in the application files. They do not prove physical erasure from SSDs, filesystem snapshots or storage-provider backups.

## Maintenance and failure handling

```sh
node scripts/archive.js compact
```

Backup, restore, removal and compaction use a private maintenance lock. An existing lock stops another operation; it is never automatically removed based on age. Inspect the recorded process and any interrupted work before clearing a stale lock. The normal server may retain readers during compaction; if a reader blocks the final WAL checkpoint, stop the application and retry. No source data or spending reservations should be manually reset to resolve an operational error.

The automated checks use temporary synthetic archives: live-WAL snapshots, manifest alteration, older-schema migration and rollback, source replay after interrupted removal, open-backup cleanup, exact search after compaction, and recovery with higher current spending. The real pilot has a verified backup; no real source has been removed or restored as a test.
