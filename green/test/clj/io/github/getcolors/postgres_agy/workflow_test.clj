(ns io.github.getcolors.postgres-agy.workflow-test
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-agy.ssh :as ssh]
            [io.github.getcolors.postgres-agy.tools :as tools]
            [io.github.getcolors.postgres-agy.workflow :as workflow]))

(def base
  (green-cli/read-state "test/fixtures/colors.yml" (slurp "test/fixtures/colors.yml")))

(def optout
  (green-cli/read-state "test/fixtures/optout.yml" (slurp "test/fixtures/optout.yml")))

(def credentials
  {"COLORS_PAR_DO_TOKEN" "t"
   "COLORS_PAR_CLOUDFLARE_API_TOKEN" "t"
   "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID" "t"
   "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY" "t"
   "COLORS_PAR_POSTGRES_ADMIN_PASSWORD" "t"
   "COLORS_PAR_POSTGRES_REPLICATION_PASSWORD" "t"})

(def unguarded (assoc credentials "COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false"))

(def recorded
  "`params` as a converged deployment records it."
  {:provider "digitalocean"
   :vpc_id "5a6b7c8d-0000-4000-8000-000000000001"
   :vpc_ip_range "10.20.0.0/20"
   :nodes (mapv (fn [i] {:index i :role nil :name (str "postgres-agy-" (inc i))
                         :ip (str "203.0.113." (inc i)) :vpc_ip (str "10.20.0." (inc i))
                         :user "root" :sudoer "root"})
                (range 3))})

;; The compute state is read once per run, through the reader, on a real
;; create or delete. Every lifecycle test injects one: nil is a readable state
;; holding no compute, a map is a recorded `params`, and a throw is a backend
;; that cannot be read.
(defn- start [opts env state] (workflow/start-step opts env (fn [_] state)))

(defn- start-unreadable
  ;; The shape `green.tofu/outputs` throws: an ex-info carrying `:dir`. Only
  ;; that is an unreadable backend; anything else propagates as a defect.
  [opts env]
  (workflow/start-step opts env (fn [_] (throw (ex-info "tofu output failed: no backend" {:dir "x"})))))

(defn- never [_] (throw (Exception. "the reader must not run")))

(deftest wire-fn-test
  (testing "create flow edges"
    (is (= [workflow/start-step :postgres-agy/infrastructure]
           (workflow/wire-fn :postgres-agy/start {:green/event :create})))
    (is (= [io.github.getcolors.postgres-agy.tools/infrastructure-step :postgres-agy/dns]
           (workflow/wire-fn :postgres-agy/infrastructure {:green/event :create})))
    (is (= [io.github.getcolors.postgres-agy.tools/dns-step :postgres-agy/ansible-local]
           (workflow/wire-fn :postgres-agy/dns {:green/event :create})))
    (is (= [io.github.getcolors.postgres-agy.tools/ansible-local-step :postgres-agy/cluster]
           (workflow/wire-fn :postgres-agy/ansible-local {:green/event :create})))
    (is (= [io.github.getcolors.postgres-agy.tools/cluster-step :postgres-agy/acceptance]
           (workflow/wire-fn :postgres-agy/cluster {:green/event :create})))
    (is (= [io.github.getcolors.postgres-agy.tools/acceptance-step]
           (workflow/wire-fn :postgres-agy/acceptance {:green/event :create}))))

  (testing "delete flow edges"
    (is (= [workflow/start-step :postgres-agy/load-infrastructure]
           (workflow/wire-fn :postgres-agy/start {:green/event :delete})))
    (is (= [io.github.getcolors.postgres-agy.tools/load-infrastructure-step :postgres-agy/cluster]
           (workflow/wire-fn :postgres-agy/load-infrastructure {:green/event :delete})))
    (is (= [io.github.getcolors.postgres-agy.tools/cluster-step :postgres-agy/ansible-local]
           (workflow/wire-fn :postgres-agy/cluster {:green/event :delete})))
    (is (= [io.github.getcolors.postgres-agy.tools/ansible-local-step :postgres-agy/dns]
           (workflow/wire-fn :postgres-agy/ansible-local {:green/event :delete})))
    (is (= [io.github.getcolors.postgres-agy.tools/dns-step :postgres-agy/infrastructure]
           (workflow/wire-fn :postgres-agy/dns {:green/event :delete})))
    (testing "the keypair goes after the compute destroy (ssh-keypair.md §3.3)"
      (is (= [io.github.getcolors.postgres-agy.tools/infrastructure-step :postgres-agy/ssh-cleanup]
             (workflow/wire-fn :postgres-agy/infrastructure {:green/event :delete})))
      (is (= [ssh/cleanup-step :postgres-agy/generated-cleanup]
             (workflow/wire-fn :postgres-agy/ssh-cleanup {:green/event :delete}))))
    (is (= [io.github.getcolors.postgres-agy.tools/generated-cleanup-step]
           (workflow/wire-fn :postgres-agy/generated-cleanup {:green/event :delete})))))

