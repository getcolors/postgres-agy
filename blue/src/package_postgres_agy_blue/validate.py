"""Credential-free desired-state validation, and the provider registry it uses
— the port of io.github.getcolors.postgres-agy.validate.

The registry is package-owned rather than inherited: this package provisions
three droplets, its own firewall and its own DNS record set. Keeping the table
here means one place describes what a provider choice requires, what it needs
as a credential, and which of those credentials OpenTofu reads natively from
the environment.

Every check accumulates. A run reports all of a file's problems at once with
exit 2, because fixing desired state one error per invocation is how a person
gives up on a config file.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml."""

from __future__ import annotations

import re

from blue.cli import par_name

from . import utils

providers = {
    "provider-compute": {
        "digitalocean": {
            "required": ["digitalocean-name", "digitalocean-region", "digitalocean-size",
                         "digitalocean-image", "digitalocean-ssh-keys",
                         "digitalocean-ssh-private-key", "digitalocean-ssh-sources",
                         "digitalocean-client-sources", "digitalocean-vpc-mode"],
            "secrets": ["do-token"],
            "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
        },
    },

    "provider-dns": {
        "cloudflare": {
            "required": ["cloudflare-zone", "cloudflare-proxied", "cloudflare-record-ttl",
                         "cluster-host"],
            "secrets": ["cloudflare-api-token"],
            "tofu-env": {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"},
        },
    },

    "provider-backend": {
        "local": {"required": [], "secrets": [], "tofu-env": {}},
        "s3": {
            "required": ["s3-bucket", "s3-region"],
            "secrets": ["s3-access-key-id", "s3-secret-access-key"],
            "tofu-env": {"s3-access-key-id": "AWS_ACCESS_KEY_ID",
                         "s3-secret-access-key": "AWS_SECRET_ACCESS_KEY"},
        },
        "r2": {
            "required": ["r2-bucket", "r2-endpoint"],
            "secrets": ["r2-access-key-id", "r2-secret-access-key"],
            "tofu-env": {"r2-access-key-id": "AWS_ACCESS_KEY_ID",
                         "r2-secret-access-key": "AWS_SECRET_ACCESS_KEY"},
        },
    },
}

slots = ["provider-compute", "provider-dns", "provider-backend"]
profile_par = par_name("profile")

own_required = [
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
]

own_secrets = [
    "postgres-admin-password", "postgres-replication-password",
    "backup-r2-access-key-id", "backup-r2-secret-access-key",
]

forbidden_vpc_keys = [
    "digitalocean-vpc-id", "digitalocean-vpc-uuid", "digitalocean-vpc-cidr",
    "digitalocean-vpc-name", "digitalocean-vpc",
]


def placeholder(x) -> bool:
    return x is None or (isinstance(x, str) and (not x.strip() or x.upper() == "REPLACE_ME"))


def entry(opts: dict, slot: str) -> dict | None:
    return providers.get(slot, {}).get(opts.get(slot))


def tofu_env(opts: dict, slot: str) -> dict:
    return (entry(opts, slot) or {}).get("tofu-env", {})


def _slot_keys(opts: dict, field: str) -> list[str]:
    return [key for slot in slots for key in (entry(opts, slot) or {}).get(field, [])]


def _missing(opts: dict, keys) -> list[str]:
    return [key for key in keys if placeholder(opts.get(key))]


def env_errors(env: dict) -> list[str]:
    if str(env.get(profile_par) or ""):
        return [f"{profile_par} is set. postgres-agy takes profile from colors.yml only; "
                "an environment overlay could point this deployment at another's "
                "remote state and backup repository."]
    return []


_DNS_RE = re.compile(
    r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$")
_CIDR_RE = re.compile(r"^(?:[0-9]{1,3}\.){3}[0-9]{1,3}/(?:[0-9]|[12][0-9]|3[0-2])$")
_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
_IDENTIFIER_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
_STANZA_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_ETCD_VERSION_RE = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")
_DEB_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.+~:-]+$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ONCALENDAR_RE = re.compile(r"^[A-Za-z0-9 *,./:-]+$")
_HTTPS_RE = re.compile(r"^https://[A-Za-z0-9.-]+(?::[0-9]+)?/?$")
_PREFIX_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
_HAPROXY_RE = re.compile(r"^[0-9]+\.[0-9]+$")


def valid_cidr(value) -> bool:
    s = str(value)
    if not _CIDR_RE.fullmatch(s):
        return False
    return all(int(octet) <= 255 for octet in s.split("/")[0].split("."))


def _positive_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x > 0


def _is_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _pr_str(value) -> str:
    """pr-str, for the unsupported-provider message: green prints the offending
    value through pr-str, which quotes strings and renders nil bare."""
    if value is None:
        return "nil"
    if isinstance(value, str):
        return '"%s"' % value.replace("\\", "\\\\").replace('"', '\\"')
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


_EXCLUSIVE_PORT_KEYS = [
    "patroni-rest-port", "etcd-client-port", "etcd-peer-port",
    "haproxy-primary-port", "haproxy-replica-port", "haproxy-stats-port",
    "restore-check-port",
]


def _distinct_port_errors(opts: dict) -> list[str]:
    ports = [(key, opts[key]) for key in _EXCLUSIVE_PORT_KEYS if _is_int(opts.get(key))]
    groups: dict[int, list[str]] = {}
    for key, value in ports:
        groups.setdefault(value, []).append(key)
    dupes = sorted(((port, keys) for port, keys in groups.items() if len(keys) > 1),
                   key=lambda pair: pair[0])
    pg = opts.get("postgres-port")
    shadowed = ([key for key, value in ports
                 if value == pg and key != "haproxy-primary-port"]
                if _is_int(pg) else [])
    return ([f"port {port} is claimed by {' and '.join(keys)}; "
             "every listener on a node needs its own port"
             for port, keys in dupes]
            + [f":{key} must differ from :postgres-port" for key in sorted(shadowed)])


def state_errors(opts: dict) -> list[str]:
    errors: list[str] = []

    for key in _missing(opts, [*own_required, *_slot_keys(opts, "required")]):
        errors.append(f":{key} is required")

    for slot in slots:
        if opts.get(slot) not in providers[slot]:
            errors.append(f"unsupported :{slot} {_pr_str(opts.get(slot))}")

    if opts.get("provider-compute") != "digitalocean":
        errors.append(":provider-compute must be digitalocean")
    if opts.get("provider-dns") != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if not isinstance(opts.get("compute-prevent-destroy"), bool):
        errors.append(":compute-prevent-destroy must be true or false")
    if not isinstance(opts.get("cloudflare-proxied"), bool):
        errors.append(":cloudflare-proxied must be true or false")
    if opts.get("cloudflare-proxied") is True:
        errors.append(":cloudflare-proxied must be false; Cloudflare's proxy does not carry the PostgreSQL wire protocol")

    if not (placeholder(opts.get("profile")) or _PROFILE_RE.fullmatch(str(opts.get("profile")))):
        errors.append(":profile must be a safe 1-63 character name")

    if opts.get("cluster-nodes") != utils.NODE_COUNT:
        errors.append(f":cluster-nodes must be {utils.NODE_COUNT}; the topology colocates a "
                      "quorum store on the database nodes and cannot elect with fewer")

    if str(opts.get("digitalocean-vpc-mode")) != "default":
        errors.append(":digitalocean-vpc-mode must be default; the regional default VPC is discovered at runtime")
    for key in forbidden_vpc_keys:
        if key in opts:
            errors.append(f":{key} must not be configured; the regional default VPC is discovered at runtime")

    for key in ["cluster-host", "cloudflare-zone"]:
        value = opts.get(key)
        if not placeholder(value) and not _DNS_RE.fullmatch(str(value)):
            errors.append(f":{key} must be a DNS name")
    host, zone = opts.get("cluster-host"), opts.get("cloudflare-zone")
    if (not placeholder(host) and not placeholder(zone)
            and not (str(host) == str(zone) or str(host).endswith(f".{zone}"))):
        errors.append(":cluster-host must be inside :cloudflare-zone")

    for key in ["digitalocean-ssh-sources", "digitalocean-client-sources"]:
        values = opts.get(key)
        if (not isinstance(values, list) or not values
                or any(not valid_cidr(value) for value in values)):
            errors.append(f":{key} must be a non-empty list of IPv4 CIDRs")
    for key in ["digitalocean-ssh-sources", "digitalocean-client-sources"]:
        values = opts.get(key)
        if isinstance(values, list) and any(str(value) == "0.0.0.0/0" for value in values):
            errors.append(f":{key} must not contain 0.0.0.0/0; administrative and database ingress stay scoped")

    if not _positive_int(opts.get("postgres-version")):
        errors.append(":postgres-version must be a PostgreSQL major version integer such as 17")
    if _is_int(opts.get("postgres-version")) and opts["postgres-version"] < 15:
        errors.append(":postgres-version must be 15 or later; the topology relies on quorum synchronous commit and pg_rewind")

    for key in ["patroni-package-version", "pgbackrest-package-version"]:
        value = opts.get(key)
        if not placeholder(value) and not _DEB_VERSION_RE.fullmatch(str(value)):
            errors.append(f":{key} must be a full Debian package version such as 4.1.5-1.pgdg24.04+1")
    if not (placeholder(opts.get("etcd-version"))
            or _ETCD_VERSION_RE.fullmatch(str(opts.get("etcd-version")))):
        errors.append(":etcd-version must be an exact vX.Y.Z release tag")
    if not (placeholder(opts.get("etcd-sha256"))
            or _SHA256_RE.fullmatch(str(opts.get("etcd-sha256")))):
        errors.append(":etcd-sha256 must be the lowercase hex SHA-256 of the linux-amd64 release tarball")
    if not (placeholder(opts.get("haproxy-version"))
            or _HAPROXY_RE.fullmatch(str(opts.get("haproxy-version")))):
        errors.append(":haproxy-version must be a distribution major.minor series such as 2.8")

    for key in ["postgres-database", "postgres-admin-user", "postgres-replication-user"]:
        value = opts.get(key)
        if not placeholder(value) and not _IDENTIFIER_RE.fullmatch(str(value)):
            errors.append(f":{key} must be an unquoted lowercase SQL identifier")
    if (not placeholder(opts.get("postgres-admin-user"))
            and str(opts.get("postgres-admin-user")) == str(opts.get("postgres-replication-user"))):
        errors.append(":postgres-replication-user must differ from :postgres-admin-user")

    if not (placeholder(opts.get("backup-stanza"))
            or _STANZA_RE.fullmatch(str(opts.get("backup-stanza")))):
        errors.append(":backup-stanza must be a short lowercase pgBackRest stanza name")
    if not (placeholder(opts.get("backup-r2-endpoint"))
            or _HTTPS_RE.fullmatch(str(opts.get("backup-r2-endpoint")))):
        errors.append(":backup-r2-endpoint must be an https:// origin")
    if not (placeholder(opts.get("backup-r2-prefix"))
            or _PREFIX_RE.fullmatch(str(opts.get("backup-r2-prefix")))):
        errors.append(":backup-r2-prefix must be a relative object-key prefix")
    if (not placeholder(opts.get("backup-r2-bucket")) and not placeholder(opts.get("r2-bucket"))
            and str(opts.get("backup-r2-bucket")) == str(opts.get("r2-bucket"))):
        errors.append(":backup-r2-bucket must not be the OpenTofu state bucket; backups and state do not share a blast radius")

    for key in ["cluster-nodes", "postgres-port", "patroni-ttl",
                "patroni-loop-wait", "patroni-retry-timeout",
                "patroni-synchronous-node-count", "backup-retention-full",
                "restore-check-max-age-hours", "restore-check-max-lag-seconds",
                "heartbeat-retention-days", "cloudflare-record-ttl",
                *_EXCLUSIVE_PORT_KEYS]:
        if not _positive_int(opts.get(key)):
            errors.append(f":{key} must be a positive integer")
    errors.extend(_distinct_port_errors(opts))

    ttl = opts.get("cloudflare-record-ttl")
    ttl = ttl if _is_int(ttl) else 0
    if not (ttl == 1 or 60 <= ttl <= 86400):
        errors.append(":cloudflare-record-ttl must be 1 (automatic) or between 60 and 86400")

    count = opts.get("patroni-synchronous-node-count")
    count = count if _is_int(count) else 0
    if not (0 < count < utils.NODE_COUNT):
        errors.append(f":patroni-synchronous-node-count must be between 1 and {utils.NODE_COUNT - 1}; "
                      "requiring every standby to acknowledge stalls writes when one node is lost")
    loop_wait, patroni_ttl = opts.get("patroni-loop-wait"), opts.get("patroni-ttl")
    if not (_is_int(loop_wait) and _is_int(patroni_ttl) and 2 * loop_wait < patroni_ttl):
        errors.append(":patroni-ttl must exceed twice :patroni-loop-wait, or the leader lock can expire between health checks")

    for key in ["backup-oncalendar", "restore-check-oncalendar", "heartbeat-oncalendar"]:
        value = opts.get(key)
        if not placeholder(value) and not _ONCALENDAR_RE.fullmatch(str(value)):
            errors.append(f":{key} must be a systemd OnCalendar expression")

    lag = opts.get("restore-check-max-lag-seconds")
    lag = lag if _is_int(lag) else 0
    if not 120 < lag:
        errors.append(":restore-check-max-lag-seconds must exceed 120; below that it "
                      "fails on a healthy cluster, because a segment is only archived "
                      "once archive_timeout elapses")

    return errors


def secret_errors(opts: dict, selected: list[str] | None = None) -> list[str]:
    selected = slots if selected is None else selected
    keys = [*own_secrets,
            *[key for slot in selected for key in (entry(opts, slot) or {}).get("secrets", [])]]
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(_missing(opts, keys))]
