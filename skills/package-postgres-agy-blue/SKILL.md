---
name: package-postgres-agy-blue
description: Build and operate a three-node PostgreSQL 17 failover cluster on DigitalOcean with Patroni, colocated etcd v3, HAProxy client routing, Cloudflare DNS, pgBackRest backups to Cloudflare R2, heartbeat streaming, and verified restore check.
license: MIT
---

# PostgreSQL 17 High Availability on DigitalOcean

Read `colors.yml` before changing desired state or running a lifecycle command.

## Safety

- Keep secrets out of `colors.yml`; use gitignored `COLORS_PAR_*` exports.
- Never set `COLORS_PAR_PROFILE` and never edit generated `.colors/` files.
- Default to `build` and `create --dry-run`; real create/delete needs explicit authorization.
- Keep `compute-prevent-destroy: true`. Lift it for one authorized delete with `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false`.
- Restrict `digitalocean-ssh-sources` and `digitalocean-client-sources`; do not use `0.0.0.0/0`.

## Commands

```sh
./blue build
./blue create --dry-run
./blue create
./blue status
./blue switchover
./blue backup
./blue verify-restore
./blue psql
./blue delete
```

The operator verbs dispatch over SSH through the `~/.ssh/config` aliases the
local stage manages — one block marked with the profile, holding
`Host <profile>` for node 1 and `Host <profile>-0`, `<profile>-1`,
`<profile>-2` for each node. `--node N` picks which node to dispatch through
(`--node 2` is `<profile>-1`); use a live one when the cluster is degraded.
