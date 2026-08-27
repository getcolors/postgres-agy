from conftest import fixture
from package_postgres_agy_blue import validate


def test_default_fixture_produces_no_errors():
    assert validate.state_errors(fixture()) == []


def test_profile_overlay_is_refused():
    assert validate.env_errors({"COLORS_PAR_PROFILE": "override"})
    assert validate.env_errors({}) == []


def test_missing_required_keys_are_reported():
    for key in ["profile", "digitalocean-name", "cluster-host"]:
        base = fixture()
        del base[key]
        assert validate.state_errors(base)


def test_cluster_nodes_must_be_3():
    assert validate.state_errors(fixture({"cluster-nodes": 2}))
    assert validate.state_errors(fixture({"cluster-nodes": 4}))
    assert validate.state_errors(fixture({"cluster-nodes": 3})) == []


def test_postgres_version_must_be_15_or_later():
    assert validate.state_errors(fixture({"postgres-version": 14}))
    assert validate.state_errors(fixture({"postgres-version": 16})) == []
    assert validate.state_errors(fixture({"postgres-version": 17})) == []


def test_patroni_synchronous_node_count_must_be_1_or_2():
    assert validate.state_errors(fixture({"patroni-synchronous-node-count": 1})) == []
    assert validate.state_errors(fixture({"patroni-synchronous-node-count": 2})) == []
    assert validate.state_errors(fixture({"patroni-synchronous-node-count": 3}))
    assert validate.state_errors(fixture({"patroni-synchronous-node-count": 0}))


def test_patroni_ttl_must_exceed_twice_loop_wait():
    assert validate.state_errors(fixture({"patroni-loop-wait": 15, "patroni-ttl": 30}))
    assert validate.state_errors(fixture({"patroni-loop-wait": 10, "patroni-ttl": 30})) == []


def test_exclusive_ports_must_not_collide():
    assert validate.state_errors(fixture({"patroni-rest-port": 2379, "etcd-client-port": 2379}))


def test_postgres_port_can_equal_haproxy_primary_port():
    assert validate.state_errors(fixture({"postgres-port": 5432, "haproxy-primary-port": 5432})) == []


def test_valid_cidrs_accepted():
    assert validate.valid_cidr("10.0.0.0/16")
    assert validate.valid_cidr("192.168.1.1/32")


def test_open_ingress_rejected():
    assert validate.state_errors(fixture({"digitalocean-ssh-sources": ["0.0.0.0/0"]}))
    assert validate.state_errors(fixture({"digitalocean-client-sources": ["0.0.0.0/0"]}))


def test_secret_errors_reported_when_credentials_missing():
    errors = validate.secret_errors(fixture())
    assert errors
    assert any("POSTGRES_ADMIN_PASSWORD" in e for e in errors)
    assert any("BACKUP_R2_ACCESS_KEY_ID" in e for e in errors)
