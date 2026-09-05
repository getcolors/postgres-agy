(ns io.github.getcolors.postgres-agy.tools-test
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [clojure.walk :as walk]
            [green.cli :as green-cli]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.postgres-agy.tools :as tools]
            [io.github.getcolors.postgres-agy.validate :as validate]))

(def base
  (green-cli/read-state "test/fixtures/colors.yml" (slurp "test/fixtures/colors.yml")))

(def optout
  (green-cli/read-state "test/fixtures/optout.yml" (slurp "test/fixtures/optout.yml")))

(def legacy-outputs
  "A pre-adoption state exactly as `tofu output -json` parsed it: the four
  outputs, two parallel lists among them, and no `params`."
  {:node_public_ips ["203.0.113.1" "203.0.113.2" "203.0.113.3"]
   :node_private_ips ["10.20.0.1" "10.20.0.2" "10.20.0.3"]
   :vpc_id "5a6b7c8d-0000-4000-8000-000000000001"
   :vpc_ip_range "10.20.0.0/20"})

(def recorded
  "`params` as the adopted template records it, here through the legacy
  translation so the two shapes are provably one."
  (tools/legacy-params base legacy-outputs "x"))

(def converged (assoc base :once/cluster recorded))

(deftest nodes-test
  (testing "fallback nodes topology: ONCE's fallbacks at offset 11, the
            package's names"
    (let [ns (tools/nodes base)]
      (is (= 3 (count ns)))
      (is (= ["postgres-agy-1" "postgres-agy-2" "postgres-agy-3"] (mapv :name ns)))
      (is (= ["192.0.2.11" "192.0.2.12" "192.0.2.13"] (mapv :public-ip ns)))
      (is (= ["10.114.0.11" "10.114.0.12" "10.114.0.13"] (mapv :private-ip ns)))
      (is (= [1 2 3] (mapv :ordinal ns)))
      (is (= "10.114.0.0/20" (:vpc-cidr (tools/data-fn base))))
      (is (= ns (tools/nodes base)))))
  (testing "the aliases are the standard's: the bare profile reaches node 0,
            then <profile>-<index>; --node N is 1-based and lands on index N-1"
    (is (= ["postgres-agy-fixture-0" "postgres-agy-fixture-1" "postgres-agy-fixture-2"]
           (mapv :alias (tools/nodes base))))
    (is (= "postgres-agy-fixture-0" (tools/ssh-alias base 1)))
    (is (= "postgres-agy-fixture-2" (tools/ssh-alias base 3)))
    (is (= (rest (cluster/aliases validate/spec base)) (map :alias (tools/nodes base)))))
  (testing "a real run reads every node from the adopted cluster"
    (let [ns (tools/nodes converged)]
      (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip ns)))
      (is (= ["10.20.0.1" "10.20.0.2" "10.20.0.3"] (mapv :private-ip ns)))
      (is (= ["postgres-agy-1" "postgres-agy-2" "postgres-agy-3"] (mapv :name ns)))
      (is (= "10.20.0.0/20" (:vpc-cidr (tools/data-fn converged))))
      (is (= "203.0.113.2"
             (get-in (json/parse-string (tools/inventory converged) true)
                     [:all :children :postgres :hosts :postgres-agy-2 :ansible_host])))
      (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"]
             (mapv :public-ip (:nodes (:data (first (tools/dns-specs converged)))))))
      (is (= ["postgres-agy-fixture-0" "postgres-agy-fixture-1" "postgres-agy-fixture-2"]
             (mapv :alias (:nodes (:data (first (tools/acceptance-specs converged))))))))))

(deftest the-legacy-state-is-translated-into-params
  (is (= "digitalocean" (:provider recorded)))
  (is (= [0 1 2] (mapv :index (:nodes recorded))))
  (is (every? nil? (map :role (:nodes recorded))))
  (is (= ["postgres-agy-1" "postgres-agy-2" "postgres-agy-3"] (mapv :name (:nodes recorded))))
  (is (= {:ip "203.0.113.2" :vpc_ip "10.20.0.2" :user "root" :sudoer "root"}
         (select-keys (second (:nodes recorded)) [:ip :vpc_ip :user :sudoer])))
  (is (= ["5a6b7c8d-0000-4000-8000-000000000001" "10.20.0.0/20"]
         (map recorded [:vpc_id :vpc_ip_range])))
  (is (empty? (cluster/node-errors validate/spec base recorded))
      "ONCE accepts the translation as a whole cluster")
  (is (= [] (tools/params-errors recorded))))

