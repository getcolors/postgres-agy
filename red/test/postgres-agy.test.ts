// The port of green's test suite: validate, utils, tools, workflow, operator.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepError, type Opts } from "red/workflow";
import { computeCluster } from "package-once-red";
import * as operator from "../src/operator.ts";
import * as tools from "../src/tools.ts";
import * as utils from "../src/utils.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");

function fixture(overrides: Opts = {}): Opts {
  return { ...(Bun.YAML.parse(readFileSync(fixtureFile, "utf8")) as Opts), ...overrides };
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

  test("node naming", () => {
    expect(utils.nodeName({ "digitalocean-name": "postgres-agy" }, 1)).toBe("postgres-agy-1");
    expect(utils.nodeName({ "digitalocean-name": "my-pg" }, 2)).toBe("my-pg-2");
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

  test("COLORS_PAR_PROFILE is rejected", () => {
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "override" }).length).toBeGreaterThan(0);
    expect(validate.envErrors({})).toEqual([]);
  });

  test("missing required keys are reported", () => {
    for (const key of ["profile", "digitalocean-name", "cluster-host"]) {
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

  test("source lists are ONCE's to check; the world is this package's to refuse", () => {
    // The list and CIDR checks are ONCE's, with its messages; the refusal of
    // the world is this package's own and holds however the list is spelled.
    for (const key of ["digitalocean-ssh-sources", "digitalocean-client-sources"]) {
      expect(validate.stateErrors(fixture({ [key]: ["0.0.0.0/0"] })))
        .toEqual([`:${key} must not contain 0.0.0.0/0; administrative and database ingress stay scoped`]);
      expect(validate.stateErrors(fixture({ [key]: "129.159.242.163/32, 0.0.0.0/0" }))
        .some((e) => e.includes("must not contain 0.0.0.0/0"))).toBe(true);
      expect(validate.stateErrors(fixture({ [key]: [] }))).toEqual([`:${key} must list at least one CIDR`]);
      expect(validate.stateErrors(fixture({ [key]: ["10.0.0.1"] })))
        .toEqual([`:${key} entry "10.0.0.1" is not an IPv4 or IPv6 CIDR`]);
    }
    // a string is a list, the way an overlay carries one
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": "10.0.0.0/16, 192.168.1.1/32" }))).toEqual([]);
  });

  test("the spec describes one homogeneous role on a discovered network", () => {
    // The Compute Cluster Standard's spec is data ONCE reads; this is the one
    // place its content is asserted, so a drift in any colour is a test
    // failure and not a rendered surprise.
    expect(computeCluster.specErrors(validate.spec)).toEqual([]);
    expect(Object.keys(validate.spec.registry)).toEqual(["digitalocean"]);
    expect(validate.spec.default).toBe("digitalocean");
    expect(validate.spec.registry.digitalocean!.network).toEqual({ mode: "discovered" });
    expect(validate.spec.sources).toEqual({ nonEmpty: ["ssh-sources", "client-sources"], mayBeEmpty: [] });
    expect(validate.spec.roles).toEqual([{ role: null, countKey: "cluster-nodes", count: 3, fallbackOffset: 11 }]);
    // the bare profile alias reaches node 0
    expect(validate.spec.entry).toBeUndefined();
    expect(validate.spec.fallbackSubnet).toBe("10.114.0.0/20");
    expect(computeCluster.topologyErrors(validate.spec, fixture())).toEqual([]);
    // the registry's required keys are demanded through ONCE
    for (const key of validate.computeProviders.digitalocean!.required) {
      const base = fixture();
      delete base[key];
      expect(validate.stateErrors(base).some((e) => e.includes(`${key} is required`))).toBe(true);
    }
  });

  test("the VPC is discovered and cannot be described", () => {
    for (const key of validate.forbiddenVpcKeys) {
      expect(validate.stateErrors(fixture({ [key]: "10.0.0.0/16" }))
        .some((e) => e.includes("must not be configured; the regional default VPC is discovered"))).toBe(true);
    }
    // the two spellings ONCE knows are refused by its discovered-network
    // rule, once, with its message
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-uuid": "00000000-0000-0000-0000-000000000000" })))
      .toEqual([":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime"]);
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-cidr": "10.114.0.0/20" })))
      .toEqual([":digitalocean-vpc-cidr must be absent; this package must not create a VPC"]);
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-mode": "explicit" }))
      .some((e) => e.includes(":digitalocean-vpc-mode must be default"))).toBe(true);
  });

  test("the count and the provider are checked by ONCE too", () => {
    expect(validate.stateErrors(fixture({ "cluster-nodes": "3" })))
      .toContain(":cluster-nodes must be a positive integer");
    expect(validate.stateErrors(fixture({ "provider-compute": "hcloud" })))
      .toContain(":provider-compute must be one of digitalocean");
    expect(validate.stateErrors(fixture({ "provider-dns": "yandex" }))
      .some((e) => e.includes("unsupported :provider-dns"))).toBe(true);
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
const recorded = (): computeCluster.ClusterParams => tools.legacyParams(fixture(), legacyOutputs);

const without = (o: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

const converged = (): Opts => fixture({ "once/cluster": recorded() });

describe("tools", () => {
  test("fallback nodes topology", () => {
    // ONCE's fallbacks at offset 11, the package's names
    const ns = tools.nodes(fixture());
    expect(ns.length).toBe(3);
    expect(ns.map((n) => n.name)).toEqual(["postgres-agy-1", "postgres-agy-2", "postgres-agy-3"]);
    expect(ns.map((n) => n["public-ip"])).toEqual(["192.0.2.11", "192.0.2.12", "192.0.2.13"]);
    expect(ns.map((n) => n["private-ip"])).toEqual(["10.114.0.11", "10.114.0.12", "10.114.0.13"]);
    expect(ns.map((n) => n.ordinal)).toEqual([1, 2, 3]);
    expect(tools.dataFn(fixture())["vpc-cidr"]).toBe("10.114.0.0/20");
    expect(tools.nodes(fixture())).toEqual(ns);
  });

  test("the aliases are the standard's", () => {
    // Compute Cluster Standard §6: the bare profile reaches node 0, then
    // `<profile>-<index>`; `--node N` is 1-based and lands on index N-1.
    expect(tools.nodes(fixture()).map((n) => n.alias))
      .toEqual(["postgres-agy-fixture-0", "postgres-agy-fixture-1", "postgres-agy-fixture-2"]);
    expect(tools.sshAlias(fixture(), 1)).toBe("postgres-agy-fixture-0");
    expect(tools.sshAlias(fixture(), 3)).toBe("postgres-agy-fixture-2");
    expect(computeCluster.aliases(validate.spec, fixture()).slice(1))
      .toEqual(tools.nodes(fixture()).map((n) => n.alias));
  });

  test("a real run reads every node from the adopted cluster", () => {
    const opts = converged();
    const ns = tools.nodes(opts);
    expect(ns.map((n) => n["public-ip"])).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    expect(ns.map((n) => n["private-ip"])).toEqual(["10.20.0.1", "10.20.0.2", "10.20.0.3"]);
    expect(ns.map((n) => n.name)).toEqual(["postgres-agy-1", "postgres-agy-2", "postgres-agy-3"]);
    expect(tools.dataFn(opts)["vpc-cidr"]).toBe("10.20.0.0/20");
    const inv = JSON.parse(tools.inventory(opts));
    expect(inv.all.children.postgres.hosts["postgres-agy-2"].ansible_host).toBe("203.0.113.2");
    expect(((tools.dnsSpecs(opts)[0]!.data as Opts).nodes as tools.Node[]).map((n) => n["public-ip"]))
      .toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    expect(((tools.acceptanceSpecs(opts)[0]!.data as Opts).nodes as tools.Node[]).map((n) => n.alias))
      .toEqual(["postgres-agy-fixture-0", "postgres-agy-fixture-1", "postgres-agy-fixture-2"]);
  });

  test("the legacy state is translated into params", () => {
    const params = recorded();
    expect(params.provider).toBe("digitalocean");
    expect(params.nodes!.map((n) => n.index)).toEqual([0, 1, 2]);
    expect(params.nodes!.every((n) => n.role === null)).toBe(true);
    expect(params.nodes!.map((n) => n.name)).toEqual(["postgres-agy-1", "postgres-agy-2", "postgres-agy-3"]);
    const second = params.nodes![1]!;
    expect([second.ip, second.vpc_ip, second.user, second.sudoer]).toEqual(["203.0.113.2", "10.20.0.2", "root", "root"]);
    expect([params.vpc_id, params.vpc_ip_range]).toEqual(["5a6b7c8d-0000-4000-8000-000000000001", "10.20.0.0/20"]);
    // ONCE accepts the translation as a whole cluster
    expect(computeCluster.nodeErrors(validate.spec, fixture(), params)).toEqual([]);
    expect(tools.paramsErrors(params)).toEqual([]);
  });

  test("the legacy translation refuses to guess", () => {
    const refusal = (outputs: Record<string, unknown>): Error => {
      try {
        tools.legacyParams(fixture(), outputs);
      } catch (e) {
        return e as Error;
      }
      throw new Error("not refused");
    };
    // lists that disagree with each other; the SDK's StepError, so readState
    // reports it
    const e = refusal({ ...legacyOutputs, node_public_ips: ["203.0.113.1", "203.0.113.2"] });
    expect(e).toBeInstanceOf(StepError);
    expect(e.message).toBe("legacy state lists 2 public addresses and 3 private addresses; refusing to guess the cluster");
    // lists that disagree with cluster-nodes
    const four = (v: unknown) => [...(v as unknown[]), (v as unknown[]).at(-1)];
    expect(refusal({ ...legacyOutputs, node_public_ips: four(legacyOutputs.node_public_ips),
                     node_private_ips: four(legacyOutputs.node_private_ips) }).message)
      .toBe("legacy state lists 4 public addresses and 4 private addresses; refusing to guess the cluster");
    // no network
    expect(refusal(without(legacyOutputs, "vpc_id")).message).toBe("legacy state carries no vpc_id");
    expect(refusal({ ...legacyOutputs, vpc_id: " " }).message).toBe("legacy state carries no vpc_id");
    expect(refusal(without(legacyOutputs, "vpc_ip_range")).message).toBe("legacy state carries no vpc_ip_range");
    // the range's form is paramsErrors' to refuse, the same as a recorded state
    expect(tools.paramsErrors(tools.legacyParams(fixture(), { ...legacyOutputs, vpc_ip_range: "10.20.0.1/20" })))
      .toEqual(['compute state vpc_ip_range "10.20.0.1/20" is not a canonical IPv4 network such as 10.40.0.0/24']);
  });

  test("params errors hold the extension keys", () => {
    const params = recorded();
    expect(tools.paramsErrors(params)).toEqual([]);
    expect(tools.paramsErrors(without(params, "vpc_id"))).toEqual(["compute state carries no vpc_id"]);
    expect(tools.paramsErrors({ ...params, vpc_id: " " })).toEqual(["compute state carries no vpc_id"]);
    expect(tools.paramsErrors({ ...params, vpc_ip_range: null })).toEqual(["compute state carries no vpc_ip_range"]);
    expect(tools.paramsErrors({ ...params, vpc_ip_range: "10.20.0.1/20" }))
      .toEqual(['compute state vpc_ip_range "10.20.0.1/20" is not a canonical IPv4 network such as 10.40.0.0/24']);
    expect(tools.paramsErrors({})).toEqual(["compute state carries no vpc_id", "compute state carries no vpc_ip_range"]);
  });

  test("load-infrastructure adopts the state preflight handed on", async () => {
    const params = recorded();
    const load = (state: unknown) =>
      tools.loadInfrastructureStep(fixture({ "red/event": "delete", "postgres-agy/state": state }));
    // a recorded cluster
    let r = await load({ params });
    expect(r["red/exit"]).toBe(0);
    expect(r["once/cluster"]).toEqual(params);
    expect(r["postgres-agy/infrastructure-present?"]).toBe(true);
    expect("postgres-agy/state" in r).toBe(false);
    expect(tools.nodes(r).map((n) => n["public-ip"])).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    // a readable state that records no cluster leaves nothing to clean up
    r = await load({ params: undefined });
    expect(r["red/exit"]).toBe(0);
    expect(r["postgres-agy/infrastructure-present?"]).toBe(false);
    expect("once/cluster" in r).toBe(false);
    // an unreadable backend fails closed
    r = await load({ error: "tofu output failed: no backend" });
    expect(r["red/exit"]).toBe(1);
    expect(String(r["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(r["red/err"])).toContain("no backend");
    // a partial cluster is refused with ONCE's message
    r = await load({ params: { ...params, nodes: params.nodes!.slice(0, 2) } });
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe("the compute stage did not report nodes this package declares: 2");
    // an adopted cluster without its extension keys is refused
    r = await load({ params: without(params, "vpc_id") });
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe("compute state carries no vpc_id");
  });

  test("a real create resolves the cluster from the apply", () => {
    // the apply's `params` output is what every later stage reads; never the
    // fallbacks
    const params = recorded();
    const opts = fixture({ "red/event": "create" });
    const apply = (p: unknown) => tools.resolveInfrastructure(opts, {
      ...opts, "red/exit": 0, ...(p === undefined ? {} : { "postgres-agy/outputs": { params: p } }),
    });
    let r = apply(params);
    expect(r["red/exit"]).toBe(0);
    expect(r["once/cluster"]).toEqual(params);
    expect(tools.nodes(r).map((n) => n["public-ip"])).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    r = apply(undefined);
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe(computeCluster.noParamsMessage);
    r = apply({ ...params, nodes: params.nodes!.slice(0, 2) });
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe("the compute stage did not report nodes this package declares: 2");
    r = apply(without(params, "vpc_ip_range"));
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe("compute state carries no vpc_ip_range");
    // a failed apply, a delete and a build hand the result on untouched
    expect(tools.resolveInfrastructure(opts, { ...opts, "red/exit": 1, "red/err": "apply failed" })["red/exit"]).toBe(1);
    expect("once/cluster" in tools.resolveInfrastructure({ ...opts, "red/event": "build" }, { ...opts, "red/exit": 0 })).toBe(false);
    expect(tools.resolveInfrastructure({ ...opts, "red/event": "delete" }, { ...opts, "red/exit": 0 })["red/exit"]).toBe(0);
  });

  test("the local play receives one block of aliases", () => {
    // ssh-config.md: the addresses and the aliases are extra-vars, never
    // rendered; the marker is the profile; the bare profile reaches node 0
    const vars = tools.ansibleLocalExtraVars({ ...converged(), "red/event": "create" });
    expect(vars.host_alias).toBe("postgres-agy-fixture");
    expect(vars.ssh_hosts).toEqual([
      { name: "postgres-agy-fixture", ip: "203.0.113.1" },
      { name: "postgres-agy-fixture-0", ip: "203.0.113.1" },
      { name: "postgres-agy-fixture-1", ip: "203.0.113.2" },
      { name: "postgres-agy-fixture-2", ip: "203.0.113.3" },
    ]);
    expect(vars.block_state).toBe("present");
    expect(vars.ssh_private_key).toBe("~/.ssh/id_ed25519");
    // the pre-standard per-node blocks are named so the play can remove them
    expect(vars.legacy_aliases).toEqual(["postgres-agy-fixture-1", "postgres-agy-fixture-2", "postgres-agy-fixture-3"]);
    expect(tools.ansibleLocalExtraVars(fixture({ "red/event": "delete" })).block_state).toBe("absent");
    // a build renders the play without an address
    const rendered = readFileSync(join(import.meta.dir, "../resources/tools/ansible-local/main.yml"), "utf8");
    expect(rendered).toContain('marker: "# {mark} {{ host_alias }} ANSIBLE MANAGED BLOCK"');
    expect(rendered).toContain("{% for host in ssh_hosts %}");
    expect(rendered).toContain("insertbefore: BOF");
    expect(/192\.0\.2|203\.0\.113/.test(rendered)).toBe(false);
  });

  test("infrastructure specs render", () => {
    const specs = tools.infrastructureSpecs(fixture());
    expect(specs.length).toBe(1);
    expect(specs[0]!.template!.name).toBe("infrastructure/main.tf");
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
const recordedParams = (): computeCluster.ClusterParams => ({
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
const start = (opts: Opts, env: Record<string, string | undefined>, state: computeCluster.ClusterParams | undefined) =>
  workflow.startStep(opts, env, async () => state);
// The shape `red/tofu` throws: the SDK's StepError. Only that is an unreadable
// backend; anything else propagates as a defect.
const startUnreadable = (opts: Opts, env: Record<string, string | undefined>) =>
  workflow.startStep(opts, env, async () => { throw new StepError("tofu output failed: no backend"); });
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

  test("delete flow edges", () => {
    expect(workflow.wireFn("postgres-agy/start", { "red/event": "delete" }))
      .toEqual([workflow.startStep, "postgres-agy/load-infrastructure"]);
    expect(workflow.wireFn("postgres-agy/load-infrastructure", { "red/event": "delete" }))
      .toEqual([tools.loadInfrastructureStep, "postgres-agy/cluster"]);
    expect(workflow.wireFn("postgres-agy/cluster", { "red/event": "delete" }))
      .toEqual([tools.clusterStep, "postgres-agy/ansible-local"]);
    expect(workflow.wireFn("postgres-agy/ansible-local", { "red/event": "delete" }))
      .toEqual([tools.ansibleLocalStep, "postgres-agy/dns"]);
    expect(workflow.wireFn("postgres-agy/dns", { "red/event": "delete" }))
      .toEqual([tools.dnsStep, "postgres-agy/infrastructure"]);
    expect(workflow.wireFn("postgres-agy/infrastructure", { "red/event": "delete" }))
      .toEqual([tools.infrastructureStep, "postgres-agy/generated-cleanup"]);
    expect(workflow.wireFn("postgres-agy/generated-cleanup", { "red/event": "delete" }))
      .toEqual([tools.generatedCleanupStep]);
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
      const r = await workflow.startStep(opts, {}, never);
      expect(r["red/exit"]).toBe(0);
      expect("postgres-agy/state" in r).toBe(false);
    }
  });

  test("a real create demands every credential", async () => {
    const r = await start(fixture({ "red/event": "create" }), {}, undefined);
    expect(r["red/exit"]).toBe(2);
    expect(String(r["red/err"])).toContain("COLORS_PAR_POSTGRES_ADMIN_PASSWORD");
  });

  test("the destroy guard holds and lifts for exactly one run", async () => {
    const held = await start(fixture({ "red/event": "delete" }), credentials, undefined);
    expect(held["red/exit"]).toBe(2);
    expect(String(held["red/err"])).toContain("compute destruction is protected");
    expect((await start(fixture({ "red/event": "delete" }), unguarded, undefined))["red/exit"]).toBe(0);
    // the state is not read for a refused profile, nor for invalid desired state
    expect((await workflow.startStep(fixture({ "red/event": "delete" }),
                                     { ...unguarded, COLORS_PAR_PROFILE: "elsewhere" }, never))["red/exit"]).toBe(2);
    expect((await workflow.startStep(fixture({ "red/event": "delete", "cluster-nodes": 2 }), unguarded, never))["red/exit"]).toBe(2);
  });

  // --- the Compute Cluster Standard's safety boundaries

  test("a provider switch is refused before the credentials", async () => {
    for (const event of ["create", "delete"]) {
      const r = await start(fixture({ "red/event": event }), { COLORS_PAR_COMPUTE_PREVENT_DESTROY: "false" },
                            { ...recordedParams(), provider: "vultr" });
      expect(r["red/exit"]).toBe(2);
      expect(String(r["red/err"]))
        .toContain("state holds a vultr machine; set provider-compute back to vultr and delete first");
      // the validator order is the thing under test: the actionable error,
      // not a missing token for the provider that was just selected
      expect(String(r["red/err"])).not.toContain("required credential is not set");
    }
  });

  test("legacy state accepts only the default provider", async () => {
    // a recorded provider is absent from every pre-adoption state; on the one
    // provider this package offers that is the default, and the run proceeds
    // to its credentials
    for (const event of ["create", "delete"]) {
      const r = await start(fixture({ "red/event": event }), { COLORS_PAR_COMPUTE_PREVENT_DESTROY: "false" },
                            without(recordedParams(), "provider"));
      expect(r["red/exit"]).toBe(2);
      expect(String(r["red/err"])).not.toContain("state holds");
      expect(String(r["red/err"])).toContain("required credential is not set");
    }
  });

  test("a matching provider passes to the credentials", async () => {
    const r = await start(fixture({ "red/event": "create" }), {}, recordedParams());
    expect(r["red/exit"]).toBe(2);
    expect(String(r["red/err"])).not.toContain("state holds");
    expect(String(r["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("an unreadable backend counts as no state on create", async () => {
    // a fresh clone has no readable state and must still be able to create
    const r = await startUnreadable(fixture({ "red/event": "create" }), {});
    expect(r["red/exit"]).toBe(2);
    expect(String(r["red/err"])).not.toContain("could not read");
    expect(String(r["red/err"])).not.toContain("state holds");
    expect(String(r["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

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
      expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
      expect(String(result["red/err"])).not.toContain("could not read");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("an unreadable backend fails a real delete closed", async () => {
    // swallowing it is how a teardown ends up converging against 192.0.2.11.
    // Preflight hands the read on; `load-infrastructure`, the first step after
    // it and before any side effect, is where the delete stops
    const r = await startUnreadable(fixture({ "red/event": "delete" }), unguarded);
    expect(r["red/exit"]).toBe(0);
    expect(r["postgres-agy/state"]).toEqual({ error: "tofu output failed: no backend" });
    const loaded = await tools.loadInfrastructureStep(r);
    expect(loaded["red/exit"]).toBe(1);
    expect(String(loaded["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(loaded["red/err"])).toContain("no backend");
  });

  test("a real delete adopts the recorded cluster", async () => {
    const r = await start(fixture({ "red/event": "delete" }), unguarded, recordedParams());
    expect(r["red/exit"]).toBe(0);
    expect(r["postgres-agy/state"]).toEqual({ params: recordedParams() });
    const loaded = await tools.loadInfrastructureStep(r);
    expect(loaded["red/exit"]).toBe(0);
    expect(loaded["once/cluster"]).toEqual(recordedParams());
    expect(tools.nodes(loaded).map((n) => n["public-ip"])).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    // and withdraws every alias of the block it wrote
    const vars = tools.ansibleLocalExtraVars(loaded);
    expect((vars.ssh_hosts as computeCluster.SshConfigHost[]).map((h) => h.name))
      .toEqual(["postgres-agy-fixture", "postgres-agy-fixture-0", "postgres-agy-fixture-1", "postgres-agy-fixture-2"]);
    expect(vars.block_state).toBe("absent");
    // a readable state without a cluster leaves nothing to clean up
    const empty = await tools.loadInfrastructureStep(await start(fixture({ "red/event": "delete" }), unguarded, undefined));
    expect(empty["red/exit"]).toBe(0);
    expect(empty["postgres-agy/infrastructure-present?"]).toBe(false);
  });

  test("a partial cluster is refused on a real run", async () => {
    const params = recordedParams();
    const r = await start(fixture({ "red/event": "delete" }), unguarded, { ...params, nodes: params.nodes!.slice(0, 2) });
    // the switch guard reads only the provider
    expect(r["red/exit"]).toBe(0);
    const loaded = await tools.loadInfrastructureStep(r);
    expect(loaded["red/exit"]).toBe(1);
    expect(loaded["red/err"]).toBe("the compute stage did not report nodes this package declares: 2");
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
    const result = await operator.run(fixtureFile, "status", [], runner, {});
    expect(result["red/exit"]).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]![0]).toBe("ssh");
    // the default `--node 1` is the first node: ONCE's alias for index 0
    expect(seen[0]).toContain("postgres-agy-fixture-0");
    expect(seen[0]!.at(-1)).toBe("'patronictl' '-c' '/etc/patroni/patroni.yml' 'list'");
  });

  test("run rejects an out-of-range node", async () => {
    const runner = async () => ({ exit: 0, out: "", err: "" });
    const result = await operator.run(fixtureFile, "status", ["--node", "4"], runner, {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("--node must be between 1 and 3");
  });
});
