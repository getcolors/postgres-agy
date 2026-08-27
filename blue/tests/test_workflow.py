from conftest import fixture
from package_postgres_agy_blue import tools, workflow


def test_create_flow_edges():
    assert (workflow.wire_fn("postgres-agy/start", {"blue/event": "create"})
            == (workflow.start_step, "postgres-agy/infrastructure"))
    assert (workflow.wire_fn("postgres-agy/infrastructure", {"blue/event": "create"})
            == (tools.infrastructure_step, "postgres-agy/dns"))
    assert (workflow.wire_fn("postgres-agy/dns", {"blue/event": "create"})
            == (tools.dns_step, "postgres-agy/ansible-local"))
    assert (workflow.wire_fn("postgres-agy/ansible-local", {"blue/event": "create"})
            == (tools.ansible_local_step, "postgres-agy/cluster"))
    assert (workflow.wire_fn("postgres-agy/cluster", {"blue/event": "create"})
            == (tools.cluster_step, "postgres-agy/acceptance"))
    assert (workflow.wire_fn("postgres-agy/acceptance", {"blue/event": "create"})
            == (tools.acceptance_step,))


def test_delete_flow_edges():
    assert (workflow.wire_fn("postgres-agy/start", {"blue/event": "delete"})
            == (workflow.start_step, "postgres-agy/load-infrastructure"))
    assert (workflow.wire_fn("postgres-agy/load-infrastructure", {"blue/event": "delete"})
            == (tools.load_infrastructure_step, "postgres-agy/cluster"))
    assert (workflow.wire_fn("postgres-agy/cluster", {"blue/event": "delete"})
            == (tools.cluster_step, "postgres-agy/ansible-local"))
    assert (workflow.wire_fn("postgres-agy/ansible-local", {"blue/event": "delete"})
            == (tools.ansible_local_step, "postgres-agy/dns"))
    assert (workflow.wire_fn("postgres-agy/dns", {"blue/event": "delete"})
            == (tools.dns_step, "postgres-agy/infrastructure"))
    assert (workflow.wire_fn("postgres-agy/infrastructure", {"blue/event": "delete"})
            == (tools.infrastructure_step, "postgres-agy/generated-cleanup"))
    assert (workflow.wire_fn("postgres-agy/generated-cleanup", {"blue/event": "delete"})
            == (tools.generated_cleanup_step,))


async def test_build_preflight_succeeds_without_credentials():
    res = await workflow.start_step(fixture({"blue/event": "build"}), {})
    assert res["blue/exit"] == 0