(deftest a-build-fills-the-placeholder-key-paths
  ;; Every event fills the machine-key paths in preflight so the templates and
  ;; the inventory render the same whichever step scaffolds them; a build gets
  ;; the fixed placeholder, never the operator's home.
  (let [r (workflow/start-step (assoc base :green/event :build) {})]
    (is (= 0 (:green/exit r)))
    (is (= "/home/build-placeholder/.ssh/postgres-agy-fixture" (:ssh-private-key-path r)))
    (is (true? (:ssh-keygen r))))
  (testing "opt-out invents no key path"
    (let [r (workflow/start-step (assoc optout :green/event :build) {})]
      (is (= 0 (:green/exit r)))
      (is (nil? (:ssh-private-key-path r)))
      (is (nil? (:ssh-keygen r))))))

(deftest preflight-test
  (testing "build preflight succeeds without credentials"
    (let [res (workflow/start-step (assoc base :green/event :build) {})]
      (is (= 0 (:green/exit res)))))
  (testing "build and dry-run never read the state"
    (doseq [opts [(assoc base :green/event :build)
                  (assoc base :green/event :create :green/dry-run true)
                  (assoc base :green/event :delete :green/dry-run true)]]
      (let [r (workflow/start-step opts {} never)]
        (is (= 0 (:green/exit r)))
        (is (not (contains? r :postgres-agy/state))))))
  (testing "a real create demands every credential"
    (let [r (start (assoc base :green/event :create) {} nil)]
      (is (= 2 (:green/exit r)))
      (is (str/includes? (:green/err r) "COLORS_PAR_POSTGRES_ADMIN_PASSWORD"))))
  (testing "the destroy guard holds and lifts for exactly one run"
    (is (= 2 (:green/exit (start (assoc base :green/event :delete) credentials nil))))
    (is (str/includes? (:green/err (start (assoc base :green/event :delete) credentials nil))
                       "compute destruction is protected"))
    (is (= 0 (:green/exit (start (assoc base :green/event :delete) unguarded nil)))))
  (testing "the state is not read for a refused profile, nor for invalid desired state"
    (is (= 2 (:green/exit (workflow/start-step (assoc base :green/event :delete)
                                               (assoc unguarded "COLORS_PAR_PROFILE" "elsewhere") never))))
    (is (= 2 (:green/exit (workflow/start-step (assoc base :green/event :delete :cluster-nodes 2)
                                               unguarded never))))))

;; --- the Compute Cluster Standard's safety boundaries ------------------------

(deftest a-provider-switch-is-refused-before-the-credentials
  (doseq [event [:create :delete]]
    (testing (str "digitalocean selected, vultr recorded, on " (name event))
      (let [r (start (assoc base :green/event event)
                     {"COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false"}
                     (assoc recorded :provider "vultr"))]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (:green/err r)
                           "state holds a vultr machine; set provider-compute back to vultr and delete first"))
        ;; The validator order is the thing under test: the actionable error,
        ;; not a missing token for the provider that was just selected.
        (is (not (str/includes? (:green/err r) "required credential is not set")))))))

