import json
from pathlib import Path

import pytest
from blue.workflow import StepError
from conftest import fixture
from package_once_blue import compute_cluster as cluster
from package_postgres_agy_blue import tools, validate

# A pre-adoption state exactly as `tofu output -json` parsed it: the four
# outputs, two parallel lists among them, and no `params`.
LEGACY_OUTPUTS = {
    "node_public_ips": ["203.0.113.1", "203.0.113.2", "203.0.113.3"],
    "node_private_ips": ["10.20.0.1", "10.20.0.2", "10.20.0.3"],
    "vpc_id": "5a6b7c8d-0000-4000-8000-000000000001",
    "vpc_ip_range": "10.20.0.0/20",
}


def recorded() -> dict:
    """`params` as the adopted template records it, here through the legacy
    translation so the two shapes are provably one."""
    return tools.legacy_params(fixture(), LEGACY_OUTPUTS)


def without(mapping: dict, key: str) -> dict:
    return {k: v for k, v in mapping.items() if k != key}


def converged() -> dict:
    return fixture({"once/cluster": recorded()})


def test_fallback_nodes_topology():
    # ONCE's fallbacks at offset 11, the package's names
    ns = tools.nodes(fixture())
    assert len(ns) == 3
    assert [n["name"] for n in ns] == ["postgres-agy-1", "postgres-agy-2", "postgres-agy-3"]
    assert [n["public-ip"] for n in ns] == ["192.0.2.11", "192.0.2.12", "192.0.2.13"]
    assert [n["private-ip"] for n in ns] == ["10.114.0.11", "10.114.0.12", "10.114.0.13"]
    assert [n["ordinal"] for n in ns] == [1, 2, 3]
    assert tools.data_fn(fixture())["vpc-cidr"] == "10.114.0.0/20"
    assert tools.nodes(fixture()) == ns


def test_the_aliases_are_the_standards():
    # Compute Cluster Standard §6: the bare profile reaches node 0, then
    # `<profile>-<index>`; `--node N` is 1-based and lands on index N-1.
    assert [n["alias"] for n in tools.nodes(fixture())] == \
        ["postgres-agy-fixture-0", "postgres-agy-fixture-1", "postgres-agy-fixture-2"]
    assert tools.ssh_alias(fixture(), 1) == "postgres-agy-fixture-0"
    assert tools.ssh_alias(fixture(), 3) == "postgres-agy-fixture-2"
    assert cluster.aliases(validate.spec, fixture())[1:] == [n["alias"] for n in tools.nodes(fixture())]


def test_a_real_run_reads_every_node_from_the_adopted_cluster():
    opts = converged()
    ns = tools.nodes(opts)
    assert [n["public-ip"] for n in ns] == ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    assert [n["private-ip"] for n in ns] == ["10.20.0.1", "10.20.0.2", "10.20.0.3"]
    assert [n["name"] for n in ns] == ["postgres-agy-1", "postgres-agy-2", "postgres-agy-3"]
    assert tools.data_fn(opts)["vpc-cidr"] == "10.20.0.0/20"
    inv = json.loads(tools.inventory(opts))
    assert inv["all"]["children"]["postgres"]["hosts"]["postgres-agy-2"]["ansible_host"] == "203.0.113.2"
    assert [n["public-ip"] for n in tools.dns_specs(opts)[0]["data"]["nodes"]] == \
        ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    assert [n["alias"] for n in tools.acceptance_specs(opts)[0]["data"]["nodes"]] == \
        ["postgres-agy-fixture-0", "postgres-agy-fixture-1", "postgres-agy-fixture-2"]


def test_the_legacy_state_is_translated_into_params():
    params = recorded()
    assert params["provider"] == "digitalocean"
    assert [n["index"] for n in params["nodes"]] == [0, 1, 2]
    assert all(n["role"] is None for n in params["nodes"])
    assert [n["name"] for n in params["nodes"]] == ["postgres-agy-1", "postgres-agy-2", "postgres-agy-3"]
    second = params["nodes"][1]
    assert {k: second[k] for k in ["ip", "vpc_ip", "user", "sudoer"]} == \
        {"ip": "203.0.113.2", "vpc_ip": "10.20.0.2", "user": "root", "sudoer": "root"}
    assert [params[k] for k in ["vpc_id", "vpc_ip_range"]] == \
        ["5a6b7c8d-0000-4000-8000-000000000001", "10.20.0.0/20"]
    # ONCE accepts the translation as a whole cluster
    assert not cluster.node_errors(validate.spec, fixture(), params)
    assert tools.params_errors(params) == []


