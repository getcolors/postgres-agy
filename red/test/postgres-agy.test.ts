// The port of green's test suite: validate, utils, tools, workflow, operator.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepError, type Opts } from "red/workflow";
import {plan_deployment} from "colors-compute-red";
import * as compute from "../src/compute.ts";
import * as operator from "../src/operator.ts";
import * as ssh from "../src/ssh.ts";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as utils from "../src/utils.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const optoutFile = join(import.meta.dir, "../../test/fixtures/optout.yml");

function fixture(overrides: Opts = {}): Opts {
  return { ...(Bun.YAML.parse(readFileSync(fixtureFile, "utf8")) as Opts), "provider-backend":"r2", "red/event":"build", ...overrides };
}

function optout(overrides: Opts = {}): Opts {
  return { ...(Bun.YAML.parse(readFileSync(optoutFile, "utf8")) as Opts), "ssh-private-key-path":"/fixture/external", "provider-backend":"r2", "red/event":"build", ...overrides };
}

// --- utils -------------------------------------------------------------------

describe("utils", () => {
  test("launcher contract version", () => {
    expect(Number.isInteger(utils.contract) && utils.contract > 0).toBe(true);
  });

  test("node count and ordinals", () => {
    expect(utils.nodeCount).toBe(3);
    expect(utils.ordinals()).toEqual([1, 2, 3]);
  });

  test("par lookup formatting", () => {
    expect(utils.parLookup("postgres-admin-password"))
      .toBe("{{ lookup('env','COLORS_PAR_POSTGRES_ADMIN_PASSWORD') }}");
    expect(utils.parLookup("do-token"))
      .toBe("{{ lookup('env','COLORS_PAR_DO_TOKEN') }}");
  });

  test("endpoint host extraction", () => {
    expect(utils.endpointHost("https://319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com"))
      .toBe("319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com");
    expect(utils.endpointHost("http://s3.amazonaws.com/")).toBe("s3.amazonaws.com");
  });

  test("repo path extraction", () => {
    expect(utils.repoPath("postgres-agy-digitalocean")).toBe("/postgres-agy-digitalocean");
    expect(utils.repoPath("/my/path")).toBe("/my/path");
    expect(utils.repoPath("")).toBe("/");
  });
});

// --- validate ----------------------------------------------------------------

describe("validate", () => {
  test("default fixture produces no errors", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
  });

  test("both keypair modes are renderable", () => {
    // The SSH Keypair Standard has two modes and conformance means both hold.
    expect(validate.stateErrors(optout())).toEqual([]);
    expect(validate.keygen(fixture())).toBe(true);
    expect(validate.keygen(optout())).toBe(false);
    // The machine key is never required: its absence is keygen mode.
    expect(validate.stateErrors(fixture()).some((e) => e.includes("digitalocean-ssh-keys"))).toBe(false);
  });

  test("the private key path is desired state in opt-out mode only", () => {
    const o = optout();
    delete o["ssh-private-key-path"];
    delete o["digitalocean-ssh-private-key"];
    expect(validate.stateErrors(o))
      .toContain(":ssh-private-key-path is required for external SSH access");
    const k = fixture();
    delete k["digitalocean-ssh-private-key"];
    expect(validate.stateErrors(k)).toEqual([]);
  });

  test("COLORS_PAR_PROFILE is rejected", () => {
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "override" }).length).toBeGreaterThan(0);
    expect(validate.envErrors({})).toEqual([]);
  });

  test("missing required keys are reported", () => {
    for (const key of ["profile", "digitalocean-region", "cluster-host"]) {
      const base = fixture();
      delete base[key];
      expect(validate.stateErrors(base).length).toBeGreaterThan(0);
    }
  });

  test("cluster-nodes must be 3", () => {
    expect(validate.stateErrors(fixture({ "cluster-nodes": 2 })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "cluster-nodes": 4 })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "cluster-nodes": 3 }))).toEqual([]);
  });

  test("postgres-version must be >= 15", () => {
    expect(validate.stateErrors(fixture({ "postgres-version": 14 })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "postgres-version": 16 }))).toEqual([]);
    expect(validate.stateErrors(fixture({ "postgres-version": 17 }))).toEqual([]);
  });

  test("patroni-synchronous-node-count must be 1 or 2", () => {
    expect(validate.stateErrors(fixture({ "patroni-synchronous-node-count": 1 }))).toEqual([]);
    expect(validate.stateErrors(fixture({ "patroni-synchronous-node-count": 2 }))).toEqual([]);
    expect(validate.stateErrors(fixture({ "patroni-synchronous-node-count": 3 })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "patroni-synchronous-node-count": 0 })).length).toBeGreaterThan(0);
  });

  test("patroni-ttl must exceed 2 * loop-wait", () => {
    expect(validate.stateErrors(fixture({ "patroni-loop-wait": 15, "patroni-ttl": 30 })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "patroni-loop-wait": 10, "patroni-ttl": 30 }))).toEqual([]);
  });

  test("exclusive ports must not collide", () => {
    expect(validate.stateErrors(
      fixture({ "patroni-rest-port": 2379, "etcd-client-port": 2379 })).length).toBeGreaterThan(0);
  });

  test("postgres-port can equal haproxy-primary-port", () => {
    expect(validate.stateErrors(
      fixture({ "postgres-port": 5432, "haproxy-primary-port": 5432 }))).toEqual([]);
  });

  test("shared source validation preserves scoped application ingress",()=>{
    for(const key of ['digitalocean-ssh-sources','digitalocean-client-sources']){
     expect(validate.stateErrors(fixture({[key]:['0.0.0.0/0']})).some(e=>e.includes('must not contain'))).toBe(true);
     expect(validate.stateErrors(fixture({[key]:[]})).length).toBeGreaterThan(0);
     expect(validate.stateErrors(fixture({[key]:['10.0.0.1']})).length).toBeGreaterThan(0);
    }
  });

  test("secret errors reported when credentials missing", () => {
    const errors = validate.secretErrors(fixture());
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("POSTGRES_ADMIN_PASSWORD"))).toBe(true);
    expect(errors.some((e) => e.includes("BACKUP_R2_ACCESS_KEY_ID"))).toBe(true);
  });
});

