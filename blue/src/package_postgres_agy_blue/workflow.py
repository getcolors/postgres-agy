"""The lifecycle graph, the preflight, and the per-stage remote-state advice —
the port of io.github.getcolors.postgres-agy.workflow.

Create is strictly sequential. The stages are not independent: DNS needs the
addresses compute produced, the cluster play needs the inventory those
addresses build, and acceptance needs a converged cluster *and* a resolvable
name. Fanning any of it out would only buy back the seconds that DigitalOcean
spends creating three droplets in one `apply` anyway.

Delete runs the same edges backwards, with one addition: it adopts the cluster
out of remote state first, because the local SSH configuration it has to
withdraw is keyed by the nodes and by then the droplets may already be gone.
The state is read once, in preflight, so the Compute Provider Standard's
switch guard runs before the credentials are checked; the read is handed to
`load-infrastructure` rather than repeated."""

from __future__ import annotations

import os

from blue import dry_run, progress
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, workflow
from package_once_blue import compute_cluster as cluster

from . import tools, validate

DEFAULTS = {
    "provider-compute": validate.default_compute_provider,
    "provider-dns": "cloudflare",
    "provider-backend": "local",
    "compute-prevent-destroy": True,
    "workdir": ".colors",
    "cluster-nodes": 3,
    "cloudflare-proxied": False,
    "cloudflare-record-ttl": 60,
    "digitalocean-vpc-mode": "default",
    "postgres-port": 5432,
    "postgres-admin-user": "postgres",
    "postgres-replication-user": "replicator",
    "patroni-rest-port": 8008,
    "patroni-ttl": 30,
    "patroni-loop-wait": 10,
    "patroni-retry-timeout": 10,
    "patroni-synchronous-node-count": 1,
    "etcd-client-port": 2379,
    "etcd-peer-port": 2380,
    "haproxy-primary-port": 5432,
    "haproxy-replica-port": 5433,
    "haproxy-stats-port": 7000,
    "backup-stanza": "main",
    "backup-retention-full": 4,
    "backup-r2-region": "auto",
    "restore-check-port": 5442,
    "restore-check-max-age-hours": 26,
    "restore-check-max-lag-seconds": 900,
    "heartbeat-oncalendar": "*:0/1",
    "heartbeat-retention-days": 7,
}

LIFECYCLE_EVENTS = ("create", "delete")


def _real_lifecycle_event(context: dict) -> bool:
    return bool(context.get("real") and context.get("event") in LIFECYCLE_EVENTS)


async def start_step(original: dict, env: dict | None = None, reader=None) -> dict:
    """Preflight. On a real create or delete the compute state is read once
    through `reader` — the package's `tools.state_output` unless a test
    injects another — on the same defaulted and overlaid opts the validators
    see, and only once desired state itself has passed, so the reader never
    renders an invalid colors.yml. The read feeds the switch guard here and
    travels on under `postgres-agy/state` for `load-infrastructure` to adopt.

    Credentials are only demanded by a run that will actually use them.
    `build` and `--dry-run` therefore work on a fresh checkout with an empty
    environment, which is what makes them a safe way to review a colors.yml
    edit."""
    reader = reader if reader is not None else tools.state_output
    environment = dict(os.environ if env is None else env)
    overlaid = read_pars({**DEFAULTS, **original}, environment)
    context = {"event": overlaid.get("blue/event"), "real": not overlaid.get("blue/dry-run")}
    state: dict = {}
    if (_real_lifecycle_event(context)
            and not validate.env_errors(environment)
            and not validate.state_errors(overlaid)):
        state = await cluster.read_state(overlaid, reader)

    def after(opts, _env, ctx):
        result = {**opts, "blue/exit": 0}
        if _real_lifecycle_event(ctx):
            result["postgres-agy/state"] = state
        return result

    return await preflight(
        original, defaults=DEFAULTS, overlay=read_pars, env=environment,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            # Standard §4 before the credentials: a recorded provider that
            # differs from the selected one reports the actionable error, not
            # a missing token for the provider that was just selected.
            lambda o, _e, c: (cluster.provider_validator(
                validate.spec, o, state.get("params"), lambda: validate.secret_errors(o))
                if _real_lifecycle_event(c) else []),
            lambda o, _e, c: (["compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false for this one delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ],
        after_validate=after)


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "postgres-agy/start": (start_step, "postgres-agy/load-infrastructure"),
            "postgres-agy/load-infrastructure": (tools.load_infrastructure_step,
                                                "postgres-agy/cluster"),
            "postgres-agy/cluster": (tools.cluster_step, "postgres-agy/ansible-local"),
            "postgres-agy/ansible-local": (tools.ansible_local_step, "postgres-agy/dns"),
            "postgres-agy/dns": (tools.dns_step, "postgres-agy/infrastructure"),
            "postgres-agy/infrastructure": (tools.infrastructure_step,
                                           "postgres-agy/generated-cleanup"),
            "postgres-agy/generated-cleanup": (tools.generated_cleanup_step,),
        }.get(step)
    return {
        "postgres-agy/start": (start_step, "postgres-agy/infrastructure"),
        "postgres-agy/infrastructure": (tools.infrastructure_step, "postgres-agy/dns"),
        "postgres-agy/dns": (tools.dns_step, "postgres-agy/ansible-local"),
        "postgres-agy/ansible-local": (tools.ansible_local_step, "postgres-agy/cluster"),
        "postgres-agy/cluster": (tools.cluster_step, "postgres-agy/acceptance"),
        "postgres-agy/acceptance": (tools.acceptance_step,),
    }.get(step)


def backend_advice(tool: str):
    """The state backend of one OpenTofu stage: `tools.backend_advice`, which
    the state reader also runs, so a delete from a fresh clone finds its
    state."""
    return tools.backend_advice(tool)


side_effecting_steps = [
    "postgres-agy/load-infrastructure", "postgres-agy/infrastructure",
    "postgres-agy/dns", "postgres-agy/ansible-local", "postgres-agy/cluster",
    "postgres-agy/acceptance", "postgres-agy/generated-cleanup",
]


def create_workflow():
    wf = workflow(start="postgres-agy/start", wire_fn=wire_fn)
    wf = advice_add(wf, "postgres-agy/load-infrastructure", "before",
                    "io.github.getcolors.postgres-agy.workflow/backend",
                    backend_advice(tools.infrastructure_tool))
    wf = advice_add(wf, "postgres-agy/infrastructure", "before",
                    "io.github.getcolors.postgres-agy.workflow/backend",
                    backend_advice(tools.infrastructure_tool))
    wf = advice_add(wf, "postgres-agy/dns", "before",
                    "io.github.getcolors.postgres-agy.workflow/backend",
                    backend_advice(tools.dns_tool))
    wf = progress.advise(wf)
    wf = dry_run.advise(wf, side_effecting_steps)
    return wf


postgres_agy_workflow = create_workflow()
