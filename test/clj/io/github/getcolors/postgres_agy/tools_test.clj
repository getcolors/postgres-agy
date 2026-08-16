(ns io.github.getcolors.postgres-agy.tools-test
  (:require [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-agy.tools :as tools]))

(def base
  (green-cli/read-state "test/fixtures/colors.yml" (slurp "test/fixtures/colors.yml")))

(deftest nodes-test
  (testing "fallback nodes topology"
    (let [ns (tools/nodes base)]
      (is (= 3 (count ns)))
      (is (= "postgres-agy-1" (:name (first ns))))
      (is (= "192.0.2.11" (:public-ip (first ns))))
      (is (= "10.114.0.11" (:private-ip (first ns)))))))

(deftest infrastructure-specs-test
  (testing "infrastructure specs render"
    (let [specs (tools/infrastructure-specs base)]
      (is (= 1 (count specs)))
      (is (= :io.github.getcolors.postgres-agy.tools.infrastructure/main.tf
             (:template (first specs)))))))

(deftest dns-specs-test
  (testing "dns specs render"
    (let [specs (tools/dns-specs base)]
      (is (= 1 (count specs)))
      (is (= :io.github.getcolors.postgres-agy.tools.dns/main.tf
             (:template (first specs)))))))

(deftest cluster-specs-test
  (testing "cluster specs include all required templates"
    (let [specs (tools/cluster-specs base)
          templates (set (map :template specs))]
      (is (contains? templates :io.github.getcolors.postgres-agy.tools.ansible-remote/main.yml))
      (is (contains? templates :io.github.getcolors.postgres-agy.tools.ansible-remote/etcd.service.j2))
      (is (contains? templates :io.github.getcolors.postgres-agy.tools.ansible-remote/patroni.yml.j2))
      (is (contains? templates :io.github.getcolors.postgres-agy.tools.ansible-remote/haproxy.cfg.j2))
      (is (contains? templates :io.github.getcolors.postgres-agy.tools.ansible-remote/pgbackrest.conf.j2))
      (is (contains? templates :io.github.getcolors.postgres-agy.tools.ansible-remote/postgres-agy-heartbeat.service.j2))
      (is (contains? templates :io.github.getcolors.postgres-agy.tools.ansible-remote/postgres-agy-restore-check.service.j2)))))
