"""The five stages: DigitalOcean infrastructure, Cloudflare DNS, local SSH
configuration, the remote cluster convergence, and acceptance — the port of
io.github.getcolors.postgres-agy.tools.

Every stage renders into `.colors/<profile>/<stage>/` and, for the OpenTofu
ones, keys its remote state at `<profile>/<stage>.tfstate`. Those two names
are the deployment's identity; changing either orphans live infrastructure,
so they are constants here and asserted by the golden suite."""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.providers import tool_env
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from blue.workflow import StepError, failed

from . import utils, validate

infrastructure_tool = "postgres-agy-infrastructure"
dns_tool = "postgres-agy-dns"
ansible_local_tool = "postgres-agy-ansible-local"
cluster_tool = "postgres-agy-cluster"
acceptance_tool = "postgres-agy-acceptance"
tofu_tools = [infrastructure_tool, dns_tool]

ROOT = Path(__file__).parent / "resources"
template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="postgres-agy")


def template(path: str, file: str) -> dict:
    name = f"{path.replace('.', '/')}/{file}"
    source = ROOT / "tools" / name
    if not source.is_file():
        raise StepError(f"template not found: {name}")
    return {"name": name, "content": source.read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    return tool_env(validate.providers, opts, [*slots, "provider-backend"])


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return credential_env(opts)


def cidrs(opts: dict, key: str) -> list[str]:
    value = opts.get(key)
    xs = value if isinstance(value, list) else re.split(r"[,\s]+", str(value))
    return [s for s in (str(x).strip() for x in xs) if s]


# ---------------------------------------------------------------------------
# Placeholder topology

fallback_outputs = {
    "vpc_id": "00000000-0000-0000-0000-000000000000",
    "vpc_ip_range": "10.114.0.0/20",
    "node_public_ips": ["192.0.2.11", "192.0.2.12", "192.0.2.13"],
    "node_private_ips": ["10.114.0.11", "10.114.0.12", "10.114.0.13"],
}


def _output_map(result: dict) -> dict | None:
    return result.get("postgres-agy/outputs")


def nodes(opts: dict) -> list[dict]:
    """The rendered topology: one map per ordinal, joined with whatever
    addresses the infrastructure stage produced (or the placeholders, before
    it has run)."""
    fallback_public = fallback_outputs["node_public_ips"]
    fallback_private = fallback_outputs["node_private_ips"]
    public = list(opts.get("node_public_ips") or fallback_public)
    private = list(opts.get("node_private_ips") or fallback_private)
    result = []
    for n in utils.ordinals():
        i = n - 1
        result.append({
            "ordinal": n,
            "name": utils.node_name(opts, n),
            "alias": utils.ssh_alias(opts, n),
            "public-ip": public[i] if i < len(public) else fallback_public[i],
            "private-ip": private[i] if i < len(private) else fallback_private[i],
        })
    return result


# ---------------------------------------------------------------------------
# Stage 1 — infrastructure

def infrastructure_data(opts: dict) -> dict:
    return {**opts,
            "node-names-hcl": tofu.hcl_list([utils.node_name(opts, n) for n in utils.ordinals()]),
            "ssh-keys-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-ssh-keys")),
            "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-ssh-sources")),
            "client-sources-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-client-sources"))}


def infrastructure_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, infrastructure_tool)
    return [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf",
                 infrastructure_data(opts))]


async def infrastructure_step(opts: dict) -> dict:
    result = await tofu.tofu_with_spec(
        opts, infrastructure_specs(opts),
        dir=tool_dir(opts, infrastructure_tool),
        env=credential_env(opts, "provider-compute"),
        output_key="postgres-agy/outputs")
    if failed(result):
        return result
    if opts.get("blue/event") == "delete":
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_outputs}
    return {**result, **fallback_outputs, **(_output_map(result) or {})}


async def load_infrastructure_step(opts: dict) -> dict:
    """Read node addresses out of remote state without planning or mutating
    cloud resources."""
    dir = tool_dir(opts, infrastructure_tool)
    rendered = {**scaffold({**opts, "blue/event": "build"}, infrastructure_specs(opts)),
                "blue/event": opts.get("blue/event")}
    credentials = credential_env(opts, "provider-compute")
    init = await runtime.exec(
        ["tofu", f"-chdir={dir}", "init", "-input=false", "-no-color"],
        env=credentials)
    if init.exit != 0:
        return process_result(rendered, "infrastructure state initialization", init)
    try:
        outputs = await tofu.outputs(dir, credentials)
        return {**rendered, **fallback_outputs, **outputs,
                "postgres-agy/infrastructure-present?": "node_public_ips" in outputs}
    except Exception as t:  # noqa: BLE001 — mirror green's Throwable net
        return {**rendered, "blue/exit": 1,
                "blue/err": f"infrastructure state output failed: {t or type(t).__name__}"}


