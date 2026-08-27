// The port of green's test suite: validate, utils, tools, workflow, operator.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Opts } from "red/workflow";
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

  test("ssh alias", () => {
    expect(utils.sshAlias({ profile: "postgres-agy" }, 1)).toBe("postgres-agy-1");
    expect(utils.sshAlias({ profile: "my-pg" }, 2)).toBe("my-pg-2");
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

  test("valid CIDRs accepted", () => {
    expect(validate.validCidr("10.0.0.0/16")).toBe(true);
    expect(validate.validCidr("192.168.1.1/32")).toBe(true);
  });

  test("0.0.0.0/0 rejected in ssh and client sources", () => {
    expect(validate.stateErrors(
      fixture({ "digitalocean-ssh-sources": ["0.0.0.0/0"] })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "digitalocean-client-sources": ["0.0.0.0/0"] })).length).toBeGreaterThan(0);
  });

  test("secret errors reported when credentials missing", () => {
    const errors = validate.secretErrors(fixture());
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("POSTGRES_ADMIN_PASSWORD"))).toBe(true);
    expect(errors.some((e) => e.includes("BACKUP_R2_ACCESS_KEY_ID"))).toBe(true);
  });
});

// --- tools -------------------------------------------------------------------

describe("tools", () => {
  test("fallback nodes topology", () => {
    const ns = tools.nodes(fixture());
    expect(ns.length).toBe(3);
    expect(ns[0]!.name).toBe("postgres-agy-1");
    expect(ns[0]!["public-ip"]).toBe("192.0.2.11");
    expect(ns[0]!["private-ip"]).toBe("10.114.0.11");
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
    expect(seen[0]).toContain("postgres-agy-fixture-1");
    expect(seen[0]!.at(-1)).toBe("'patronictl' '-c' '/etc/patroni/patroni.yml' 'list'");
  });

  test("run rejects an out-of-range node", async () => {
    const runner = async () => ({ exit: 0, out: "", err: "" });
    const result = await operator.run(fixtureFile, "status", ["--node", "4"], runner, {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("--node must be between 1 and 3");
  });
});
