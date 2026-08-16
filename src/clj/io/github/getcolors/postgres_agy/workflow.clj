(ns io.github.getcolors.postgres-agy.workflow
  "The lifecycle graph, the preflight, and the per-stage remote-state advice.

  Create is strictly sequential. The stages are not independent: DNS needs the
  addresses compute produced, the cluster play needs the inventory those
  addresses build, and acceptance needs a converged cluster *and* a resolvable
  name.

  Delete runs the same edges backwards, with one addition: it loads the node
  addresses out of remote state first, because the local SSH configuration it
  has to withdraw is keyed by them and by then the droplets may already be
  gone."
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.postgres-agy.tools :as tools]
            [io.github.getcolors.postgres-agy.validate :as validate]))

(def defaults
  {:provider-compute "digitalocean"
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

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight
    opts
    {:defaults defaults
     :overlay green-cli/read-pars
     :validators
     [(fn [_ env _] (validate/env-errors env))
      (fn [opts _ _] (validate/state-errors opts))
      (fn [opts _ {:keys [event real?]}]
        (when (and real? (lifecycle-events event)) (validate/secret-errors opts)))
      (fn [opts _ {:keys [event real?]}]
        (when (and real? (= :delete event) (:compute-prevent-destroy opts))
          [(str "compute destruction is protected; set "
                (green-cli/par-name :compute-prevent-destroy)
                "=false for this one delete")]))]}
    env)))

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
      :postgres-agy/infrastructure [tools/infrastructure-step
                                    :postgres-agy/generated-cleanup]
      :postgres-agy/generated-cleanup [tools/generated-cleanup-step])
    (case step
      :postgres-agy/start [start-step :postgres-agy/infrastructure]
      :postgres-agy/infrastructure [tools/infrastructure-step :postgres-agy/dns]
      :postgres-agy/dns [tools/dns-step :postgres-agy/ansible-local]
      :postgres-agy/ansible-local [tools/ansible-local-step :postgres-agy/cluster]
      :postgres-agy/cluster [tools/cluster-step :postgres-agy/acceptance]
      :postgres-agy/acceptance [tools/acceptance-step])))

(defn backend-advice
  [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(def side-effecting-steps
  [:postgres-agy/load-infrastructure :postgres-agy/infrastructure
   :postgres-agy/dns :postgres-agy/ansible-local :postgres-agy/cluster
   :postgres-agy/acceptance :postgres-agy/generated-cleanup])

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