# ---------------------------------------------------------------------------
# Stage 2 — DNS

def dns_data(opts: dict) -> dict:
    return {**opts, "nodes": nodes(opts)}


def dns_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, dns_tool)
    return [spec(template("dns", "main.tf"), f"{dir}/main.tf", dns_data(opts))]


async def dns_step(opts: dict) -> dict:
    return await tofu.tofu_with_spec(
        opts, dns_specs(opts),
        dir=tool_dir(opts, dns_tool),
        env=credential_env(opts, "provider-dns"),
        output_key="postgres-agy/dns-outputs")


# ---------------------------------------------------------------------------
# Shared render data

def data_fn(opts: dict) -> dict:
    ns = nodes(opts)
    etcd_version = opts.get("etcd-version")
    return {**opts,
            "nodes": ns,
            "first-node": ns[0],
            "vpc-cidr": opts.get("vpc_ip_range") or fallback_outputs["vpc_ip_range"],
            "ssh-private-key": str(opts.get("digitalocean-ssh-private-key") or ""),
            "backup-r2-s3-endpoint": utils.endpoint_host(opts.get("backup-r2-endpoint")),
            "backup-repo-path": utils.repo_path(opts.get("backup-r2-prefix")),
            "etcd-tarball": f"etcd-{etcd_version}-linux-amd64.tar.gz",
            "etcd-url": ("https://github.com/etcd-io/etcd/releases/download/"
                         f"{etcd_version}/etcd-{etcd_version}-linux-amd64.tar.gz"),
            "postgres-data-dir": f"/var/lib/postgresql/{opts.get('postgres-version')}/main",
            "postgres-bin-dir": f"/usr/lib/postgresql/{opts.get('postgres-version')}/bin",
            "admin-password-lookup": utils.par_lookup("postgres-admin-password"),
            "replication-password-lookup": utils.par_lookup("postgres-replication-password"),
            "backup-key-lookup": utils.par_lookup("backup-r2-access-key-id"),
            "backup-secret-lookup": utils.par_lookup("backup-r2-secret-access-key")}


# ---------------------------------------------------------------------------
# Stage 3 — local SSH configuration

def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = data_fn(opts)
    return [spec(template("ansible-local", "ansible.cfg"), f"{dir}/ansible.cfg", data),
            spec(template("ansible-local", "inventory.ini"), f"{dir}/inventory.ini", data),
            spec(template("ansible-local", "main.yml"), f"{dir}/main.yml", data)]


async def ansible_local_step(opts: dict) -> dict:
    data = data_fn(opts)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts,
        ansible_local_specs(opts),
        dir=tool_dir(opts, ansible_local_tool),
        inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={
            "block_state": "absent" if delete else "present",
            "nodes": [{"alias": node["alias"], "public-ip": node["public-ip"],
                       "ordinal": node["ordinal"]}
                      for node in data["nodes"]],
            "ssh_private_key": data["ssh-private-key"],
        })


# ---------------------------------------------------------------------------
# Stage 4 — the cluster itself

def _java_double(x: float) -> str:
    """Java's Double.toString, which is what Green's cheshire JSON emits for
    floats: decimal between 1e-3 and 1e7, `d.dddE±e` scientific outside it.
    Python's own repr disagrees exactly where scientific notation starts
    (0.0001 -> "1.0E-4"), and the goldens carry the Java form."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    negative = math.copysign(1.0, x) < 0
    magnitude = abs(x)
    if magnitude == 0.0:
        return "-0.0" if negative else "0.0"
    _sign, digits, exponent = Decimal(repr(magnitude)).as_tuple()
    digit_str = "".join(map(str, digits)).rstrip("0") or "0"
    dec_exp = exponent + len(digits) - 1
    if -3 <= dec_exp < 7:
        if dec_exp >= 0:
            whole = digit_str[:dec_exp + 1].ljust(dec_exp + 1, "0")
            frac = digit_str[dec_exp + 1:] or "0"
        else:
            whole = "0"
            frac = "0" * (-dec_exp - 1) + digit_str
        rendered = f"{whole}.{frac}"
    else:
        mantissa = digit_str[0] + "." + (digit_str[1:] or "0")
        rendered = f"{mantissa}E{dec_exp}"
    return ("-" if negative else "") + rendered


def _pretty(value, indent=0):
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract."""
    if isinstance(value, list):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    if isinstance(value, float) and not isinstance(value, bool):
        return _java_double(value)
    return json.dumps(value)


