(ns io.github.getcolors.postgres-agy.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-agy.validate :as validate]))

(def base
  (green-cli/read-state "test/fixtures/colors.yml" (slurp "test/fixtures/colors.yml")))

(deftest valid-fixture-test
  (testing "default fixture produces no errors"
    (is (empty? (validate/state-errors base)))))

(deftest env-errors-test
  (testing "COLORS_PAR_PROFILE is rejected"
    (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "override"})))
    (is (nil? (validate/env-errors {})))))

(deftest required-keys-test
  (testing "missing profile"
    (is (seq (validate/state-errors (dissoc base :profile)))))
  (testing "missing digitalocean-name"
    (is (seq (validate/state-errors (dissoc base :digitalocean-name)))))
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

(deftest cidr-validation-test
  (testing "valid CIDRs accepted"
    (is (validate/valid-cidr? "10.0.0.0/16"))
    (is (validate/valid-cidr? "192.168.1.1/32")))

  (testing "0.0.0.0/0 rejected in ssh and client sources"
    (is (seq (validate/state-errors (assoc base :digitalocean-ssh-sources ["0.0.0.0/0"]))))
    (is (seq (validate/state-errors (assoc base :digitalocean-client-sources ["0.0.0.0/0"]))))))

(deftest secrets-validation-test
  (testing "secret errors reported when credentials missing"
    (let [errors (validate/secret-errors base)]
      (is (seq errors))
      (is (some #(re-find #"POSTGRES_ADMIN_PASSWORD" %) errors))
      (is (some #(re-find #"BACKUP_R2_ACCESS_KEY_ID" %) errors)))))
