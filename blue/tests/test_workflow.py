import pytest
from blue.workflow import StepError
from conftest import fixture, optout
from package_postgres_agy_blue import ssh, tools, workflow

CREDENTIALS = {
    "COLORS_PAR_DO_TOKEN": "t", "COLORS_PAR_CLOUDFLARE_API_TOKEN": "t",
    "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID": "t", "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY": "t",
    "COLORS_PAR_POSTGRES_ADMIN_PASSWORD": "t", "COLORS_PAR_POSTGRES_REPLICATION_PASSWORD": "t",
}
UNGUARDED = {**CREDENTIALS, "COLORS_PAR_COMPUTE_PREVENT_DESTROY": "false"}


def recorded() -> dict:
    """`params` as a converged deployment records it."""
    return {"provider": "digitalocean",
            "vpc_id": "5a6b7c8d-0000-4000-8000-000000000001",
            "vpc_ip_range": "10.20.0.0/20",
            "nodes": [{"index": i, "role": None, "name": f"postgres-agy-{i + 1}",
                       "ip": f"203.0.113.{i + 1}", "vpc_ip": f"10.20.0.{i + 1}",
                       "user": "root", "sudoer": "root"}
                      for i in range(3)]}


# The compute state is read once per run, through `tools.state_output`, on a
# real create or delete. Every lifecycle test replaces it: None is a readable
# state holding no compute, a dict is a recorded `params`, and a raise is a
# backend that cannot be read.
@pytest.fixture
def state(monkeypatch):
    def install(value):
        async def stub(_opts):
            return value
        monkeypatch.setattr(tools, "state_output", stub)
    return install


@pytest.fixture
def unreadable(monkeypatch):
    # The shape `blue.tofu` raises: the SDK's StepError. Only that is an
    # unreadable backend; anything else propagates as a defect.
    async def boom(_opts):
        raise StepError("tofu output failed: no backend")
    monkeypatch.setattr(tools, "state_output", boom)


@pytest.fixture
def never(monkeypatch):
    async def boom(_opts):
        raise AssertionError("the reader must not run")
    monkeypatch.setattr(tools, "state_output", boom)


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
    # The keypair goes after the compute destroy (ssh-keypair.md §3.3).
    assert (workflow.wire_fn("postgres-agy/infrastructure", {"blue/event": "delete"})
            == (tools.infrastructure_step, "postgres-agy/ssh-cleanup"))
    assert (workflow.wire_fn("postgres-agy/ssh-cleanup", {"blue/event": "delete"})
            == (ssh.cleanup_step, "postgres-agy/generated-cleanup"))
    assert (workflow.wire_fn("postgres-agy/generated-cleanup", {"blue/event": "delete"})
            == (tools.generated_cleanup_step,))


async def test_a_build_fills_the_placeholder_key_paths():
    # Every event fills the machine-key paths in preflight so the templates
    # and the inventory render the same whichever step scaffolds them; a build
    # gets the fixed placeholder, never the operator's home.
    r = await workflow.start_step(fixture({"blue/event": "build"}), {})
    assert r["blue/exit"] == 0
    assert r["ssh-private-key-path"] == "/home/build-placeholder/.ssh/postgres-agy-fixture"
    assert r["ssh-keygen"] is True
    # Opt-out invents no key path.
    o = await workflow.start_step(optout({"blue/event": "build"}), {})
    assert o["blue/exit"] == 0
    assert "ssh-private-key-path" not in o
    assert "ssh-keygen" not in o


async def test_build_preflight_succeeds_without_credentials():
    res = await workflow.start_step(fixture({"blue/event": "build"}), {})
    assert res["blue/exit"] == 0


async def test_build_and_dry_run_never_read_the_state(never):
    # a raising reader proves nothing on these paths reaches the backend
    for opts in [fixture({"blue/event": "build"}),
                 fixture({"blue/event": "create", "blue/dry-run": True}),
                 fixture({"blue/event": "delete", "blue/dry-run": True})]:
        result = await workflow.start_step(opts, env={})
        assert result["blue/exit"] == 0
        assert "postgres-agy/state" not in result


async def test_a_real_create_demands_every_credential(state):
    state(None)
    result = await workflow.start_step(fixture({"blue/event": "create"}), {})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_POSTGRES_ADMIN_PASSWORD" in result["blue/err"]


async def test_the_destroy_guard_holds_and_lifts_for_exactly_one_run(state):
    state(None)
    held = await workflow.start_step(fixture({"blue/event": "delete"}), CREDENTIALS)
    assert held["blue/exit"] == 2
    assert "compute destruction is protected" in held["blue/err"]
    assert (await workflow.start_step(fixture({"blue/event": "delete"}), UNGUARDED))["blue/exit"] == 0


async def test_the_state_is_not_read_for_a_refused_profile_nor_invalid_desired_state(never):
    result = await workflow.start_step(fixture({"blue/event": "delete"}),
                                       {**UNGUARDED, "COLORS_PAR_PROFILE": "elsewhere"})
    assert result["blue/exit"] == 2
    result = await workflow.start_step(fixture({"blue/event": "delete", "cluster-nodes": 2}), UNGUARDED)
    assert result["blue/exit"] == 2


