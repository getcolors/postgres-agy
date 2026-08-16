(ns io.github.getcolors.postgres-agy.utils-test
  (:require [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.postgres-agy.utils :as utils]))

(deftest contract-test
  (testing "launcher contract version"
    (is (pos-int? utils/contract))))

(deftest topology-test
  (testing "node count and ordinals"
    (is (= 3 utils/node-count))
    (is (= [1 2 3] (utils/ordinals))))

  (testing "node naming"
    (is (= "postgres-agy-1" (utils/node-name {:digitalocean-name "postgres-agy"} 1)))
    (is (= "my-pg-2" (utils/node-name {:digitalocean-name "my-pg"} 2))))

  (testing "ssh alias"
    (is (= "postgres-agy-1" (utils/ssh-alias {:profile "postgres-agy"} 1)))
    (is (= "my-pg-2" (utils/ssh-alias {:profile "my-pg"} 2))))

  (testing "par lookup formatting"
    (is (= "{{ lookup('env','COLORS_PAR_POSTGRES_ADMIN_PASSWORD') }}"
           (utils/par-lookup :postgres-admin-password)))
    (is (= "{{ lookup('env','COLORS_PAR_DO_TOKEN') }}"
           (utils/par-lookup :do-token))))

  (testing "endpoint host extraction"
    (is (= "319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com"
           (utils/endpoint-host "https://319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com")))
    (is (= "s3.amazonaws.com"
           (utils/endpoint-host "http://s3.amazonaws.com/"))))

  (testing "repo path extraction"
    (is (= "/postgres-agy-digitalocean"
           (utils/repo-path "postgres-agy-digitalocean")))
    (is (= "/my/path"
           (utils/repo-path "/my/path")))
    (is (= "/"
           (utils/repo-path "")))))
