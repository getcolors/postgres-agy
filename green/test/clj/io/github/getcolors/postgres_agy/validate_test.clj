(ns io.github.getcolors.postgres-agy.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
                        [io.github.getcolors.postgres-agy.validate :as validate]))

(def base
  (assoc (green-cli/read-state "test/fixtures/colors.yml" (slurp "test/fixtures/colors.yml")) :provider-backend "r2"))

(def optout
  (assoc (green-cli/read-state "test/fixtures/optout.yml" (slurp "test/fixtures/optout.yml")) :provider-backend "r2"))

(deftest valid-fixture-test
  (testing "default fixture produces no errors"
    (is (empty? (validate/state-errors base)))))

(deftest both-keypair-modes-are-renderable
  ;; The SSH Keypair Standard has two modes and conformance means both hold.
  (is (empty? (validate/state-errors optout)))
  (is (validate/keygen? base))
  (is (not (validate/keygen? optout)))
  (testing "the machine key is never required: its absence is keygen mode"
    (is (not-any? #(re-find #"digitalocean-ssh-keys" %) (validate/state-errors base)))))

(deftest the-private-key-path-is-desired-state-in-opt-out-mode-only
  (is (some #{":ssh-private-key-path is required for external SSH access"}
            (validate/state-errors (dissoc optout :digitalocean-ssh-private-key))))
  (testing "keygen mode names the generated key itself and asks for no path"
    (is (empty? (validate/state-errors (dissoc base :digitalocean-ssh-private-key))))))

(deftest env-errors-test
  (testing "COLORS_PAR_PROFILE is rejected"
    (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "override"})))
    (is (nil? (validate/env-errors {})))))

(deftest required-keys-test
  (testing "missing profile"
    (is (seq (validate/state-errors (dissoc base :profile)))))
  (testing "missing digitalocean-name"
    (is (empty? (validate/state-errors (dissoc base :digitalocean-name)))))
  (testing "missing cluster-host"
    (is (seq (validate/state-errors (dissoc base :cluster-host))))))

(deftest cluster-topology-validation-test
  (testing "cluster-nodes must be 3"
    (is (seq (validate/state-errors (assoc base :cluster-nodes 2))))
    (is (seq (validate/state-errors (assoc base :cluster-nodes 4))))
    (is (empty? (validate/state-errors (assoc base :cluster-nodes 3)))))

  (testing "postgres-version must be >= 15"
    (is (seq (validate/state-errors (assoc base :postgres-version 14))))
    (is (empty? (validate/state-errors (assoc base :postgres-version 16))))
    (is (empty? (validate/state-errors (assoc base :postgres-version 17)))))

  (testing "patroni-synchronous-node-count must be 1 or 2"
    (is (empty? (validate/state-errors (assoc base :patroni-synchronous-node-count 1))))
    (is (empty? (validate/state-errors (assoc base :patroni-synchronous-node-count 2))))
    (is (seq (validate/state-errors (assoc base :patroni-synchronous-node-count 3))))
    (is (seq (validate/state-errors (assoc base :patroni-synchronous-node-count 0)))))

  (testing "patroni-ttl must exceed 2 * loop-wait"
    (is (seq (validate/state-errors (assoc base :patroni-loop-wait 15 :patroni-ttl 30))))
    (is (empty? (validate/state-errors (assoc base :patroni-loop-wait 10 :patroni-ttl 30))))))

(deftest port-collision-validation-test
  (testing "exclusive ports must not collide"
    (is (seq (validate/state-errors (assoc base :patroni-rest-port 2379 :etcd-client-port 2379)))))

  (testing "postgres-port can equal haproxy-primary-port"
    (is (empty? (validate/state-errors (assoc base :postgres-port 5432 :haproxy-primary-port 5432))))))

(deftest secrets-validation-test
  (testing "secret errors reported when credentials missing"
    (let [errors (validate/secret-errors base)]
      (is (seq errors))
      (is (some #(re-find #"POSTGRES_ADMIN_PASSWORD" %) errors))
      (is (some #(re-find #"BACKUP_R2_ACCESS_KEY_ID" %) errors)))))

(deftest ingress-is-scoped-and-valid
  (doseq [key [:digitalocean-ssh-sources :digitalocean-client-sources]]
    (is (seq (validate/state-errors (assoc base key ["0.0.0.0/0"]))))
    (is (seq (validate/state-errors (assoc base key []))))
    (is (seq (validate/state-errors (assoc base key ["invalid-cidr"]))))))
