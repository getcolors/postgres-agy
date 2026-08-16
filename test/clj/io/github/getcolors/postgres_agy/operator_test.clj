(ns io.github.getcolors.postgres-agy.operator-test
  (:require [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-agy.operator :as operator]))

(def base
  (green-cli/read-state "test/fixtures/colors.yml" (slurp "test/fixtures/colors.yml")))

(deftest remote-command-test
  (testing "status command"
    (is (= ["patronictl" "-c" "/etc/patroni/patroni.yml" "list"]
           (operator/remote-command :status base []))))

  (testing "backup command"
    (is (= ["/usr/local/bin/postgres-agy-backup"]
           (operator/remote-command :backup base []))))

  (testing "verify-restore command"
    (is (= ["/usr/local/bin/postgres-agy-restore-check"]
           (operator/remote-command :verify-restore base []))))

  (testing "psql command"
    (is (= ["psql" "-h" "127.0.0.1" "-p" "5432" "-U" "postgres" "-d" "appdb" "-c" "SELECT 1"]
           (operator/remote-command :psql base ["-c" "SELECT 1"])))))

(deftest parse-args-test
  (testing "parse node flag"
    (is (= {:ordinal 2 :extra []} (operator/parse-args ["--node" "2"])))
    (is (= {:ordinal 1 :extra ["-c" "SELECT 1"]} (operator/parse-args ["-c" "SELECT 1"])))
    (is (= {:ordinal 3 :extra ["--force"]} (operator/parse-args ["--node" "3" "--force"])))))