(deftest legacy-state-accepts-only-the-default-provider
  ;; A recorded provider is absent from every pre-adoption state; on the one
  ;; provider this package offers that is the default, and the run proceeds
  ;; to its credentials.
  (doseq [event [:create :delete]]
    (let [r (start (assoc base :green/event event)
                   {"COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false"}
                   (dissoc recorded :provider))]
      (is (= 2 (:green/exit r)) (name event))
      (is (not (str/includes? (:green/err r) "state holds")) (name event))
      (is (str/includes? (:green/err r) "required credential is not set") (name event)))))

(deftest a-matching-provider-passes-to-the-credentials
  (let [r (start (assoc base :green/event :create) {} recorded)]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest an-unreadable-backend-counts-as-no-state-on-create
  ;; A fresh clone has no readable state and must still be able to create.
  (let [r (start-unreadable (assoc base :green/event :create) {})]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "could not read")))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest a-real-create-on-a-fresh-work-directory-reports-the-credentials-not-a-crash
  ;; No reader stub: the real `state-output` runs against a work directory
  ;; that holds no stage yet, as a fresh clone's does. It renders the stage,
  ;; writes its backend and initializes it, and finds no state — or fails to
  ;; launch or initialize tofu, which green 3f33f5d reports as its own step
  ;; error carrying :dir. Either way ONCE's `read-state` counts it as no
  ;; usable state, so the create reports its credentials instead of crashing.
  ;; The r2 backend, the path a real deployment takes, so the initialization
  ;; stops at the backend rather than fetching a provider plugin.
  (let [work (str (fs/create-temp-dir {:prefix "postgres-agy-fresh"}))]
    (try
      (let [r (workflow/start-step (assoc base :workdir work :green/event :create)
                                   {"COLORS_PAR_PROVIDER_BACKEND" "r2"})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (str (:green/err r)) "COLORS_PAR_DO_TOKEN"))
        (is (not (str/includes? (str (:green/err r)) "could not read"))))
      (finally (fs/delete-tree work)))))

(deftest an-unreadable-backend-fails-a-real-delete-closed
  ;; Swallowing it is how a teardown ends up converging against 192.0.2.11.
  ;; Preflight hands the read on; `load-infrastructure`, the first step after
  ;; it and before any side effect, is where the delete stops.
  (let [r (start-unreadable (assoc base :green/event :delete) unguarded)]
    (is (= 0 (:green/exit r)))
    (is (= {:error "tofu output failed: no backend"} (:postgres-agy/state r)))
    (let [l (tools/load-infrastructure-step r)]
      (is (= 1 (:green/exit l)))
      (is (str/includes? (:green/err l) "could not read the infrastructure state for the delete cleanup"))
      (is (str/includes? (:green/err l) "no backend")))))

(deftest a-real-delete-adopts-the-recorded-cluster
  (let [r (start (assoc base :green/event :delete) unguarded recorded)
        l (tools/load-infrastructure-step r)]
    (is (= 0 (:green/exit r)))
    (is (= {:params recorded} (:postgres-agy/state r)))
    (is (= 0 (:green/exit l)))
    (is (= recorded (:once/cluster l)))
    (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip (tools/nodes l))))
    (testing "and withdraws every alias of the block it wrote"
      (is (= ["postgres-agy-fixture" "postgres-agy-fixture-0" "postgres-agy-fixture-1" "postgres-agy-fixture-2"]
             (mapv :name (:ssh_hosts (tools/ansible-local-extra-vars l)))))
      (is (= "absent" (:block_state (tools/ansible-local-extra-vars l)))))
    (testing "a readable state without a cluster leaves nothing to clean up"
      (let [l (tools/load-infrastructure-step (start (assoc base :green/event :delete) unguarded nil))]
        (is (= 0 (:green/exit l)))
        (is (false? (:postgres-agy/infrastructure-present? l)))))))

(deftest a-partial-cluster-is-refused-on-a-real-run
  (let [partial (update recorded :nodes #(vec (take 2 %)))
        r (start (assoc base :green/event :delete) unguarded partial)]
    (is (= 0 (:green/exit r)) "the switch guard reads only the provider")
    (let [l (tools/load-infrastructure-step r)]
      (is (= 1 (:green/exit l)))
      (is (= "the compute stage did not report nodes this package declares: 2" (:green/err l))))))
