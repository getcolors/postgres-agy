(ns io.github.getcolors.postgres-agy.tools-test
  (:require [cheshire.core :as json] [clojure.java.io :as io] [clojure.string :as str]
            [clojure.test :refer [deftest is testing]] [clojure.walk :as walk]
            [io.github.getcolors.postgres-agy.tools :as tools]
            [io.github.getcolors.postgres-agy.validate-test :as validation]))
(def base (assoc validation/base :green/event :build))
(def optout (assoc validation/optout :green/event :build))
(def recorded {:nodes (mapv (fn [i] {:node_id (str i) :index i :role nil :provider "digitalocean" :name (str "db-" i)
                                     :ip (str "203.0.113." (inc i)) :vpc_ip (str "10.20.0." (inc i)) :user "ubuntu" :sudoer "root"}) (range 3))})
(def converged (assoc base :green/event :create :colors-compute/cluster recorded :colors-compute/shared {:params {:provider "digitalocean" :network_cidr "10.20.0.0/20"}} :ssh-private-key-path "/tmp/owned"))
(deftest application-uses-library-node-and-network-facts
  (is (= [1 2 3] (mapv :ordinal (tools/nodes converged))))
  (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip (tools/nodes converged))))
  (is (= "10.20.0.0/20" (:vpc-cidr (tools/data-fn converged))))
  (is (= "ubuntu" (get-in (json/parse-string (tools/inventory converged) true) [:all :children :postgres :hosts :db-0 :ansible_user])))
  (is (thrown? Exception (tools/data-fn (dissoc converged :colors-compute/shared)))))
(deftest planning-is-deterministic-and-delete-retains-recorded-nodes
  (is (= (tools/nodes base) (tools/nodes base)))
  (is (= 3 (count (tools/nodes (assoc converged :green/event :delete :cluster-nodes 1))))))
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
