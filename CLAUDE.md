# CLAUDE.md

## What this is

`postgres-agy` is a green-only Package Skill provisioning a three-node
PostgreSQL 17 high-availability failover cluster on DigitalOcean, with Patroni,
colocated etcd v3, HAProxy client routing, Cloudflare DNS-only records, continuous
WAL archiving and backups via pgBackRest to Cloudflare R2, continuous heartbeat
streaming, and scheduled verified restore drills.

The primary consumer is `../postgres-agy-digitalocean`.

## Commands

```sh
bb test
bb golden
./scripts/launcher.sh
./green build
./green create --dry-run
```

Never run real create/delete without explicit authorization. Never edit
`.colors/`. Real deletion requires `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false`.

## Reuse surface

The package owns its OpenTofu infrastructure template (3 Droplets in default
regional VPC, firewall rules, Cloudflare DNS records) and its Ansible playbooks.
No external server module is reused; the three nodes are identical peers with
Patroni managing leader election and failover.

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
pin is managed only by `bb pin` after a clean pushed commit; never invent a SHA.