def inventory(opts: dict) -> str:
    data = data_fn(opts)
    # Green builds the hosts as a sorted-map; plain byte-order comparison is
    # Clojure's `compare` for strings, so no locale-dependent collation here.
    hosts = {str(node["name"]): {"ansible_host": node["public-ip"],
                                 "ansible_user": "root",
                                 "private_ip": node["private-ip"],
                                 "node_ordinal": node["ordinal"]}
             for node in sorted(data["nodes"], key=lambda node: str(node["name"]))}
    return _pretty(
        {"all": {"children": {"postgres": {
            "hosts": hosts,
            "vars": {"ansible_ssh_private_key_file": data["ssh-private-key"]}}}}})


scheduled_work_templates = [
    "postgres-agy-heartbeat", "postgres-agy-heartbeat.service",
    "postgres-agy-heartbeat.timer",
    "postgres-agy-backup", "postgres-agy-backup.service", "postgres-agy-backup.timer",
    "postgres-agy-restore-check", "postgres-agy-restore-check.service",
    "postgres-agy-restore-check.timer",
]


def cluster_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, cluster_tool)
    data = data_fn(opts)
    return [
        spec(template("ansible-remote", "ansible.cfg"), f"{dir}/ansible.cfg", data),
        spec(template("ansible-remote", "main.yml"), f"{dir}/main.yml", data),
        spec(template("ansible-remote", "cleanup.yml"), f"{dir}/cleanup.yml", data),
        spec(template("ansible-remote", "etcd.conf.yml.j2"),
             f"{dir}/templates/etcd.conf.yml.j2", data),
        spec(template("ansible-remote", "etcd.service.j2"),
             f"{dir}/templates/etcd.service.j2", data),
        spec(template("ansible-remote", "patroni.yml.j2"),
             f"{dir}/templates/patroni.yml.j2", data),
        spec(template("ansible-remote", "patroni.service.j2"),
             f"{dir}/templates/patroni.service.j2", data),
        spec(template("ansible-remote", "haproxy.cfg.j2"),
             f"{dir}/templates/haproxy.cfg.j2", data),
        spec(template("ansible-remote", "pgbackrest.conf.j2"),
             f"{dir}/templates/pgbackrest.conf.j2", data),
        raw_spec(f"{dir}/inventory.json", inventory(opts)),
        *[spec(template("ansible-remote", f"{unit}.j2"),
               f"{dir}/templates/{unit}.j2", data)
          for unit in scheduled_work_templates],
    ]


async def cluster_step(opts: dict) -> dict:
    if (opts.get("blue/event") == "delete"
            and opts.get("postgres-agy/infrastructure-present?") is False):
        return scaffold(opts, cluster_specs(opts))
    return await ansible_with_spec(
        opts,
        cluster_specs(opts),
        dir=tool_dir(opts, cluster_tool),
        inventory="inventory.json",
        playbooks={"create": "main.yml", "delete": "cleanup.yml"},
        host_key_checking=False,
        recap_key="postgres-agy/cluster-recap")


# ---------------------------------------------------------------------------
# Stage 5 — acceptance

def acceptance_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, acceptance_tool)
    return [spec(template("acceptance", "acceptance.sh"),
                 f"{dir}/acceptance.sh", data_fn(opts))]


def process_result(opts: dict, label: str, result) -> dict:
    if result.exit == 0:
        return {**opts, "blue/exit": 0}
    return {**opts, "blue/exit": max(1, result.exit),
            "blue/err": f"{label} failed: {result.err or result.out or '(no output)'}"}


def acceptance_env(opts: dict) -> dict[str, str]:
    return {"PGPASSWORD": str(opts.get("postgres-admin-password") or "")}


async def acceptance_step(opts: dict) -> dict:
    rendered = scaffold(opts, acceptance_specs(opts))
    if opts.get("blue/event") != "create":
        return rendered
    result = await runtime.exec(
        ["bash", f"{tool_dir(opts, acceptance_tool)}/acceptance.sh"],
        env=acceptance_env(opts), timeout_ms=20 * 60 * 1000)
    if result.out:
        print(result.out)
    return process_result(rendered, "acceptance", result)


def generated_cleanup_step(opts: dict) -> dict:
    return scaffold(scaffold(opts, ansible_local_specs(opts)), acceptance_specs(opts))
