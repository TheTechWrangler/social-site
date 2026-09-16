# RefugeCloud deployment: backup retirement

Batch 15 uses [paired backup and offline restore](../docs/backups.md). The old
unit templates have been removed from this repository:

| Retired service | Retired timer | Script it invoked |
| --- | --- | --- |
| `refugecloud-db-backup.service` | `refugecloud-db-backup.timer` | `scripts/backup-db.sh` |
| `refugecloud-uploads-backup.service` | `refugecloud-uploads-backup.timer` | `scripts/backup-uploads.sh` |

Both scripts intentionally exit unsuccessfully with recovery instructions. They
remain as refusal stubs for legacy callers; do not install or start the retired
units, call the scripts, or use `backup:db` / `backup:uploads` to obtain a backup.
Removing repository templates does not change installed systemd units.

## Existing installations

An operator must inspect installed units and arrange the maintenance backup
schedule before retiring the old timers. For each installed timer, disable future
runs (an absent unit needs no action):

```bash
sudo systemctl disable --now refugecloud-db-backup.timer
sudo systemctl disable --now refugecloud-uploads-backup.timer
```

Inspect the corresponding services before stopping or removing installed copies;
an older deployment may still have a real backup job in progress. Preserve its
output and logs, and let an active job finish or reconcile it deliberately. Archive
or remove the exact retired unit files only after review, then run
`sudo systemctl daemon-reload`. Confirm neither timer remains scheduled. Do not
remove old DB/tar archives as part of unit retirement.

There is no replacement automatic timer in Batch 15. Do not point these timers at
the recovery CLI: paired backup requires the application and all storage writers
stopped, explicit reviewed storage paths, and maintenance confirmation. Arrange
operator-controlled maintenance windows using the [runbook](../docs/runbook.md#paired-backup-and-offline-restore),
verify completed sets, and keep an off-host copy. The repository follow-up does
not execute any systemd commands or change the running production service.
