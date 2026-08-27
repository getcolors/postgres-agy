# postgres-agy

A three-node PostgreSQL 17 high-availability failover cluster on DigitalOcean with:
- Patroni leader election and automatic failover
- 3-node colocated etcd v3 DCS
- HAProxy client routing on primary (5432) and replica (5433) ports
- Cloudflare DNS-only A records
- pgBackRest daily full backups and continuous WAL archiving to Cloudflare R2
- Leader-driven 1-minute heartbeat streaming
- Standby verified restore drill with WAL integrity check

Three interchangeable implementations of the same package: canonical
Clojure/Babashka in `green/`, TypeScript/Bun in `red/`, and Python/uv in
`blue/`. `scripts/parity.sh` proves they render byte-identical artifacts.
