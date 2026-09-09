# CLAUDE.md

## What this is

`postgres-agy` is a tri-colour Package Skill (green, red, blue) provisioning a
three-node PostgreSQL 17 high-availability failover cluster on DigitalOcean,
with Patroni, colocated etcd v3, HAProxy client routing, Cloudflare DNS-only
records, continuous WAL archiving and backups via pgBackRest to Cloudflare R2,
continuous heartbeat streaming, and scheduled verified restore drills.

The primary consumer is `../postgres-agy-digitalocean`.

## Layout and commands

The three implementations live in the tri-colour layout, matching `netbird`:
canonical Clojure in `green/` (`green/bb.edn`, `green/deps.edn`, `green/src/`,
`green/tasks/`, tests under `green/test/clj`), TypeScript/Bun in `red/`, and
Python/uv in `blue/`. Green is canonical: a behavioural change lands in all
three colours in the same commit and passes `scripts/parity.sh`. The fixture
and the goldens are shared across colours at the repository root —
`test/fixtures/` and `test/resources/golden/` — with `green/test/fixtures` and
`green/test/resources` symlinks pointing at them. Each colour dir holds a
launcher symlink to its skill payload (`green/green`, `red/red`, `blue/blue`).

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept   # regenerate after an intended change — read the diff first
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, two state backends, byte for byte
./scripts/launcher.sh          # from the repository root
cd green && ./green build
cd green && ./green create --dry-run
```

Never run real create/delete without explicit authorization. Never edit
`.colors/`. Real deletion requires `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false`.

## The two-backend golden and parity axis

The goldens have a second axis beside the fixture: the one
`test/fixtures/colors.yml` is rendered under the **s3** state backend and
again under **r2**, produced by overlaying `COLORS_PAR_PROVIDER_BACKEND=r2` on
the same file. The committed trees live at
`test/resources/golden/{s3,r2}/postgres-agy-fixture/` and differ only in the
OpenTofu stages' `backend.tf.json`. `scripts/golden.sh` checks green against
both; `scripts/parity.sh` renders both variants through every colour and diffs
the trees — and the colour template trees (`red/resources`, blue's embedded
`resources/`) — byte for byte.

## Coupling

Every color depends on the pinned colors-compute library for compute, remote
state, provider credentials, SSH keys, topology expansion, and lifecycle
ownership. The package declares three homogeneous peers and application network
requirements. Colors fans out the same library node operation, then joins
complete observed outputs for Ansible and DNS. ONCE remains only for application
DNS helpers and its separate backend credential binding.

Provider templates and registries belong to the library. Supporting another
compatible provider requires a dependency bump, without application source or
provider fixture changes. Build and dry-run use documentation addresses and a
placeholder home without reading local keys. Real operations validate remote
ownership before generating keys or invoking a compute provider. Existing
monolithic compute state requires an explicit migration; it is never silently
adopted. Local SSH config plays remain package-owned and use observed SSH users
and the selected identity path.

Manifests and lockfiles pin published dependencies. Publish package source before
running `bb pin` in `green/`, then publish the stamped launcher copies. Red
launchers resolve compute and SDK transitively through the pinned package;
repeating these Git dependencies breaks cold installation in Bun 1.3.13.


## Safety

- Credentials use `COLORS_PAR_*` and never render into files on disk.
- `COLORS_PAR_PROFILE` is refused.
- All cluster communication (streaming replication, Patroni REST API, etcd) is
  scoped strictly to the private VPC network. Every machine in the account's
  regional default VPC is inside that east-west trust boundary, which the
  Compute Cluster Standard names as a security exception of a discovered
  network.
- Public ingress is restricted to SSH (port 22) and HAProxy (port 5432/5433)
  from configured source CIDRs.
- pgBackRest restore verification uses `--archive-mode=off` and isolated scratch
  directories to prevent archive poisoning.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not push unless explicitly asked. The launcher
pins are managed only by `bb pin` (in `green/`) after a clean pushed commit;
never invent a SHA.

### Repeated deletion after compute retirement

A repeated `delete` with validated retired compute ownership resumes only the
local generated-file cleanup. It does not require removed SSH keys or contact
the former hosts, DNS, registry, or other application cloud resources. Failed
ownership inspection still stops deletion. Local cleanup preserves unrelated
files and is safe to repeat.
