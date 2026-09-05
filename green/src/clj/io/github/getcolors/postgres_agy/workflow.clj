(ns io.github.getcolors.postgres-agy.workflow
  "The lifecycle graph, the preflight, and the per-stage remote-state advice.

  Create is strictly sequential. The stages are not independent: DNS needs the
  addresses compute produced, the cluster play needs the inventory those
  addresses build, and acceptance needs a converged cluster *and* a resolvable
  name. Fanning any of it out would only buy back the seconds that DigitalOcean
  spends creating three droplets in one `apply` anyway.

  Delete runs the same edges backwards, with one addition: it adopts the
  cluster out of remote state first, because the local SSH configuration it
  has to withdraw is keyed by the nodes and by then the droplets may already
  be gone. The state is read once, in preflight, so the Compute Provider
  Standard's switch guard runs before the credentials are checked; the read is
  handed to `load-infrastructure` rather than repeated."
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.postgres-agy.ssh :as ssh]
            [io.github.getcolors.postgres-agy.ssh-config :as ssh-config]
            [io.github.getcolors.postgres-agy.tools :as tools]
            [io.github.getcolors.postgres-agy.validate :as validate]))

(def defaults
  {:provider-compute validate/default-compute-provider
   :provider-dns "cloudflare"
   :provider-backend "local"
   :compute-prevent-destroy true
   :workdir ".colors"
   :cluster-nodes 3
   :cloudflare-proxied false
   :cloudflare-record-ttl 60
   :digitalocean-vpc-mode "default"
   :postgres-port 5432
   :postgres-admin-user "postgres"
   :postgres-replication-user "replicator"
   :patroni-rest-port 8008
   :patroni-ttl 30
   :patroni-loop-wait 10
   :patroni-retry-timeout 10
   :patroni-synchronous-node-count 1
   :etcd-client-port 2379
   :etcd-peer-port 2380
   :haproxy-primary-port 5432
   :haproxy-replica-port 5433
   :haproxy-stats-port 7000
   :backup-stanza "main"
   :backup-retention-full 4
   :backup-r2-region "auto"
   :restore-check-port 5442
   :restore-check-max-age-hours 26
   :restore-check-max-lag-seconds 900
   :heartbeat-oncalendar "*:0/1"
   :heartbeat-retention-days 7})

