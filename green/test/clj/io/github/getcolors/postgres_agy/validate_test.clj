(ns io.github.getcolors.postgres-agy.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.once.compute-cluster :as cluster]
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
  ;; The list and CIDR checks are ONCE's, with its messages; the refusal of the
  ;; world is this package's own and holds however the list is spelled.
  (doseq [k [:digitalocean-ssh-sources :digitalocean-client-sources]]
    (testing (str k)
      (is (= [(str k " must not contain 0.0.0.0/0; administrative and database ingress stay scoped")]
             (validate/state-errors (assoc base k ["0.0.0.0/0"]))))
      (is (some #(re-find #"must not contain 0.0.0.0/0" %)
                (validate/state-errors (assoc base k "129.159.242.163/32, 0.0.0.0/0"))))
      (is (= [(str k " must list at least one CIDR")]
             (validate/state-errors (assoc base k []))))
      (is (= [(str k " entry \"10.0.0.1\" is not an IPv4 or IPv6 CIDR")]
             (validate/state-errors (assoc base k ["10.0.0.1"]))))))
  (testing "a string is a list, the way an overlay carries one"
    (is (empty? (validate/state-errors (assoc base :digitalocean-ssh-sources "10.0.0.0/16, 192.168.1.1/32"))))))

(deftest the-spec-describes-one-homogeneous-role-on-a-discovered-network
  ;; The Compute Cluster Standard's spec is data ONCE reads; this is the one
  ;; place its content is asserted, so a drift in any colour is a test
  ;; failure and not a rendered surprise.
  (is (= [] (cluster/spec-errors validate/spec)))
  (is (= ["digitalocean"] (keys (:registry validate/spec))))
  (is (= "digitalocean" (:default validate/spec)))
  (is (= {:mode :discovered} (get-in validate/spec [:registry "digitalocean" :network])))
  (is (= {:non-empty ["ssh-sources" "client-sources"] :may-be-empty []} (:sources validate/spec)))
  (is (= [{:role nil :count-key :cluster-nodes :count 3 :fallback-offset 11}]
         (:roles validate/spec)))
  (is (nil? (:entry validate/spec)) "the bare profile alias reaches node 0")
  (is (= "10.114.0.0/20" (:fallback-subnet validate/spec)))
  (is (= [] (cluster/topology-errors validate/spec base)))
  (testing "the registry's required keys are demanded through ONCE"
    (doseq [k (get-in validate/compute-providers ["digitalocean" :required])]
      (is (some #(re-find (re-pattern (str k " is required")) %)
                (validate/state-errors (dissoc base k)))
          (str k)))))

(deftest the-vpc-is-discovered-and-cannot-be-described
  (doseq [k validate/forbidden-vpc-keys]
    (is (some #(re-find #"must not be configured; the regional default VPC is discovered" %)
              (validate/state-errors (assoc base k "10.0.0.0/16")))
        (str k)))
  (testing "the two spellings ONCE knows are refused by its discovered-network
            rule, once, with its message"
    (is (= [":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime"]
           (validate/state-errors (assoc base :digitalocean-vpc-uuid "00000000-0000-0000-0000-000000000000"))))
    (is (= [":digitalocean-vpc-cidr must be absent; this package must not create a VPC"]
           (validate/state-errors (assoc base :digitalocean-vpc-cidr "10.114.0.0/20")))))
  (is (some #(re-find #":digitalocean-vpc-mode must be default" %)
            (validate/state-errors (assoc base :digitalocean-vpc-mode "explicit")))))

(deftest the-count-and-the-provider-are-checked-by-once-too
  (is (some #{":cluster-nodes must be a positive integer"}
            (validate/state-errors (assoc base :cluster-nodes "3"))))
  (is (some #{":provider-compute must be one of digitalocean"}
            (validate/state-errors (assoc base :provider-compute "hcloud"))))
  (is (some #(re-find #"unsupported :provider-dns" %)
            (validate/state-errors (assoc base :provider-dns "yandex")))))

(deftest secrets-validation-test
  (testing "secret errors reported when credentials missing"
    (let [errors (validate/secret-errors base)]
      (is (seq errors))
      (is (some #(re-find #"POSTGRES_ADMIN_PASSWORD" %) errors))
      (is (some #(re-find #"BACKUP_R2_ACCESS_KEY_ID" %) errors)))))
