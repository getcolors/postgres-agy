from conftest import fixture
from package_once_blue import compute_cluster as cluster
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


def test_source_lists_are_onces_to_check_and_the_world_is_this_packages_to_refuse():
    # The list and CIDR checks are ONCE's, with its messages; the refusal of
    # the world is this package's own and holds however the list is spelled.
    for key in ["digitalocean-ssh-sources", "digitalocean-client-sources"]:
        assert validate.state_errors(fixture({key: ["0.0.0.0/0"]})) == \
            [f":{key} must not contain 0.0.0.0/0; administrative and database ingress stay scoped"]
        assert any("must not contain 0.0.0.0/0" in e
                   for e in validate.state_errors(fixture({key: "129.159.242.163/32, 0.0.0.0/0"})))
        assert validate.state_errors(fixture({key: []})) == [f":{key} must list at least one CIDR"]
        assert validate.state_errors(fixture({key: ["10.0.0.1"]})) == \
            [f':{key} entry "10.0.0.1" is not an IPv4 or IPv6 CIDR']
    # a string is a list, the way an overlay carries one
    assert validate.state_errors(fixture({"digitalocean-ssh-sources": "10.0.0.0/16, 192.168.1.1/32"})) == []


def test_the_spec_describes_one_homogeneous_role_on_a_discovered_network():
    # The Compute Cluster Standard's spec is data ONCE reads; this is the one
    # place its content is asserted, so a drift in any colour is a test
    # failure and not a rendered surprise.
    assert cluster.spec_errors(validate.spec) == []
    assert list(validate.spec["registry"]) == ["digitalocean"]
    assert validate.spec["default"] == "digitalocean"
    assert validate.spec["registry"]["digitalocean"]["network"] == {"mode": "discovered"}
    assert validate.spec["sources"] == {"non_empty": ["ssh-sources", "client-sources"], "may_be_empty": []}
    assert validate.spec["roles"] == [
        {"role": None, "count_key": "cluster-nodes", "count": 3, "fallback_offset": 11}]
    # the bare profile alias reaches node 0
    assert "entry" not in validate.spec
    assert validate.spec["fallback_subnet"] == "10.114.0.0/20"
    assert cluster.topology_errors(validate.spec, fixture()) == []
    # the registry's required keys are demanded through ONCE
    for key in validate.compute_providers["digitalocean"]["required"]:
        base = fixture()
        del base[key]
        assert any(f"{key} is required" in e for e in validate.state_errors(base)), key


def test_the_vpc_is_discovered_and_cannot_be_described():
    for key in validate.forbidden_vpc_keys:
        assert any("must not be configured; the regional default VPC is discovered" in e
                   for e in validate.state_errors(fixture({key: "10.0.0.0/16"}))), key
    # the two spellings ONCE knows are refused by its discovered-network rule,
    # once, with its message
    assert validate.state_errors(fixture({"digitalocean-vpc-uuid": "00000000-0000-0000-0000-000000000000"})) == \
        [":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime"]
    assert validate.state_errors(fixture({"digitalocean-vpc-cidr": "10.114.0.0/20"})) == \
        [":digitalocean-vpc-cidr must be absent; this package must not create a VPC"]
    assert any(":digitalocean-vpc-mode must be default" in e
               for e in validate.state_errors(fixture({"digitalocean-vpc-mode": "explicit"})))


def test_the_count_and_the_provider_are_checked_by_once_too():
    assert ":cluster-nodes must be a positive integer" in validate.state_errors(fixture({"cluster-nodes": "3"}))
    assert ":provider-compute must be one of digitalocean" in \
        validate.state_errors(fixture({"provider-compute": "hcloud"}))
    assert any("unsupported :provider-dns" in e for e in validate.state_errors(fixture({"provider-dns": "yandex"})))


def test_secret_errors_reported_when_credentials_missing():
    errors = validate.secret_errors(fixture())
    assert errors
    assert any("POSTGRES_ADMIN_PASSWORD" in e for e in errors)
    assert any("BACKUP_R2_ACCESS_KEY_ID" in e for e in errors)
