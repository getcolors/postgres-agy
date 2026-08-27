// CLI entry: the same verbs as the green launcher, with the logic kept here
// where the test suite reaches it — the copied payload holds none of its own.

import { execCli, findUp, runCli } from "red/cli";
import type { Opts } from "red/workflow";
import * as operator from "./operator.ts";
import { postgresAgyWorkflow } from "./workflow.ts";

export const lifecycleCommands = ["build", "create", "delete"];
export const operatorCommands = ["status", "failover", "switchover", "backup", "verify-restore", "psql"];

export const usage =
  "Usage: red <build|create|delete> [-f|--file colors.yml] [--dry-run]\n" +
  "       red <status|failover|switchover|backup|verify-restore|psql> " +
  "[--node N] [-f|--file colors.yml] [-- extra args]\n" +
  "\n" +
  "  build           render the work directory only — contact nothing\n" +
  "  create          converge the 3-node PostgreSQL failover cluster and verify health\n" +
  "  delete          tear down the cluster (guarded by compute-prevent-destroy)\n" +
  "  status          patronictl list — members, roles, replication lag\n" +
  "  switchover      planned handover to a healthy standby\n" +
  "  failover        unplanned promotion when the leader is unavailable\n" +
  "  backup          run the pgBackRest full backup now, on the leader\n" +
  "  verify-restore  run the verified restore now, on a standby\n" +
  "  psql            psql against cluster host through HAProxy primary port\n" +
  "\n" +
  "  --node N        which node to dispatch through (default 1)";

// The nearest colors.yml at or above the working directory. Walking up means
// red can be run from any subdirectory of a project and still find the one
// desired state.
export function defaultFile(): string {
  return findUp("colors.yml") ?? "colors.yml";
}

function fileArg(arg: string): boolean {
  return arg === "-f" || arg === "--file" || arg.startsWith("--file=");
}

export function defaultArgs(args: string[]): string[] {
  return args.some(fileArg) ? args : [...args, "-f", defaultFile()];
}

// REPL-friendly entry point that returns the final outcome map.
export async function run(...args: string[]): Promise<Opts> {
  const command = args[0] ?? "";
  if (["help", "--help", "-h"].includes(command)) {
    return { "red/exit": 0, "red/err": usage };
  }
  if (lifecycleCommands.includes(command)) {
    return runCli(postgresAgyWorkflow, defaultArgs(args));
  }
  if (operatorCommands.includes(command)) {
    return operator.run(defaultFile(), command, args.slice(1));
  }
  return { "red/exit": 2, "red/err": usage };
}

export async function exec(args: string[] = Bun.argv.slice(2)): Promise<never> {
  if (lifecycleCommands.includes(args[0] ?? "")) {
    return execCli(postgresAgyWorkflow, defaultArgs(args));
  }
  const result = await run(...args);
  if (result["red/err"]) {
    ((result["red/exit"] ?? 0) === 0 ? console.log : console.error)(result["red/err"]);
  }
  return process.exit(result["red/exit"] ?? 0);
}
