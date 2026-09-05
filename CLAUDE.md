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

The package pins the SDK — Green in `green/deps.edn`, the Red SDK in
`red/package.json`, the Blue SDK in `blue/pyproject.toml` — and ONCE, in the
same three manifests and in the red payload's `PINS`, for two namespaces:
`compute-cluster` (`io.github.getcolors.once.compute-cluster`,
`package-once-red`'s `computeCluster`, `package_once_blue.compute_cluster`),
the one implementation of the Compute Cluster Standard
(`workspace/standards/compute-cluster.md`), and `ssh`
(`io.github.getcolors.once.ssh`, ONCE's unexported `red/src/ssh.ts` reached
through `red/src/once.ts`, `package_once_blue.ssh`), the reference
implementation of the SSH Keypair Standard (`workspace/standards/ssh-keypair.md`).
The package's `ssh` module wraps ONCE's with the build placeholder; its
`ssh_config` module and its `ansible-local` play are its own copies of the
multi-node shape every DB package carries (`workspace/standards/ssh-config.md`
§7; `workspace/scripts/package-copies.py` gates the copies). Keygen mode is
the absence of `digitalocean-ssh-keys`; `digitalocean-ssh-private-key` is
required in opt-out mode only. On a real create the keypair matrix and the
DigitalOcean key preflight run in `start-step` before anything renders; the
keypair is removed last on delete, after the destroy. The goldens have two
fixtures, `test/fixtures/colors.yml` (keygen) and `test/fixtures/optout.yml`
(opt-out, byte-for-byte the pre-standard rendering under its own profile),
each under both state backends.
The package owns its provider registry, its OpenTofu templates and its stage
names; its `compute-providers` registry and `spec` (one homogeneous role of
`cluster-nodes` nodes, fallback offset 11, the `10.114.0.0/20` fallback
subnet, a discovered network), its own validators — the fixed node count, the
`default` VPC mode, the `0.0.0.0/0` refusal on both source lists — and its
`params-errors`; ONCE owns selection, the source lists, the network and
topology checks, the fallback nodes, the aliases, `read-state`,
`adopt-state`, `resolved-cluster` and the provider-switch guard. The compute
state is the template's `params` output — `provider`, `vpc_id`,
`vpc_ip_range`, and one node per droplet — adopted under `:once/cluster`; a
pre-adoption state, which recorded only the parallel
`node_public_ips`/`node_private_ips` lists, is translated into the same shape
by the reader in `tools`, and refused when the lists disagree. The
`~/.ssh/config` block is the SSH Config Standard's: one block marked with the
profile, `Host <profile>` for node 1 and `<profile>-<index>` per node, with
the `IdentityFile` pair in keygen mode; the one-cycle removal of the
pre-standard per-node blocks has run its cycle and is gone. Use
`POSTGRES_AGY_LIB_ROOT` (the repository root, for every colour; red also
accepts the `red/` dir directly), `GREEN_LIB_ROOT` and `ONCE_LIB_ROOT` for
working-tree development. Final launchers use a pushed SHA managed by
`bb pin` (in `green/`), which stamps all three payloads from their unpinned
birth forms; deployment launchers are copies, not symlinks.

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
