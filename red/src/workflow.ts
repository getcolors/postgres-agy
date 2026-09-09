
import { parName, readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";

import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": validate.defaultComputeProvider,
  "provider-dns": "cloudflare",
  "provider-backend": "r2",
  "compute-prevent-destroy": true,
  workdir: ".colors",
  "cluster-nodes": 3,
  "cloudflare-proxied": false,
  "cloudflare-record-ttl": 60,
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
};

export const lifecycleEvents = ["create", "delete"];

const realLifecycleEvent = ({ event, real }: PreflightContext): boolean =>
  real && lifecycleEvents.includes(String(event));

export async function startStep(opts:Opts,env:Record<string,string|undefined>=process.env):Promise<Opts>{
 return preflight(opts,{defaults,overlay:readPars,validators:[(_o,e)=>validate.envErrors(e),o=>validate.stateErrors(o),
  (o,_e,c)=>realLifecycleEvent(c)&&!validate.stateErrors(o).length?validate.secretErrors(o):[],
  (o,_e,c)=>c.real&&c.event==='delete'&&o['compute-prevent-destroy']?['compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false for this one delete']:[]],
 afterValidate:async(current,_e,c)=>c.real&&c.event==='create'?sshConfig.preflight(current):{...ssh.withMachineKey(current),'red/exit':0}},env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "postgres-agy/start": [startStep, "postgres-agy/load-infrastructure"],
      "postgres-agy/load-infrastructure": [tools.loadInfrastructureStep,
                                          "postgres-agy/cluster"],
      "postgres-agy/cluster": [tools.clusterStep, "postgres-agy/ansible-local"],
      "postgres-agy/ansible-local": [tools.ansibleLocalStep, "postgres-agy/dns"],
      "postgres-agy/dns": [tools.dnsStep, "postgres-agy/infrastructure"],
      // The keypair goes after the compute destroy (ssh-keypair.md §3.3): a
      // key that predeceases its hosts locks the operator out of nodes that
      // still exist.
      "postgres-agy/infrastructure": [tools.infrastructureStep, "postgres-agy/generated-cleanup"],
      "postgres-agy/generated-cleanup": [tools.generatedCleanupStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "postgres-agy/start": [startStep, "postgres-agy/infrastructure"],
    "postgres-agy/infrastructure": [tools.infrastructureStep, "postgres-agy/dns"],
    "postgres-agy/dns": [tools.dnsStep, "postgres-agy/ansible-local"],
    "postgres-agy/ansible-local": [tools.ansibleLocalStep, "postgres-agy/cluster"],
    "postgres-agy/cluster": [tools.clusterStep, "postgres-agy/acceptance"],
    "postgres-agy/acceptance": [tools.acceptanceStep],
  };
  return graph[step];
}

// The state backend of one OpenTofu stage: `tools.backendAdvice`, which the
// state reader also runs, so a delete from a fresh clone finds its state.
export function backendAdvice(tool: string) {
  return tools.backendAdvice(tool);
}

export const sideEffectingSteps = [
  "postgres-agy/load-infrastructure", "postgres-agy/infrastructure",
  "postgres-agy/dns", "postgres-agy/ansible-local", "postgres-agy/cluster",
  "postgres-agy/acceptance", "postgres-agy/ssh-cleanup", "postgres-agy/generated-cleanup",
];

function create() {
  let wf = workflow({ start: "postgres-agy/start", wireFn,nextFn:(_step,next,opts)=>opts["postgres-agy/already-destroyed"]||failed(opts)?[]:(next??[]).map(step=>[step,opts]) });
  wf = adviceAdd(wf, "postgres-agy/load-infrastructure", "before",
                 "io.github.getcolors.postgres-agy.workflow/backend",
                 backendAdvice(tools.infrastructureTool));

  wf = adviceAdd(wf, "postgres-agy/dns", "before",
                 "io.github.getcolors.postgres-agy.workflow/backend",
                 backendAdvice(tools.dnsTool));
  wf = progress.advise(wf);
  wf = dryRun.advise(wf, sideEffectingSteps);
  return wf;
}

export const postgresAgyWorkflow = create();