// --- tools -------------------------------------------------------------------

// A pre-adoption state exactly as `tofu output -json` parsed it: the four
// outputs, two parallel lists among them, and no `params`.
const legacyOutputs: Record<string, unknown> = {
  node_public_ips: ["203.0.113.1", "203.0.113.2", "203.0.113.3"],
  node_private_ips: ["10.20.0.1", "10.20.0.2", "10.20.0.3"],
  vpc_id: "5a6b7c8d-0000-4000-8000-000000000001",
  vpc_ip_range: "10.20.0.0/20",
};

// `params` as the adopted template records it, here through the legacy
// translation so the two shapes are provably one.
const recorded=():any=>({provider:'digitalocean',nodes:[0,1,2].map(i=>({provider:'digitalocean',node_id:String(i),index:i,role:null,name:'postgres-agy-'+i,ip:'203.0.113.'+(i+1),vpc_ip:'10.20.0.'+(i+1),user:'root',sudoer:'root'}))});

const without = (o: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

const converged = (): Opts => fixture({ 'colors-compute/cluster':recorded(),'colors-compute/shared':{params:{network_cidr:'10.20.0.0/20'}},'ssh-private-key-path':'/fixture/owned' });

describe("tools", () => {
  test("fallback nodes topology", () => {
    // ONCE's fallbacks at offset 11, the package's names
    const ns = tools.nodes(fixture());
    expect(ns.length).toBe(3);
    expect(ns.map((n) => n.name)).toEqual(["postgres-agy-0", "postgres-agy-1", "postgres-agy-2"]);
    expect(ns.map((n) => n["public-ip"])).toEqual(["192.0.2.10", "192.0.2.11", "192.0.2.12"]);
    expect(ns.map((n) => n["private-ip"])).toEqual(["10.0.0.10", "10.0.0.11", "10.0.0.12"]);
    expect(ns.map((n) => n.ordinal)).toEqual([1, 2, 3]);
    expect(tools.dataFn(fixture())["vpc-cidr"]).toBe("10.0.0.0/24");
    expect(tools.nodes(fixture())).toEqual(ns);
  });

  test("a real run reads every node from the adopted cluster", () => {
    const opts = converged();
    const ns = tools.nodes(opts);
    expect(ns.map((n) => n["public-ip"])).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    expect(ns.map((n) => n["private-ip"])).toEqual(["10.20.0.1", "10.20.0.2", "10.20.0.3"]);
    expect(ns.map((n) => n.name)).toEqual(["postgres-agy-0", "postgres-agy-1", "postgres-agy-2"]);
    expect(tools.dataFn(opts)["vpc-cidr"]).toBe("10.20.0.0/20");
    const inv = JSON.parse(tools.inventory(opts));
    expect(inv.all.children.postgres.hosts["postgres-agy-1"].ansible_host).toBe("203.0.113.2");
    expect(((tools.dnsSpecs(opts)[0]!.data as Opts).nodes as tools.Node[]).map((n) => n["public-ip"]))
      .toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    expect(((tools.acceptanceSpecs(opts)[0]!.data as Opts).nodes as tools.Node[]).map((n) => n.alias))
      .toEqual(["postgres-agy-fixture-0", "postgres-agy-fixture-1", "postgres-agy-fixture-2"]);
  });

  test("the local play receives one block of aliases", () => {
    // ssh-config.md: the addresses and the aliases are extra-vars, never
    // rendered; the marker is the profile; the bare profile reaches node 0
    const vars = tools.ansibleLocalExtraVars({ ...converged(), "red/event": "create" });
    expect(vars.host_alias).toBe("postgres-agy-fixture");
    expect((vars.ssh_hosts as any[]).map(({name,ip})=>({name,ip}))).toEqual([
      { name: "postgres-agy-fixture", ip: "203.0.113.1" },
      { name: "postgres-agy-fixture-0", ip: "203.0.113.1" },
      { name: "postgres-agy-fixture-1", ip: "203.0.113.2" },
      { name: "postgres-agy-fixture-2", ip: "203.0.113.3" },
    ]);
    expect(vars.block_state).toBe("present");
    // The identity file is desired state a build knows and reaches the play
    // through Selmer, in keygen mode only.
    expect(Object.keys(vars).sort()).toEqual(["block_state", "host_alias", "ssh_hosts"]);
    const data = tools.ansibleLocalSpecs(fixture())[0]!.data as Opts;
    expect(data["ssh-keygen"]).toBe(true);
    expect(data["ssh-config-identity-file"]).toBe("~/.ssh/postgres-agy-fixture");
    expect((tools.ansibleLocalSpecs(optout())[0]!.data as Opts)["ssh-keygen"]).toBe(true);
    // The nodes are reached with the generated key in keygen mode, on a build
    // through the placeholder, and with the operator's own key in opt-out mode.
    expect(JSON.parse(tools.inventory(fixture({ "red/event": "build" }))).all.children.postgres.vars.ansible_ssh_private_key_file)
      .toBe("/home/build-placeholder/.ssh/postgres-agy-fixture");
    expect(JSON.parse(tools.inventory(optout())).all.children.postgres.vars.ansible_ssh_private_key_file)
      .toBe("/fixture/external");
    expect(tools.ansibleLocalExtraVars({...converged(),"red/event":"delete"}).block_state).toBe("absent");
    // a build renders the play without an address
    const rendered = readFileSync(join(import.meta.dir, "../resources/tools/ansible-local/main.yml"), "utf8");
    expect(rendered).toContain('marker: "# {mark} {{ host_alias }} ANSIBLE MANAGED BLOCK"');
    expect(rendered).toContain("{% for host in ssh_hosts %}");
    expect(rendered).toContain("insertbefore: BOF");
    expect(/192\.0\.2|203\.0\.113/.test(rendered)).toBe(false);
  });

  test("dns specs render", () => {
    const specs = tools.dnsSpecs(fixture());
    expect(specs.length).toBe(1);
    expect(specs[0]!.template!.name).toBe("dns/main.tf");
  });

  test("cluster specs include all required templates", () => {
    const specs = tools.clusterSpecs(fixture());
    const templates = new Set(specs.map((s) => s.template?.name));
    for (const name of ["ansible-remote/main.yml", "ansible-remote/etcd.service.j2",
                        "ansible-remote/patroni.yml.j2", "ansible-remote/haproxy.cfg.j2",
                        "ansible-remote/pgbackrest.conf.j2",
                        "ansible-remote/postgres-agy-heartbeat.service.j2",
                        "ansible-remote/postgres-agy-restore-check.service.j2"]) {
      expect(templates.has(name)).toBe(true);
    }
  });
});

// --- workflow ----------------------------------------------------------------

const credentials = {
  COLORS_PAR_DO_TOKEN: "t", COLORS_PAR_CLOUDFLARE_API_TOKEN: "t",
  COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID: "t", COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY: "t",
  COLORS_PAR_POSTGRES_ADMIN_PASSWORD: "t", COLORS_PAR_POSTGRES_REPLICATION_PASSWORD: "t",
};
const unguarded = { ...credentials, COLORS_PAR_COMPUTE_PREVENT_DESTROY: "false" };

// `params` as a converged deployment records it.
const recordedParams = (): any => ({
  provider: "digitalocean",
  vpc_id: "5a6b7c8d-0000-4000-8000-000000000001",
  vpc_ip_range: "10.20.0.0/20",
  nodes: [0, 1, 2].map((i) => ({
    index: i, role: null, name: `postgres-agy-${i + 1}`,
    ip: `203.0.113.${i + 1}`, vpc_ip: `10.20.0.${i + 1}`, user: "root", sudoer: "root",
  })),
});

// The compute state is read once per run, through the injectable reader, on a
// real create or delete. Every lifecycle test injects one: undefined is a
// readable state holding no compute, a map is a recorded `params`, and a
// throw is a backend that cannot be read.
const start = (opts: Opts, env: Record<string, string | undefined>, state: any | undefined) =>
  workflow.startStep(opts, env);
// The shape `red/tofu` throws: the SDK's StepError. Only that is an unreadable
// backend; anything else propagates as a defect.
const startUnreadable = (opts: Opts, env: Record<string, string | undefined>) =>
  workflow.startStep(opts, env);
const never = async (): Promise<undefined> => { throw new Error("the reader must not run"); };

describe("workflow", () => {
  test("create flow edges", () => {
    expect(workflow.wireFn("postgres-agy/start", { "red/event": "create" }))
      .toEqual([workflow.startStep, "postgres-agy/infrastructure"]);
    expect(workflow.wireFn("postgres-agy/infrastructure", { "red/event": "create" }))
      .toEqual([tools.infrastructureStep, "postgres-agy/dns"]);
    expect(workflow.wireFn("postgres-agy/dns", { "red/event": "create" }))
      .toEqual([tools.dnsStep, "postgres-agy/ansible-local"]);
    expect(workflow.wireFn("postgres-agy/ansible-local", { "red/event": "create" }))
      .toEqual([tools.ansibleLocalStep, "postgres-agy/cluster"]);
    expect(workflow.wireFn("postgres-agy/cluster", { "red/event": "create" }))
      .toEqual([tools.clusterStep, "postgres-agy/acceptance"]);
    expect(workflow.wireFn("postgres-agy/acceptance", { "red/event": "create" }))
      .toEqual([tools.acceptanceStep]);
  });

  test("a build fills the placeholder key paths", async () => {
    // Every event fills the machine-key paths in preflight so the templates
    // and the inventory render the same whichever step scaffolds them; a build
    // gets the fixed placeholder, never the operator's home.
    const r = await workflow.startStep(fixture({ "red/event": "build" }), {});
    expect(r["red/exit"]).toBe(0);
    expect(r["ssh-private-key-path"]).toBe("/home/build-placeholder/.ssh/postgres-agy-fixture");
    expect(r["digitalocean-ssh-keys"]).toBeUndefined();
    // Opt-out invents no key path.
    const o = await workflow.startStep(optout({ "red/event": "build" }), {});
    expect(o["red/exit"]).toBe(0);
    expect(o["ssh-private-key-path"]).toBe("/fixture/external");
    expect(o["ssh-keygen"]).toBeUndefined();
  });

  test("build preflight succeeds without credentials", async () => {
    const res = await workflow.startStep(fixture({ "red/event": "build" }), {});
    expect(res["red/exit"]).toBe(0);
  });

  test("build and dry-run never read the state", async () => {
    // a throwing reader proves nothing on these paths reaches the backend
    for (const opts of [fixture({ "red/event": "build" }),
                        fixture({ "red/event": "create", "red/dry-run": true }),
                        fixture({ "red/event": "delete", "red/dry-run": true })]) {
      const r = await workflow.startStep(opts, {});
      expect(r["red/exit"]).toBe(0);
      expect("postgres-agy/state" in r).toBe(false);
    }
  });

  test("a real create demands every credential", async () => {
    const r = await start(fixture({ "red/event": "create" }), {}, undefined);
    expect(r["red/exit"]).toBe(2);
    expect(String(r["red/err"])).toContain("COLORS_PAR_POSTGRES_ADMIN_PASSWORD");
  });

  // --- the Compute Cluster Standard's safety boundaries

  test("a real create on a fresh work directory reports the credentials, not a crash", async () => {
    // no reader stub: the real `stateOutput` runs against a work directory
    // that holds no stage yet, as a fresh clone's does. It renders the stage,
    // writes its backend and initializes it, and finds no state — or fails to
    // launch or initialize tofu, which the SDK reports as its StepError.
    // Either way ONCE's `readState` counts it as no usable state, so the
    // create reports its credentials instead of crashing. The r2 backend,
    // the path a real deployment takes, so the initialization stops at the
    // backend rather than fetching a provider plugin.
    const work = mkdtempSync(join(tmpdir(), "postgres-agy-red-fresh"));
    try {
      const result = await workflow.startStep(fixture({ workdir: work, "red/event": "create" }),
                                              { COLORS_PAR_PROVIDER_BACKEND: "r2" });
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"])).toContain("COLORS_PAR_POSTGRES_ADMIN_PASSWORD");
      expect(String(result["red/err"])).not.toContain("could not read");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

});

// --- operator ----------------------------------------------------------------

describe("operator", () => {
  test("status command", () => {
    expect(operator.remoteCommand("status", fixture(), []))
      .toEqual(["patronictl", "-c", "/etc/patroni/patroni.yml", "list"]);
  });

  test("backup command", () => {
    expect(operator.remoteCommand("backup", fixture(), []))
      .toEqual(["/usr/local/bin/postgres-agy-backup"]);
  });

  test("verify-restore command", () => {
    expect(operator.remoteCommand("verify-restore", fixture(), []))
      .toEqual(["/usr/local/bin/postgres-agy-restore-check"]);
  });

  test("psql command", () => {
    expect(operator.remoteCommand("psql", fixture(), ["-c", "SELECT 1"]))
      .toEqual(["psql", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres",
                "-d", "appdb", "-c", "SELECT 1"]);
  });

  test("parse node flag", () => {
    expect(operator.parseArgs(["--node", "2"])).toEqual({ ordinal: 2, extra: [] });
    expect(operator.parseArgs(["-c", "SELECT 1"])).toEqual({ ordinal: 1, extra: ["-c", "SELECT 1"] });
    expect(operator.parseArgs(["--node", "3", "--force"])).toEqual({ ordinal: 3, extra: ["--force"] });
  });

  // Green's runner seam is a `with-redefs` on the inherit runner; here it is a
  // plain argument, so the dispatched argv is observable without SSH.
  test("run dispatches the quoted remote command through ssh", async () => {
    const seen: string[][] = [];
    const runner = async (args: string[]) => {
      seen.push(args);
      return { exit: 0, out: "", err: "" };
    };
    const result = await operator.run(fixtureFile, "status", [], runner, {COLORS_PAR_PROVIDER_BACKEND:"r2"});
    expect(result["red/exit"]).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]![0]).toBe("ssh");
    // the default `--node 1` is the first node: ONCE's alias for index 0
    expect(seen[0]).toContain("postgres-agy-fixture-0");
    expect(seen[0]!.at(-1)).toBe("'patronictl' '-c' '/etc/patroni/patroni.yml' 'list'");
  });

  test("run rejects an out-of-range node", async () => {
    const runner = async () => ({ exit: 0, out: "", err: "" });
    const result = await operator.run(fixtureFile, "status", ["--node", "4"], runner, {COLORS_PAR_PROVIDER_BACKEND:"r2"});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("--node must be between 1 and 3");
  });
});

// --- the machine keypair -----------------------------------------------------

describe("ssh", () => {
  test("a build never names the operator's home", () => {
    // Committed goldens must mean the same thing on every workstation, so a
    // build renders a fixed placeholder rather than reading ~/.ssh.
    const opts = ssh.withMachineKey(fixture({ "red/event": "build" }));
    expect(opts["ssh-private-key-path"]).toBe("/home/build-placeholder/.ssh/postgres-agy-fixture");
    expect(opts["ssh-public-key-path"]).toBe("/home/build-placeholder/.ssh/postgres-agy-fixture.pub");
    // The placeholder lands on the provider's own machine-key key.
    expect(opts["digitalocean-ssh-keys"]).toBeUndefined();
    expect(String(process.env.HOME)).not.toContain("build-placeholder");
  });

  test("a dry-run is held to the same rule as a build", () => {
    expect(ssh.renderedOnly({ "red/event": "build" })).toBe(true);
    expect(ssh.renderedOnly({ "red/event": "create", "red/dry-run": true })).toBe(true);
    expect(ssh.renderedOnly({ "red/event": "create" })).toBe(false);
    expect(ssh.withMachineKey(fixture({ "red/event": "create", "red/dry-run": true }))["ssh-private-key-path"])
      .toBe("/home/build-placeholder/.ssh/postgres-agy-fixture");
  });

  test("opt-out opts pass through untouched", () => {
    const opts = optout({ "red/event": "build" });
    expect(ssh.withMachineKey(opts)).toEqual(opts);
    expect(ssh.withMachineKey(opts)["ssh-private-key-path"]).toBe("/fixture/external");
  });
});

// --- ~/.ssh/config -----------------------------------------------------------

describe("ssh-config", () => {
  const opts = fixture({ profile: "postgres-agy-digitalocean" });

  test("the deployment claims one alias per node and the bare profile", () => {
    expect(sshConfig.aliases(opts)).toEqual(
      ["postgres-agy-digitalocean", "postgres-agy-digitalocean-0", "postgres-agy-digitalocean-1", "postgres-agy-digitalocean-2"]);
  });

  test("the identity file stays unexpanded", () => {
    expect(sshConfig.identityFile(opts)).toBe("~/.ssh/postgres-agy-digitalocean");
  });

  test("a foreign stanza is found for any alias, not just the first", () => {
    const lines = "Host something\n  HostName 1.2.3.4\n\nHost postgres-agy-digitalocean-2\n  HostName 5.6.7.8\n"
      .split("\n");
    expect(sshConfig.foreignStanzaLine(lines, "postgres-agy-digitalocean")).toBeUndefined();
    expect(sshConfig.foreignStanzaLine(lines, "postgres-agy-digitalocean-2")).toBe(4);
  });

  test("our own managed block is not foreign for any alias in it", () => {
    const lines = [
      "# BEGIN postgres-agy-digitalocean ANSIBLE MANAGED BLOCK",
      "Host postgres-agy-digitalocean", "  HostName 1.2.3.4",
      "Host postgres-agy-digitalocean-0", "  HostName 1.2.3.4",
      "Host postgres-agy-digitalocean-1", "  HostName 1.2.3.5",
      "Host postgres-agy-digitalocean-2", "  HostName 1.2.3.6",
      "# END postgres-agy-digitalocean ANSIBLE MANAGED BLOCK",
    ];
    for (const alias of sshConfig.aliases(opts)) {
      expect(sshConfig.foreignStanzaLine(lines, alias, "postgres-agy-digitalocean")).toBeUndefined();
    }
  });

  test("a node stanza outside our block is still foreign", () => {
    const lines = [
      "# BEGIN postgres-agy-digitalocean ANSIBLE MANAGED BLOCK",
      "Host postgres-agy-digitalocean", "  HostName 1.2.3.4",
      "# END postgres-agy-digitalocean ANSIBLE MANAGED BLOCK",
      "Host postgres-agy-digitalocean-1", "  HostName 9.9.9.9",
    ];
    expect(sshConfig.foreignStanzaLine(lines, "postgres-agy-digitalocean-1", "postgres-agy-digitalocean")).toBe(5);
  });

  test("a global option above the first Host blocks the run", () => {
    expect(sshConfig.leadingOptionLine(["ServerAliveInterval 60", "Host x"])).toBe(1);
    expect(sshConfig.leadingOptionLine(["# a comment", "", "Host x", "  User root"]))
      .toBeUndefined();
    expect(sshConfig.leadingOptionLine(["Host x", "  ServerAliveInterval 60"])).toBeUndefined();
  });

  test("the refusal is reported as a failed step", () => {
    const refused = sshConfig.preflight(opts, {
      adoptError: () => "no",
      placementError: () => undefined,
    });
    expect(refused["red/exit"]).toBe(1);
    expect(refused["red/err"]).toBe("no");
    const passed = sshConfig.preflight(opts, {
      adoptError: () => undefined,
      placementError: () => undefined,
    });
    expect(passed["red/exit"]).toBeUndefined();
  });
});
