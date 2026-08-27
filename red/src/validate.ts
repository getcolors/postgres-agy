// Credential-free desired-state validation, and the provider registry it uses
// — the port of io.github.getcolors.postgres-agy.validate.
//
// The registry is package-owned rather than inherited: this package provisions
// three droplets, its own firewall and its own DNS record set. Keeping the
// table here means one place describes what a provider choice requires, what
// it needs as a credential, and which of those credentials OpenTofu reads
// natively from the environment.
//
// Every check accumulates. A run reports all of a file's problems at once with
// exit 2, because fixing desired state one error per invocation is how a
// person gives up on a config file.
//
// Green renders its keys as Clojure keywords, so every message here carries
// the same leading colon — the three colours must report identical errors for
// one colors.yml.

import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import * as utils from "./utils.ts";

export interface ProviderEntry {
  required: string[];
  secrets: string[];
  tofuEnv: Record<string, string>;
}

export const providers: Record<string, Record<string, ProviderEntry>> = {
  "provider-compute": {
    digitalocean: {
      required: ["digitalocean-name", "digitalocean-region", "digitalocean-size",
                 "digitalocean-image", "digitalocean-ssh-keys",
                 "digitalocean-ssh-private-key", "digitalocean-ssh-sources",
                 "digitalocean-client-sources", "digitalocean-vpc-mode"],
      secrets: ["do-token"],
      tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
    },
  },

  "provider-dns": {
    cloudflare: {
      required: ["cloudflare-zone", "cloudflare-proxied", "cloudflare-record-ttl",
                 "cluster-host"],
      secrets: ["cloudflare-api-token"],
      tofuEnv: { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" },
    },
  },

  "provider-backend": {
    local: { required: [], secrets: [], tofuEnv: {} },
    s3: {
      required: ["s3-bucket", "s3-region"],
      secrets: ["s3-access-key-id", "s3-secret-access-key"],
      tofuEnv: { "s3-access-key-id": "AWS_ACCESS_KEY_ID",
                 "s3-secret-access-key": "AWS_SECRET_ACCESS_KEY" },
    },
    r2: {
      required: ["r2-bucket", "r2-endpoint"],
      secrets: ["r2-access-key-id", "r2-secret-access-key"],
      tofuEnv: { "r2-access-key-id": "AWS_ACCESS_KEY_ID",
                 "r2-secret-access-key": "AWS_SECRET_ACCESS_KEY" },
    },
  },
};

export const slots = ["provider-compute", "provider-dns", "provider-backend"];
export const profilePar = parName("profile");

export const ownRequired = [
  "profile", "workdir", "cluster-name", "cluster-host", "cluster-nodes",
  "postgres-version", "postgres-port", "postgres-database",
  "postgres-admin-user", "postgres-replication-user",
  "patroni-package-version", "patroni-rest-port", "patroni-ttl", "patroni-loop-wait",
  "patroni-retry-timeout", "patroni-synchronous-node-count",
  "etcd-version", "etcd-sha256", "etcd-client-port", "etcd-peer-port",
  "haproxy-version", "haproxy-primary-port", "haproxy-replica-port",
  "haproxy-stats-port",
  "pgbackrest-package-version", "backup-stanza", "backup-oncalendar",
  "backup-retention-full", "restore-check-oncalendar", "restore-check-port",
  "restore-check-max-age-hours", "restore-check-max-lag-seconds",
  "heartbeat-oncalendar", "heartbeat-retention-days",
  "backup-r2-bucket", "backup-r2-endpoint", "backup-r2-region", "backup-r2-prefix",
];

export const ownSecrets = [
  "postgres-admin-password", "postgres-replication-password",
  "backup-r2-access-key-id", "backup-r2-secret-access-key",
];

export const forbiddenVpcKeys = [
  "digitalocean-vpc-id", "digitalocean-vpc-uuid", "digitalocean-vpc-cidr",
  "digitalocean-vpc-name", "digitalocean-vpc",
];

export function placeholder(x: unknown): boolean {
  return x == null ||
    (typeof x === "string" && (!x.trim() || x.toUpperCase() === "REPLACE_ME"));
}

export function entry(opts: Opts, slot: string): ProviderEntry | undefined {
  return providers[slot]?.[String(opts[slot])];
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  return entry(opts, slot)?.tofuEnv ?? {};
}

function slotKeys(opts: Opts, field: "required" | "secrets"): string[] {
  return slots.flatMap((slot) => entry(opts, slot)?.[field] ?? []);
}

function missing(opts: Opts, keys: string[]): string[] {
  return keys.filter((key) => placeholder(opts[key]));
}

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set. postgres-agy takes profile from colors.yml only; ` +
       "an environment overlay could point this deployment at another's " +
       "remote state and backup repository."]
    : [];
}

const dnsRe = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const cidrRe = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const profileRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const identifierRe = /^[a-z_][a-z0-9_]{0,62}$/;
const stanzaRe = /^[a-z][a-z0-9-]{0,31}$/;
const etcdVersionRe = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const debVersionRe = /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.+~:-]+$/;
const sha256Re = /^[0-9a-f]{64}$/;
const oncalendarRe = /^[A-Za-z0-9 *,./:-]+$/;
const httpsRe = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/;
const prefixRe = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validCidr(value: unknown): boolean {
  const s = String(value);
  if (!cidrRe.test(s)) return false;
  return s.split("/")[0]!.split(".").every((octet) => Number(octet) <= 255);
}

export function positiveInt(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x) && x > 0;
}

// pr-str, for the unsupported-provider message: green prints the offending
// value through pr-str, which quotes strings and renders nil bare.
function prStr(value: unknown): string {
  if (value == null) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

const exclusivePortKeys = [
  "patroni-rest-port", "etcd-client-port", "etcd-peer-port",
  "haproxy-primary-port", "haproxy-replica-port", "haproxy-stats-port",
  "restore-check-port",
];

function distinctPortErrors(opts: Opts): string[] {
  const ports = exclusivePortKeys.flatMap((key) => {
    const value = opts[key];
    return typeof value === "number" && Number.isInteger(value)
      ? [[key, value] as const] : [];
  });
  const groups = new Map<number, string[]>();
  for (const [key, value] of ports) {
    groups.set(value, [...(groups.get(value) ?? []), key]);
  }
  const dupes = [...groups.entries()]
    .filter(([, keys]) => keys.length > 1)
    .sort(([a], [b]) => a - b);
  const pg = opts["postgres-port"];
  const shadowed = typeof pg === "number" && Number.isInteger(pg)
    ? ports.filter(([key, value]) => value === pg && key !== "haproxy-primary-port")
        .map(([key]) => key)
    : [];
  return [
    ...dupes.map(([port, keys]) =>
      `port ${port} is claimed by ${keys.join(" and ")}; ` +
      "every listener on a node needs its own port"),
    ...[...shadowed].sort().map((key) => `:${key} must differ from :postgres-port`),
  ];
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];

  for (const key of missing(opts, [...ownRequired, ...slotKeys(opts, "required")])) {
    errors.push(`:${key} is required`);
  }

  for (const slot of slots) {
    if (!Object.hasOwn(providers[slot]!, String(opts[slot]))) {
      errors.push(`unsupported :${slot} ${prStr(opts[slot])}`);
    }
  }

  if (opts["provider-compute"] !== "digitalocean") {
    errors.push(":provider-compute must be digitalocean");
  }
  if (opts["provider-dns"] !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
  }
  if (typeof opts["compute-prevent-destroy"] !== "boolean") {
    errors.push(":compute-prevent-destroy must be true or false");
  }
  if (typeof opts["cloudflare-proxied"] !== "boolean") {
    errors.push(":cloudflare-proxied must be true or false");
  }
  if (opts["cloudflare-proxied"] === true) {
    errors.push(":cloudflare-proxied must be false; Cloudflare's proxy does not carry the PostgreSQL wire protocol");
  }

  if (!(placeholder(opts.profile) || profileRe.test(String(opts.profile)))) {
    errors.push(":profile must be a safe 1-63 character name");
  }

  if (opts["cluster-nodes"] !== utils.nodeCount) {
    errors.push(`:cluster-nodes must be ${utils.nodeCount}; the topology colocates a ` +
      "quorum store on the database nodes and cannot elect with fewer");
  }

  if (String(opts["digitalocean-vpc-mode"]) !== "default") {
    errors.push(":digitalocean-vpc-mode must be default; the regional default VPC is discovered at runtime");
  }
  for (const key of forbiddenVpcKeys) {
    if (Object.hasOwn(opts, key)) {
      errors.push(`:${key} must not be configured; the regional default VPC is discovered at runtime`);
    }
  }

  for (const key of ["cluster-host", "cloudflare-zone"]) {
    const value = opts[key];
    if (!placeholder(value) && !dnsRe.test(String(value))) {
      errors.push(`:${key} must be a DNS name`);
    }
  }
  {
    const host = opts["cluster-host"];
    const zone = opts["cloudflare-zone"];
    if (!placeholder(host) && !placeholder(zone) &&
        !(String(host) === String(zone) || String(host).endsWith(`.${zone}`))) {
      errors.push(":cluster-host must be inside :cloudflare-zone");
    }
  }

  for (const key of ["digitalocean-ssh-sources", "digitalocean-client-sources"]) {
    const values = opts[key];
    if (!Array.isArray(values) || values.length === 0 ||
        values.some((value) => !validCidr(value))) {
      errors.push(`:${key} must be a non-empty list of IPv4 CIDRs`);
    }
  }
  for (const key of ["digitalocean-ssh-sources", "digitalocean-client-sources"]) {
    const values = opts[key];
    if (Array.isArray(values) && values.some((value) => String(value) === "0.0.0.0/0")) {
      errors.push(`:${key} must not contain 0.0.0.0/0; administrative and database ingress stay scoped`);
    }
  }

  if (!positiveInt(opts["postgres-version"])) {
    errors.push(":postgres-version must be a PostgreSQL major version integer such as 17");
  }
  if (typeof opts["postgres-version"] === "number" &&
      Number.isInteger(opts["postgres-version"]) && opts["postgres-version"] < 15) {
    errors.push(":postgres-version must be 15 or later; the topology relies on quorum synchronous commit and pg_rewind");
  }

  for (const key of ["patroni-package-version", "pgbackrest-package-version"]) {
    const value = opts[key];
    if (!placeholder(value) && !debVersionRe.test(String(value))) {
      errors.push(`:${key} must be a full Debian package version such as 4.1.5-1.pgdg24.04+1`);
    }
  }
  if (!(placeholder(opts["etcd-version"]) ||
        etcdVersionRe.test(String(opts["etcd-version"])))) {
    errors.push(":etcd-version must be an exact vX.Y.Z release tag");
  }
  if (!(placeholder(opts["etcd-sha256"]) ||
        sha256Re.test(String(opts["etcd-sha256"])))) {
    errors.push(":etcd-sha256 must be the lowercase hex SHA-256 of the linux-amd64 release tarball");
  }
  if (!(placeholder(opts["haproxy-version"]) ||
        /^[0-9]+\.[0-9]+$/.test(String(opts["haproxy-version"])))) {
    errors.push(":haproxy-version must be a distribution major.minor series such as 2.8");
  }

  for (const key of ["postgres-database", "postgres-admin-user", "postgres-replication-user"]) {
    const value = opts[key];
    if (!placeholder(value) && !identifierRe.test(String(value))) {
      errors.push(`:${key} must be an unquoted lowercase SQL identifier`);
    }
  }
  if (!placeholder(opts["postgres-admin-user"]) &&
      String(opts["postgres-admin-user"]) === String(opts["postgres-replication-user"])) {
    errors.push(":postgres-replication-user must differ from :postgres-admin-user");
  }

  if (!(placeholder(opts["backup-stanza"]) ||
        stanzaRe.test(String(opts["backup-stanza"])))) {
    errors.push(":backup-stanza must be a short lowercase pgBackRest stanza name");
  }
  if (!(placeholder(opts["backup-r2-endpoint"]) ||
        httpsRe.test(String(opts["backup-r2-endpoint"])))) {
    errors.push(":backup-r2-endpoint must be an https:// origin");
  }
  if (!(placeholder(opts["backup-r2-prefix"]) ||
        prefixRe.test(String(opts["backup-r2-prefix"])))) {
    errors.push(":backup-r2-prefix must be a relative object-key prefix");
  }
  if (!placeholder(opts["backup-r2-bucket"]) && !placeholder(opts["r2-bucket"]) &&
      String(opts["backup-r2-bucket"]) === String(opts["r2-bucket"])) {
    errors.push(":backup-r2-bucket must not be the OpenTofu state bucket; backups and state do not share a blast radius");
  }

  for (const key of ["cluster-nodes", "postgres-port", "patroni-ttl",
                     "patroni-loop-wait", "patroni-retry-timeout",
                     "patroni-synchronous-node-count", "backup-retention-full",
                     "restore-check-max-age-hours", "restore-check-max-lag-seconds",
                     "heartbeat-retention-days", "cloudflare-record-ttl",
                     ...exclusivePortKeys]) {
    if (!positiveInt(opts[key])) errors.push(`:${key} must be a positive integer`);
  }
  errors.push(...distinctPortErrors(opts));

  {
    const ttl = typeof opts["cloudflare-record-ttl"] === "number"
      ? opts["cloudflare-record-ttl"] : 0;
    if (!(ttl === 1 || (60 <= ttl && ttl <= 86400))) {
      errors.push(":cloudflare-record-ttl must be 1 (automatic) or between 60 and 86400");
    }
  }

  {
    const count = typeof opts["patroni-synchronous-node-count"] === "number"
      ? opts["patroni-synchronous-node-count"] : 0;
    if (!(0 < count && count < utils.nodeCount)) {
      errors.push(`:patroni-synchronous-node-count must be between 1 and ${utils.nodeCount - 1}; ` +
        "requiring every standby to acknowledge stalls writes when one node is lost");
    }
  }
  {
    const loopWait = opts["patroni-loop-wait"];
    const ttl = opts["patroni-ttl"];
    if (!(typeof loopWait === "number" && Number.isInteger(loopWait) &&
          typeof ttl === "number" && Number.isInteger(ttl) &&
          2 * loopWait < ttl)) {
      errors.push(":patroni-ttl must exceed twice :patroni-loop-wait, or the leader lock can expire between health checks");
    }
  }

  for (const key of ["backup-oncalendar", "restore-check-oncalendar", "heartbeat-oncalendar"]) {
    const value = opts[key];
    if (!placeholder(value) && !oncalendarRe.test(String(value))) {
      errors.push(`:${key} must be a systemd OnCalendar expression`);
    }
  }

  {
    const lag = typeof opts["restore-check-max-lag-seconds"] === "number"
      ? opts["restore-check-max-lag-seconds"] : 0;
    if (!(120 < lag)) {
      errors.push(":restore-check-max-lag-seconds must exceed 120; below that it " +
        "fails on a healthy cluster, because a segment is only archived " +
        "once archive_timeout elapses");
    }
  }

  return errors;
}

export function secretErrors(opts: Opts, selected: string[] = slots): string[] {
  const keys = [...ownSecrets,
                ...selected.flatMap((slot) => entry(opts, slot)?.secrets ?? [])];
  return [...new Set(missing(opts, keys))]
    .map((key) => `required credential is not set: ${parName(key)}`);
}
