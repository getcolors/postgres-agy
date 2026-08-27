"""CLI entry: the same verbs as the green launcher, with the logic kept here
where the test suite reaches it — the copied payload holds none of its own."""

from __future__ import annotations

import asyncio
import sys

from blue.cli import find_up, run_cli

from . import operator
from .workflow import postgres_agy_workflow

USAGE = ("Usage: blue <build|create|delete> [-f|--file colors.yml] [--dry-run]\n"
         "       blue <status|failover|switchover|backup|verify-restore|psql> "
         "[--node N] [-f|--file colors.yml] [-- extra args]\n"
         "\n"
         "  build           render the work directory only — contact nothing\n"
         "  create          converge the 3-node PostgreSQL failover cluster and verify health\n"
         "  delete          tear down the cluster (guarded by compute-prevent-destroy)\n"
         "  status          patronictl list — members, roles, replication lag\n"
         "  switchover      planned handover to a healthy standby\n"
         "  failover        unplanned promotion when the leader is unavailable\n"
         "  backup          run the pgBackRest full backup now, on the leader\n"
         "  verify-restore  run the verified restore now, on a standby\n"
         "  psql            psql against cluster host through HAProxy primary port\n"
         "\n"
         "  --node N        which node to dispatch through (default 1)")

LIFECYCLE = ("build", "create", "delete")
OPERATOR = ("status", "failover", "switchover", "backup", "verify-restore", "psql")


def default_file() -> str:
    """The nearest colors.yml at or above the working directory. Walking up
    means blue can be run from any subdirectory of a project and still find
    the one desired state."""
    return find_up("colors.yml") or "colors.yml"


def default_args(args: list[str]) -> list[str]:
    if any(a in ("-f", "--file") or str(a).startswith("--file=") for a in args):
        return args
    return [*args, "-f", default_file()]


async def run(*args):
    """REPL-friendly entry point that returns the final outcome map."""
    args = list(args)
    command = args[0] if args else None
    if command in ("help", "--help", "-h"):
        return {"blue/exit": 0, "blue/err": USAGE}
    if command in LIFECYCLE:
        return await run_cli(postgres_agy_workflow, default_args(args))
    if command in OPERATOR:
        return await operator.run(default_file(), command, args[1:])
    return {"blue/exit": 2, "blue/err": USAGE}


def exec(args: list[str] | None = None) -> None:
    result = asyncio.run(run(*(sys.argv[1:] if args is None else args)))
    if result.get("blue/err"):
        stream = sys.stdout if (result.get("blue/exit") or 0) == 0 else sys.stderr
        print(result["blue/err"], file=stream)
        if result.get("blue/trace"):
            print(result["blue/trace"], file=stream)
    raise SystemExit(result.get("blue/exit") or 0)
