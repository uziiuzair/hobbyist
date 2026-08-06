# `docs/backups/` backup, restore and PITR

**Status:** PROPOSED. Nothing built.

Backups that happen without being thought about, and a restore that works on the
worst day.

## Position

**Backups are solved. We are wrapping, not reimplementing.** pgBackRest and Barman
are mature, correct, and battle-tested. Their ergonomics are the problem, not
their capability. Writing a backup tool from scratch to hold a user's only copy
of their data would be arrogant.

## In scope

- Choosing between pgBackRest and Barman, and documenting why
- Sensible defaults that apply without configuration, because a backup a user has
  to set up is a backup that does not exist
- `hobby pg restore` and point-in-time recovery as one comprehensible command
- Backup targets: local disk first, S3-compatible remote second
- **Restore verification.** An unverified backup is a rumour. Some periodic proof
  that a restore actually works belongs in v1, not in a later hardening pass.
- Interaction with hibernation, since a sleeping database still needs backing up
  and a backup must not keep it awake forever

## Out of scope

- Replication and high availability. One box.
- Cross-host backup orchestration.

## Open questions

- Does taking a backup wake a sleeping instance, or can it work against the data
  directory at rest? The second is much better if it is safe, and needs verifying
  rather than assuming.
- Retention defaults. Somebody's disk will fill up, and it should be predictable
  when.
