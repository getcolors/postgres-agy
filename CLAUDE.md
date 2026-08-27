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
`test/fixtures/colors.yml` is rendered under the **local** state backend and
again under **r2**, produced by overlaying `COLORS_PAR_PROVIDER_BACKEND=r2` on
the same file. The committed trees live at
`test/resources/golden/{local,r2}/postgres-agy-fixture/` and differ only in the
OpenTofu stages' `backend.tf.json`. `scripts/golden.sh` checks green against
both; `scripts/parity.sh` renders both variants through every colour and diffs
the trees — and the colour template trees (`red/resources`, blue's embedded
`resources/`) — byte for byte.

## Reuse surface

The package owns its OpenTofu infrastructure template (3 Droplets in default
regional VPC, firewall rules, Cloudflare DNS records) and its Ansible playbooks
— in every colour, as byte-identical template copies. No external server module
is reused; the three nodes are identical peers with Patroni managing leader
election and failover. The provider registry is package-owned in each colour's
`validate` module.

## Coupling

The package pins the Green SDK in `green/deps.edn`, the Red SDK in
`red/package.json`, and the Blue SDK in `blue/pyproject.toml`. There is no ONCE
dependency in any colour. Use `POSTGRES_AGY_LIB_ROOT` (the repository root, for
every colour; red also accepts the `red/` dir directly) and `GREEN_LIB_ROOT`
for working-tree development. Final launchers use a pushed SHA managed by
`bb pin` (in `green/`), which stamps all three payloads from their unpinned
birth forms; deployment launchers are copies, not symlinks.

## Safety

- Credentials use `COLORS_PAR_*` and never render into files on disk.
- `COLORS_PAR_PROFILE` is refused.
- All cluster communication (streaming replication, Patroni REST API, etcd) is
  scoped strictly to the private VPC network.
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
