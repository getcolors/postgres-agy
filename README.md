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

The operator verbs (`status`, `switchover`, `failover`, `backup`,
`verify-restore`, `psql`) reach the nodes through the `~/.ssh/config` aliases
the local stage writes — `<profile>` for node 1 and `<profile>-0`,
`<profile>-1`, `<profile>-2` for each node, the Compute Cluster Standard's
names, which replaced the `<profile>-1..3` aliases the package wrote before it
adopted the standard.