def test_the_legacy_translation_refuses_to_guess():
    def refusal(outputs):
        with pytest.raises(StepError) as e:
            tools.legacy_params(fixture(), outputs)
        return str(e.value)

    # lists that disagree with each other; the SDK's StepError, so read_state
    # reports it
    assert refusal({**LEGACY_OUTPUTS, "node_public_ips": ["203.0.113.1", "203.0.113.2"]}) == \
        "legacy state lists 2 public addresses and 3 private addresses; refusing to guess the cluster"
    # lists that disagree with cluster-nodes
    four = {k: [*LEGACY_OUTPUTS[k], LEGACY_OUTPUTS[k][-1]] for k in ["node_public_ips", "node_private_ips"]}
    assert refusal({**LEGACY_OUTPUTS, **four}) == \
        "legacy state lists 4 public addresses and 4 private addresses; refusing to guess the cluster"
    # no network
    assert refusal(without(LEGACY_OUTPUTS, "vpc_id")) == "legacy state carries no vpc_id"
    assert refusal({**LEGACY_OUTPUTS, "vpc_id": " "}) == "legacy state carries no vpc_id"
    assert refusal(without(LEGACY_OUTPUTS, "vpc_ip_range")) == "legacy state carries no vpc_ip_range"
    # the range's form is params_errors' to refuse, the same as a recorded state
    assert tools.params_errors(tools.legacy_params(fixture(), {**LEGACY_OUTPUTS, "vpc_ip_range": "10.20.0.1/20"})) == \
        ['compute state vpc_ip_range "10.20.0.1/20" is not a canonical IPv4 network such as 10.40.0.0/24']


def test_params_errors_hold_the_extension_keys():
    params = recorded()
    assert tools.params_errors(params) == []
    assert tools.params_errors(without(params, "vpc_id")) == ["compute state carries no vpc_id"]
    assert tools.params_errors({**params, "vpc_id": " "}) == ["compute state carries no vpc_id"]
    assert tools.params_errors({**params, "vpc_ip_range": None}) == ["compute state carries no vpc_ip_range"]
    assert tools.params_errors({**params, "vpc_ip_range": "10.20.0.1/20"}) == \
        ['compute state vpc_ip_range "10.20.0.1/20" is not a canonical IPv4 network such as 10.40.0.0/24']
    assert tools.params_errors({}) == ["compute state carries no vpc_id", "compute state carries no vpc_ip_range"]