(deftest the-legacy-translation-refuses-to-guess
  (let [refusal (fn [outputs]
                  (try (tools/legacy-params base outputs "stage-dir") nil
                       (catch clojure.lang.ExceptionInfo e e)))]
    (testing "lists that disagree with each other"
      (let [e (refusal (assoc legacy-outputs :node_public_ips ["203.0.113.1" "203.0.113.2"]))]
        (is (= "legacy state lists 2 public addresses and 3 private addresses; refusing to guess the cluster"
               (ex-message e)))
        (is (= "stage-dir" (:dir (ex-data e))) "the SDK's step-error shape, so read-state reports it")))
    (testing "lists that disagree with cluster-nodes"
      (let [four (fn [v] (conj v (last v)))]
        (is (= "legacy state lists 4 public addresses and 4 private addresses; refusing to guess the cluster"
               (ex-message (refusal (-> legacy-outputs
                                        (update :node_public_ips four)
                                        (update :node_private_ips four))))))))
    (testing "no network"
      (is (= "legacy state carries no vpc_id" (ex-message (refusal (dissoc legacy-outputs :vpc_id)))))
      (is (= "legacy state carries no vpc_id" (ex-message (refusal (assoc legacy-outputs :vpc_id " ")))))
      (is (= "legacy state carries no vpc_ip_range"
             (ex-message (refusal (dissoc legacy-outputs :vpc_ip_range))))))
    (testing "the range's form is params-errors' to refuse, the same as a recorded state"
      (is (= ["compute state vpc_ip_range \"10.20.0.1/20\" is not a canonical IPv4 network such as 10.40.0.0/24"]
             (tools/params-errors (tools/legacy-params base (assoc legacy-outputs :vpc_ip_range "10.20.0.1/20") "x")))))))

(deftest params-errors-hold-the-extension-keys
  (is (= [] (tools/params-errors recorded)))
  (is (= ["compute state carries no vpc_id"] (tools/params-errors (dissoc recorded :vpc_id))))
  (is (= ["compute state carries no vpc_id"] (tools/params-errors (assoc recorded :vpc_id " "))))
  (is (= ["compute state carries no vpc_ip_range"] (tools/params-errors (assoc recorded :vpc_ip_range nil))))
  (is (= ["compute state vpc_ip_range \"10.20.0.1/20\" is not a canonical IPv4 network such as 10.40.0.0/24"]
         (tools/params-errors (assoc recorded :vpc_ip_range "10.20.0.1/20"))))
  (is (= ["compute state carries no vpc_id" "compute state carries no vpc_ip_range"]
         (tools/params-errors {}))))

