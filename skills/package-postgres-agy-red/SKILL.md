---
name: package-postgres-agy-red
description: Build and operate a three-node PostgreSQL 17 failover cluster with Patroni, colocated etcd v3, HAProxy client routing, Cloudflare DNS, pgBackRest backups to Cloudflare R2, heartbeat streaming, and verified restore check.
license: MIT
---

# PostgreSQL 17 High Availability

Read `colors.yml` before changing desired state or running a lifecycle command.

## Safety

- Keep secrets out of `colors.yml`; use gitignored `COLORS_PAR_*` exports.
- Never set `COLORS_PAR_PROFILE` and never edit generated `.colors/` files.
- Default to `build` and `create --dry-run`; real create/delete needs explicit authorization.
- Keep `compute-prevent-destroy: true`. Lift it for one authorized delete with `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false`.
- Restrict `postgres-ssh-sources` and `postgres-client-sources`; do not use `0.0.0.0/0`.

## Commands

```sh
./red build
./red create --dry-run
./red create
./red status
./red switchover
./red backup
./red verify-restore
./red psql
./red delete
```

The operator verbs dispatch over SSH through the `~/.ssh/config` aliases the
local stage manages — one block marked with the profile, holding
`Host <profile>` for node 1 and `Host <profile>-0`, `<profile>-1`,
`<profile>-2` for each node. `--node N` picks which node to dispatch through
(`--node 2` is `<profile>-1`); use a live one when the cluster is degraded.

Compute, SSH keys, and remote state are supplied by the pinned
[colors-compute library](https://github.com/getcolors/colors-compute). Select a
provider supported by that revision and configure its options and credentials.
The package supplies three peer nodes and application network requirements;
the library joins observed node addresses and SSH users for Ansible.

Use `provider-backend: r2` or `s3`. R2 requires
`COLORS_PAR_R2_ACCESS_KEY_ID` and `COLORS_PAR_R2_SECRET_ACCESS_KEY`; S3 uses
the ambient AWS credential chain. The library owns managed profile keys, or
uses configured external keys with `ssh-private-key-path`. Existing monolithic
compute state requires explicit migration and is refused by this lifecycle.

### Repeated deletion after compute retirement

A repeated `delete` with validated retired compute ownership resumes only the
local generated-file cleanup. It does not require removed SSH keys or contact
the former hosts, DNS, registry, or other application cloud resources. Failed
ownership inspection still stops deletion. Local cleanup preserves unrelated
files and is safe to repeat.
