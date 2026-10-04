# Host files

## `flexperiment-recovery-backup`

Installed as `/usr/local/sbin/flexperiment-recovery-backup` (root, 0750). `flexperiment-recovery-backup.timer` runs it daily at 21:15 UTC.

What it does:
- Reads the running Commerce container's recovery variables (`COMMERCE_*`, `TOCHKA_*`, `UNISENDER_*`, `YANDEX_*`, `SOURCE_COMMIT`).
- Encrypts them with `age` for `/etc/flexperiment/recovery/age-recipient.txt`. The plaintext exists only in the pipe.
- Keeps the 7 newest bundles in `/var/backups/flexperiment-recovery`.
- Uploads each bundle to cloud.ru S3 at `art-backups/flexperiment/recovery/runtime/`, keeping the 100 newest.
- Verifies every upload by reading the object back and comparing its sha256.

The S3 client is `rclone/rclone`, pinned by digest: the same image and configuration as refref's backups (refref `ops/host/refref-backup-lib`). The credentials are mounted read-only from `/etc/flexperiment/recovery/s3-{access,secret}-key`. It replaced `minio/mc`, which is no longer pullable from Docker Hub: a host that lost its cached copy could not back up at all.

Test, with no cloud.ru (S3 is replaced by a local directory through the same rclone code):

```bash
bash deploy/test-recovery-backup.sh
```

Install or update, as root on the host, keeping the previous version for rollback:

```bash
cp -p /usr/local/sbin/flexperiment-recovery-backup /usr/local/sbin/flexperiment-recovery-backup.prev
install -m 0750 -o root -g root deploy/host/flexperiment-recovery-backup /usr/local/sbin/flexperiment-recovery-backup
systemctl start flexperiment-recovery-backup.service && journalctl -u flexperiment-recovery-backup.service -n 6 --no-pager
```

The last command must print `RECOVERY_BACKUP=SUCCESS`.
