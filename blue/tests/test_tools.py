from conftest import fixture
from package_postgres_agy_blue import tools


def test_fallback_nodes_topology():
    ns = tools.nodes(fixture())
    assert len(ns) == 3
    assert ns[0]["name"] == "postgres-agy-1"
    assert ns[0]["public-ip"] == "192.0.2.11"
    assert ns[0]["private-ip"] == "10.114.0.11"


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
