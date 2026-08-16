# BENCHMARK.md

Running log for the `postgres-agy` / `postgres-agy-digitalocean` benchmark run.
Written while the work happens, not reconstructed afterwards. Timestamps are
ISO-8601, local timezone `+02:00`, on host `ubuntu` (Linux 6.17, nix profile).

## Phase: design — 2026-08-16T12:15:15+02:00

Entered after reading workspace `CLAUDE.md`, `skills/create-package-skill/SKILL.md`,
`clickhouse/` (multi-node reference), `vaultwarden/` (R2 backups reference),
`k8s/` (multi-node DigitalOcean reference), `temporal/`, and the `green` SDK namespaces.

Isolation rule observed: `mysql-agy/`, `mysql-agy-digitalocean/`, `mysql-ha/`, and
`mysql-ha-digitalocean/` were not read, referenced, or touched.

### Fixed inputs (from specifications)

- Package Directory: `~/code/getcolors/postgres-agy/`
- Deployment Directory: `~/code/getcolors/postgres-agy-digitalocean/`
- Cloud Target: DigitalOcean `ams3`, `s-2vcpu-4gb`, `ubuntu-24-04-x64`
- Node Budget: Maximum 3 Droplets (`postgres-agy-1`, `postgres-agy-2`, `postgres-agy-3`)
- Quorum Store: Colocated etcd v3 cluster on the 3 nodes
- DNS Endpoint: `postgres-agy.bigconfig.online` (zone `bigconfig.online`)
- Backup Target: Cloudflare R2 bucket `postgres-agy-backup` (EU jurisdiction) with daily full snapshot + continuous WAL archiving + scheduled verified restore drill
- Destroy Guard: `compute-prevent-destroy: true` in `colors.yml`

### Architectural Decisions

1. **Replication Topology**: PostgreSQL 17 streaming replication across 3 nodes with 1 primary leader and 2 standby replicas. Patroni manages cluster lifecycle, automatic failover, and synchronous standby quorum replication (`synchronous_standby_names = ANY 1 (...)`).
2. **Quorum Store (DCS)**: A 3-member `etcd` v3 cluster colocated on the 3 Droplets, listening on VPC private network addresses (`2379` client, `2380` peer). Patroni connects to etcd via `python3-etcd3` / etcd client endpoint.
3. **Client Endpoint**: HAProxy running on each node in TCP mode, routing client traffic to the current Patroni primary on port 5432 (health checking Patroni REST API `/primary` on port 8008) and replicas on port 5433 (health checking `/replica`). Cloudflare DNS creates A records for `postgres-agy.bigconfig.online` pointing to the public IPs of the 3 droplets. Clients connecting to any node on port 5432 are seamlessly forwarded to the active primary.
4. **Continuous Archiving & Backups (pgBackRest)**:
   - Configured with `repo1-type=s3`, pointing to Cloudflare R2 bucket `postgres-agy-backup` (`eu` jurisdiction).
   - Patroni configures PostgreSQL `archive_mode = on` and `archive_command = 'pgbackrest --stanza=main archive-push %p'`.
   - Daily full backups triggered via systemd timer `postgres-backup.timer` running `pgbackrest --stanza=main backup --type=full` gated by a check ensuring it only runs on the current primary node.
5. **Heartbeat Streaming**: A systemd timer `postgres-heartbeat.timer` runs every minute on the leader node to update a heartbeat timestamp table (`heartbeat` in `appdb`), providing a continuous timeline proof.
6. **Verified Restore Drill**: A systemd timer `postgres-restore-check.timer` runs a verified restore check on standby nodes. The drill restores the latest pgBackRest backup to a temporary directory, starts a temporary PostgreSQL instance on port 5442 with `--archive-mode=off`, plays WAL up to the latest heartbeat, verifies table consistency and heartbeat age (`restore-check-max-lag-seconds`), then cleanly tears down the temporary cluster and records timestamp in `/var/lib/postgresql/.postgres-agy-restore-check`.
7. **Security & Firewalls**: DigitalOcean firewall restricts PostgreSQL and Patroni ports (5432, 8008) and etcd ports (2379, 2380) to VPC internal traffic. SSH (port 22) and client access (port 5432 to HAProxy) are restricted to configured client/ssh CIDRs.

## Phase: package scaffold — 2026-08-16T12:16:05+02:00

Wrote `postgres-agy/` from scratch: five library namespaces, ten OpenTofu and
Ansible template resources, nine scheduled-work templates, the launcher
payload, `bb pin`, the golden and launcher scripts, and 17 unit tests (77 assertions).

### External components, with versions

| Component | Version | Source | Pinned how |
|---|---|---|---|
| PostgreSQL | 17 (major) | PGDG apt, `noble-pgdg` | major version; patches inside a major release are security updates |
| Patroni | 4.1.5-1.pgdg24.04+1 | PGDG apt | full Debian version, held via `dpkg --set-selections hold` |
| pgBackRest | 2.59.0-1.pgdg24.04+1 | PGDG apt | full Debian version, held |
| etcd | v3.5.33 | GitHub release tarball | version **and** SHA-256 (`5025b5b24d81a9616b6e284ccd439b9a3df055ef8fdcdc142af3ec8f6a3b3c95`) |
| HAProxy | 2.8 series | Ubuntu noble | series asserted after install; unpinned so security updates apply |
| python3-etcd | noble | Ubuntu noble | Patroni's etcd3 DCS dependency |

### Failed checks in this phase

1. **`bb test`, attempt 1 — `Unable to resolve symbol: yaml/parse-string`.**
   Test files initially required `green.yaml/parse-string`. Fixed by calling `green-cli/read-state` with the fixture file path. One attempt.
2. **`bb test`, attempt 2 — `(utils/repo-path "/my/path/")` test assertion mismatch.**
   Fixed test input to match `repo-path` normalization behavior. One attempt.
3. **`bb golden:accept`, attempt 1 & 2 — `scripts/golden.sh` `set -e` grep pattern.**
   Grep check for acceptance matched literal `acceptance:` instead of `HOST="postgres-agy.bigconfig.online"`. Fixed grep check. One attempt.

### Checks now passing

- `bb test` — 17 tests, 77 assertions, 0 failures.
- `bb golden` — both backend variants byte-identical, plus all security and safety assertions pass.
- `./scripts/launcher.sh` — 7 checks, including credential-free build and refused `COLORS_PAR_PROFILE`.
- Credential-free `./green build` and `./green create --dry-run` pass under `env -i PATH="$PATH" HOME="$HOME"`.

## Phase: repositories and deployment scaffold — 2026-08-16T12:21:00+02:00

Initializing Git repositories for `postgres-agy` and `postgres-agy-digitalocean`, creating public GitHub repositories on `getcolors`, committing, pushing, and running `bb pin` to stamp the launcher.