(deftest load-infrastructure-adopts-the-state-preflight-handed-on
  (let [load (fn [state]
               (tools/load-infrastructure-step
                (assoc base :green/event :delete :postgres-agy/state state)))]
    (testing "a recorded cluster"
      (let [r (load {:params recorded})]
        (is (= 0 (:green/exit r)))
        (is (= recorded (:once/cluster r)))
        (is (true? (:postgres-agy/infrastructure-present? r)))
        (is (not (contains? r :postgres-agy/state)))
        (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip (tools/nodes r))))))
    (testing "a readable state that records no cluster leaves nothing to clean up"
      (let [r (load {:params nil})]
        (is (= 0 (:green/exit r)))
        (is (false? (:postgres-agy/infrastructure-present? r)))
        (is (not (contains? r :once/cluster)))))
    (testing "an unreadable backend fails closed"
      (let [r (load {:error "tofu output failed: no backend"})]
        (is (= 1 (:green/exit r)))
        (is (str/includes? (:green/err r) "could not read the infrastructure state for the delete cleanup"))
        (is (str/includes? (:green/err r) "no backend"))))
    (testing "a partial cluster is refused with ONCE's message"
      (let [r (load {:params (update recorded :nodes #(vec (take 2 %)))})]
        (is (= 1 (:green/exit r)))
        (is (= "the compute stage did not report nodes this package declares: 2" (:green/err r)))))
    (testing "an adopted cluster without its extension keys is refused"
      (let [r (load {:params (dissoc recorded :vpc_id)})]
        (is (= 1 (:green/exit r)))
        (is (= "compute state carries no vpc_id" (:green/err r)))))))

(deftest a-real-create-resolves-the-cluster-from-the-apply
  ;; The apply's `params` output, string-keyed as `tofu output -json` parses
  ;; it, is what every later stage reads; never the fallbacks.
  (let [opts (assoc base :green/event :create)
        apply (fn [params]
                (tools/resolve-infrastructure
                 opts (cond-> (assoc opts :green/exit 0)
                        params (assoc :postgres-agy/outputs {:params (walk/stringify-keys params)}))))]
    (let [r (apply recorded)]
      (is (= 0 (:green/exit r)))
      (is (= recorded (:once/cluster r)))
      (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip (tools/nodes r)))))
    (let [r (apply nil)]
      (is (= 1 (:green/exit r)))
      (is (= cluster/no-params-message (:green/err r))))
    (let [r (apply (update recorded :nodes #(vec (take 2 %))))]
      (is (= 1 (:green/exit r)))
      (is (= "the compute stage did not report nodes this package declares: 2" (:green/err r))))
    (let [r (apply (dissoc recorded :vpc_ip_range))]
      (is (= 1 (:green/exit r)))
      (is (= "compute state carries no vpc_ip_range" (:green/err r))))
    (testing "a failed apply, a delete and a build hand the result on untouched"
      (is (= 1 (:green/exit (tools/resolve-infrastructure opts (assoc opts :green/exit 1 :green/err "apply failed")))))
      (is (not (contains? (tools/resolve-infrastructure (assoc opts :green/event :build) (assoc opts :green/exit 0)) :once/cluster)))
      (is (= 0 (:green/exit (tools/resolve-infrastructure (assoc opts :green/event :delete) (assoc opts :green/exit 0))))))))

(deftest the-local-play-receives-one-block-of-aliases
  ;; ssh-config.md: the addresses and the aliases are extra-vars, never
  ;; rendered; the marker is the profile; the bare profile reaches node 0.
  (let [vars (tools/ansible-local-extra-vars (assoc converged :green/event :create))]
    (is (= "postgres-agy-fixture" (:host_alias vars)))
    (is (= [{:name "postgres-agy-fixture" :ip "203.0.113.1"}
            {:name "postgres-agy-fixture-0" :ip "203.0.113.1"}
            {:name "postgres-agy-fixture-1" :ip "203.0.113.2"}
            {:name "postgres-agy-fixture-2" :ip "203.0.113.3"}]
           (:ssh_hosts vars)))
    (is (= "present" (:block_state vars)))
    (testing "the identity file is desired state a build knows and reaches the play through Selmer, in keygen mode only"
      (is (= [:block_state :host_alias :ssh_hosts] (sort (keys vars))))
      (let [data (:data (first (tools/ansible-local-specs base)))]
        (is (true? (:ssh-keygen data)))
        (is (= "~/.ssh/postgres-agy-fixture" (:ssh-config-identity-file data))))
      (is (false? (:ssh-keygen (:data (first (tools/ansible-local-specs optout))))))))
  (testing "the nodes are reached with the generated key in keygen mode, on a build through the placeholder, and with the operator's own key in opt-out mode"
    (is (= "/home/build-placeholder/.ssh/postgres-agy-fixture"
           (get-in (json/parse-string (tools/inventory (assoc base :green/event :build)) true)
                   [:all :children :postgres :vars :ansible_ssh_private_key_file])))
    (is (= "~/.ssh/id_ed25519"
           (get-in (json/parse-string (tools/inventory optout) true)
                   [:all :children :postgres :vars :ansible_ssh_private_key_file]))))
  (is (= "absent" (:block_state (tools/ansible-local-extra-vars (assoc base :green/event :delete)))))
  (testing "a build renders the play without an address"
    (let [rendered (slurp (io/resource "io/github/getcolors/postgres-agy/tools/ansible-local/main.yml"))]
      (is (str/includes? rendered "marker: \"# {mark} {{ host_alias }} ANSIBLE MANAGED BLOCK\""))
      (is (str/includes? rendered "{% for host in ssh_hosts %}"))
      (is (str/includes? rendered "insertbefore: BOF"))
      (is (not (re-find #"192\.0\.2|203\.0\.113" rendered))))))

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