async def test_load_infrastructure_adopts_the_state_preflight_handed_on():
    params = recorded()

    async def load(state):
        return await tools.load_infrastructure_step(
            fixture({"blue/event": "delete", "postgres-agy/state": state}))

    # a recorded cluster
    r = await load({"params": params})
    assert r["blue/exit"] == 0
    assert r["once/cluster"] == params
    assert r["postgres-agy/infrastructure-present?"] is True
    assert "postgres-agy/state" not in r
    assert [n["public-ip"] for n in tools.nodes(r)] == ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    # a readable state that records no cluster leaves nothing to clean up
    r = await load({"params": None})
    assert r["blue/exit"] == 0
    assert r["postgres-agy/infrastructure-present?"] is False
    assert "once/cluster" not in r
    # an unreadable backend fails closed
    r = await load({"error": "tofu output failed: no backend"})
    assert r["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in r["blue/err"]
    assert "no backend" in r["blue/err"]
    # a partial cluster is refused with ONCE's message
    r = await load({"params": {**params, "nodes": params["nodes"][:2]}})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "the compute stage did not report nodes this package declares: 2"
    # an adopted cluster without its extension keys is refused
    r = await load({"params": without(params, "vpc_id")})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "compute state carries no vpc_id"


def test_a_real_create_resolves_the_cluster_from_the_apply():
    # the apply's `params` output is what every later stage reads; never the
    # fallbacks
    params = recorded()
    opts = fixture({"blue/event": "create"})

    def apply(p):
        result = {**opts, "blue/exit": 0}
        if p is not None:
            result["postgres-agy/outputs"] = {"params": p}
        return tools.resolve_infrastructure(opts, result)

    r = apply(params)
    assert r["blue/exit"] == 0
    assert r["once/cluster"] == params
    assert [n["public-ip"] for n in tools.nodes(r)] == ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    r = apply(None)
    assert r["blue/exit"] == 1
    assert r["blue/err"] == cluster.NO_PARAMS_MESSAGE
    r = apply({**params, "nodes": params["nodes"][:2]})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "the compute stage did not report nodes this package declares: 2"
    r = apply(without(params, "vpc_ip_range"))
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "compute state carries no vpc_ip_range"
    # a failed apply, a delete and a build hand the result on untouched
    assert tools.resolve_infrastructure(opts, {**opts, "blue/exit": 1, "blue/err": "apply failed"})["blue/exit"] == 1
    assert "once/cluster" not in tools.resolve_infrastructure({**opts, "blue/event": "build"}, {**opts, "blue/exit": 0})
    assert tools.resolve_infrastructure({**opts, "blue/event": "delete"}, {**opts, "blue/exit": 0})["blue/exit"] == 0


def test_the_local_play_receives_one_block_of_aliases():
    # ssh-config.md: the addresses and the aliases are extra-vars, never
    # rendered; the marker is the profile; the bare profile reaches node 0
    variables = tools.ansible_local_extra_vars({**converged(), "blue/event": "create"})
    assert variables["host_alias"] == "postgres-agy-fixture"
    assert variables["ssh_hosts"] == [
        {"name": "postgres-agy-fixture", "ip": "203.0.113.1"},
        {"name": "postgres-agy-fixture-0", "ip": "203.0.113.1"},
        {"name": "postgres-agy-fixture-1", "ip": "203.0.113.2"},
        {"name": "postgres-agy-fixture-2", "ip": "203.0.113.3"},
    ]
    assert variables["block_state"] == "present"
    assert variables["ssh_private_key"] == "~/.ssh/id_ed25519"
    # the pre-standard per-node blocks are named so the play can remove them
    assert variables["legacy_aliases"] == ["postgres-agy-fixture-1", "postgres-agy-fixture-2", "postgres-agy-fixture-3"]
    assert tools.ansible_local_extra_vars(fixture({"blue/event": "delete"}))["block_state"] == "absent"
    # a build renders the play without an address
    rendered = (Path(tools.ROOT) / "tools/ansible-local/main.yml").read_text()
    assert 'marker: "# {mark} {{ host_alias }} ANSIBLE MANAGED BLOCK"' in rendered
    assert "{% for host in ssh_hosts %}" in rendered
    assert "insertbefore: BOF" in rendered
    assert "192.0.2" not in rendered and "203.0.113" not in rendered


def test_infrastructure_specs_render():
    specs = tools.infrastructure_specs(fixture())
    assert len(specs) == 1
    assert specs[0]["template"]["name"] == "infrastructure/main.tf"


def test_dns_specs_render():
    specs = tools.dns_specs(fixture())
    assert len(specs) == 1
    assert specs[0]["template"]["name"] == "dns/main.tf"


def test_cluster_specs_include_all_required_templates():
    specs = tools.cluster_specs(fixture())
    templates = {spec["template"]["name"] for spec in specs if "template" in spec}
    for name in ["ansible-remote/main.yml", "ansible-remote/etcd.service.j2",
                 "ansible-remote/patroni.yml.j2", "ansible-remote/haproxy.cfg.j2",
                 "ansible-remote/pgbackrest.conf.j2",
                 "ansible-remote/postgres-agy-heartbeat.service.j2",
                 "ansible-remote/postgres-agy-restore-check.service.j2"]:
        assert name in templates, name