# --- the Compute Cluster Standard's safety boundaries -----------------------

async def test_a_provider_switch_is_refused_before_the_credentials(state):
    state({**recorded(), "provider": "vultr"})
    for event in ("create", "delete"):
        r = await workflow.start_step(
            fixture({"blue/event": event}), {"COLORS_PAR_COMPUTE_PREVENT_DESTROY": "false"})
        assert r["blue/exit"] == 2, event
        assert "state holds a vultr machine; set provider-compute back to vultr and delete first" \
            in r["blue/err"]
        # the validator order is the thing under test: the actionable error,
        # not a missing token for the provider that was just selected
        assert "required credential is not set" not in r["blue/err"]


async def test_legacy_state_accepts_only_the_default_provider(state):
    # a recorded provider is absent from every pre-adoption state; on the one
    # provider this package offers that is the default, and the run proceeds
    # to its credentials
    state({k: v for k, v in recorded().items() if k != "provider"})
    for event in ("create", "delete"):
        r = await workflow.start_step(
            fixture({"blue/event": event}), {"COLORS_PAR_COMPUTE_PREVENT_DESTROY": "false"})
        assert r["blue/exit"] == 2, event
        assert "state holds" not in r["blue/err"], event
        assert "required credential is not set" in r["blue/err"], event


async def test_a_matching_provider_passes_to_the_credentials(state):
    state(recorded())
    r = await workflow.start_step(fixture({"blue/event": "create"}), {})
    assert r["blue/exit"] == 2
    assert "state holds" not in r["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in r["blue/err"]


async def test_an_unreadable_backend_counts_as_no_state_on_create(unreadable):
    # a fresh clone has no readable state and must still be able to create
    r = await workflow.start_step(fixture({"blue/event": "create"}), {})
    assert r["blue/exit"] == 2
    assert "could not read" not in r["blue/err"]
    assert "state holds" not in r["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in r["blue/err"]


async def test_a_real_create_on_a_fresh_work_directory_reports_the_credentials_not_a_crash(tmp_path):
    # no reader stub: the real `state_output` runs against a work directory
    # that holds no stage yet, as a fresh clone's does. It renders the stage,
    # writes its backend and initializes it, and finds no state — or fails to
    # launch or initialize tofu, which the SDK reports as its StepError.
    # Either way ONCE's `read_state` counts it as no usable state, so the
    # create reports its credentials instead of crashing. The r2 backend, the
    # path a real deployment takes, so the initialization stops at the backend
    # rather than fetching a provider plugin.
    result = await workflow.start_step(
        fixture({"workdir": str(tmp_path), "blue/event": "create"}),
        {"COLORS_PAR_PROVIDER_BACKEND": "r2"})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "could not read" not in result["blue/err"]


async def test_an_unreadable_backend_fails_a_real_delete_closed(unreadable):
    # swallowing it is how a teardown ends up converging against 192.0.2.11.
    # Preflight hands the read on; `load-infrastructure`, the first step after
    # it and before any side effect, is where the delete stops
    r = await workflow.start_step(fixture({"blue/event": "delete"}), UNGUARDED)
    assert r["blue/exit"] == 0
    assert r["postgres-agy/state"] == {"error": "tofu output failed: no backend"}
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in loaded["blue/err"]
    assert "no backend" in loaded["blue/err"]


async def test_a_real_delete_adopts_the_recorded_cluster(state):
    state(recorded())
    r = await workflow.start_step(fixture({"blue/event": "delete"}), UNGUARDED)
    assert r["blue/exit"] == 0
    assert r["postgres-agy/state"] == {"params": recorded()}
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 0
    assert loaded["once/cluster"] == recorded()
    assert [n["public-ip"] for n in tools.nodes(loaded)] == ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    # and withdraws every alias of the block it wrote
    variables = tools.ansible_local_extra_vars(loaded)
    assert [h["name"] for h in variables["ssh_hosts"]] == \
        ["postgres-agy-fixture", "postgres-agy-fixture-0", "postgres-agy-fixture-1", "postgres-agy-fixture-2"]
    assert variables["block_state"] == "absent"
    # a readable state without a cluster leaves nothing to clean up
    state(None)
    loaded = await tools.load_infrastructure_step(
        await workflow.start_step(fixture({"blue/event": "delete"}), UNGUARDED))
    assert loaded["blue/exit"] == 0
    assert loaded["postgres-agy/infrastructure-present?"] is False


async def test_a_partial_cluster_is_refused_on_a_real_run(state):
    params = recorded()
    state({**params, "nodes": params["nodes"][:2]})
    r = await workflow.start_step(fixture({"blue/event": "delete"}), UNGUARDED)
    # the switch guard reads only the provider
    assert r["blue/exit"] == 0
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 1
    assert loaded["blue/err"] == "the compute stage did not report nodes this package declares: 2"