(def lifecycle-events #{:create :delete})

(defn- real-lifecycle-event? [{:keys [event real?]}]
  (boolean (and real? (lifecycle-events event))))

(defn start-step
  "Preflight. On a real create or delete the compute state is read once
  through `reader` — the package's `tools/state-output` unless a test injects
  another — on the same defaulted and overlaid opts the validators see, and
  only once desired state itself has passed, so the reader never renders an
  invalid colors.yml. The read feeds the switch guard here and travels on
  under `:postgres-agy/state` for `load-infrastructure` to adopt.

  Credentials are only demanded by a run that will actually use them. `build`
  and `--dry-run` therefore work on a fresh checkout with an empty
  environment, which is what makes them a safe way to review a colors.yml
  edit."
  ([opts] (start-step opts (System/getenv)))
  ([opts env] (start-step opts env tools/state-output))
  ([opts env reader]
   (let [overlaid (green-cli/read-pars (merge defaults opts) env)
         context {:event (:green/event overlaid) :real? (lifecycle/real-run? overlaid)}
         state (when (and (real-lifecycle-event? context)
                          (empty? (validate/env-errors env))
                          (empty? (validate/state-errors overlaid)))
                 (cluster/read-state overlaid reader))]
     (lifecycle/preflight
      opts
      {:defaults defaults
       :overlay green-cli/read-pars
       :validators
       [(fn [_ env _] (validate/env-errors env))
        (fn [opts _ _] (validate/state-errors opts))
        ;; Standard §4 before the credentials: a recorded provider that differs
        ;; from the selected one reports the actionable error, not a missing
        ;; token for the provider that was just selected.
        (fn [opts _ ctx]
          (when (real-lifecycle-event? ctx)
            (cluster/provider-validator validate/spec opts (:params state)
                                        #(validate/secret-errors opts))))
        (fn [opts _ {:keys [event real?]}]
          (when (and real? (= :delete event) (:compute-prevent-destroy opts))
            [(str "compute destruction is protected; set "
                  (green-cli/par-name :compute-prevent-destroy)
                  "=false for this one delete")]))]
       :after-validate
       ;; The machine key's create matrix and the DigitalOcean preflight run
       ;; before any template is rendered: an unowned key on disk or at the
       ;; provider stops the run while stopping is still free. Every other
       ;; event fills the same template values — a destroy renders before it
       ;; destroys — but checks no key, because the delete's key cleanup runs
       ;; after the compute destroy.
       (fn [opts _ {:keys [event real?] :as ctx}]
         (let [opts (cond-> opts (real-lifecycle-event? ctx) (assoc :postgres-agy/state state))]
           (if (and real? (= :create event))
             (let [opts (ssh/ensure-key! opts (fn [_] (:params state)))]
               (if (wf/failed? opts)
                 opts
                 (let [opts (ssh/preflight! (ssh/with-machine-key opts))
                       opts (if (wf/failed? opts) opts (ssh-config/preflight! opts))]
                   (if (wf/failed? opts) opts (assoc opts :green/exit 0)))))
             (assoc (ssh/with-machine-key opts) :green/exit 0))))}
      env))))

(defn wire-fn
  [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :postgres-agy/start [start-step :postgres-agy/load-infrastructure]
      :postgres-agy/load-infrastructure [tools/load-infrastructure-step
                                        :postgres-agy/cluster]
      :postgres-agy/cluster [tools/cluster-step :postgres-agy/ansible-local]
      :postgres-agy/ansible-local [tools/ansible-local-step :postgres-agy/dns]
      :postgres-agy/dns [tools/dns-step :postgres-agy/infrastructure]
      ;; The keypair goes after the compute destroy (ssh-keypair.md §3.3): a
      ;; key that predeceases its hosts locks the operator out of nodes that
      ;; still exist.
      :postgres-agy/infrastructure [tools/infrastructure-step :postgres-agy/ssh-cleanup]
      :postgres-agy/ssh-cleanup [ssh/cleanup-step :postgres-agy/generated-cleanup]
      :postgres-agy/generated-cleanup [tools/generated-cleanup-step])
    (case step
      :postgres-agy/start [start-step :postgres-agy/infrastructure]
      :postgres-agy/infrastructure [tools/infrastructure-step :postgres-agy/dns]
      :postgres-agy/dns [tools/dns-step :postgres-agy/ansible-local]
      :postgres-agy/ansible-local [tools/ansible-local-step :postgres-agy/cluster]
      :postgres-agy/cluster [tools/cluster-step :postgres-agy/acceptance]
      :postgres-agy/acceptance [tools/acceptance-step])))

(defn backend-advice
  "The state backend of one OpenTofu stage: `tools/backend-advice`, which the
  state reader also runs, so a delete from a fresh clone finds its state."
  [tool]
  (tools/backend-advice tool))

(def side-effecting-steps
  [:postgres-agy/load-infrastructure :postgres-agy/infrastructure
   :postgres-agy/dns :postgres-agy/ansible-local :postgres-agy/cluster
   :postgres-agy/acceptance :postgres-agy/ssh-cleanup :postgres-agy/generated-cleanup])

(def workflow
  (-> (wf/workflow {:start :postgres-agy/start :wire-fn wire-fn})
      (wf/advice-add :postgres-agy/load-infrastructure :before ::backend
                     (backend-advice tools/infrastructure-tool))
      (wf/advice-add :postgres-agy/infrastructure :before ::backend
                     (backend-advice tools/infrastructure-tool))
      (wf/advice-add :postgres-agy/dns :before ::backend
                     (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting-steps)))
