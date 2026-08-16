(ns io.github.getcolors.postgres-agy.workflow-test
  (:require [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-agy.workflow :as workflow]))

(def base
  (green-cli/read-state "test/fixtures/colors.yml" (slurp "test/fixtures/colors.yml")))

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
    (is (= [io.github.getcolors.postgres-agy.tools/infrastructure-step :postgres-agy/generated-cleanup]
           (workflow/wire-fn :postgres-agy/infrastructure {:green/event :delete})))
    (is (= [io.github.getcolors.postgres-agy.tools/generated-cleanup-step]
           (workflow/wire-fn :postgres-agy/generated-cleanup {:green/event :delete})))))

(deftest preflight-test
  (testing "build preflight succeeds without credentials"
    (let [res (workflow/start-step (assoc base :green/event :build) {})]
      (is (= 0 (:green/exit res))))))
