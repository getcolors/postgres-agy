#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
state="$root/test/fixtures/colors.yml"
goldens="$root/test/resources/golden"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
accept=0
[ "${1:-}" = --accept ] && accept=1

build() {
  local variant=$1
  shift
  (cd "$root/green" && env POSTGRES_AGY_LIB_ROOT="$root" COLORS_PAR_WORKDIR="$tmp/$variant" "$@" \
    ./green build -f "$state" >/dev/null)
  if [ "$accept" = 1 ]; then
    rm -rf "$goldens/$variant"
    mkdir -p "$goldens/$variant"
    cp -r "$tmp/$variant/." "$goldens/$variant/"
    echo "  accepted — $variant"
  else
    diff -qr "$goldens/$variant" "$tmp/$variant"
    echo "  ok — $variant"
  fi
}

build local COLORS_PAR_PROVIDER_BACKEND=local
build r2 COLORS_PAR_PROVIDER_BACKEND=r2

base="$tmp/local/postgres-agy-fixture"
for stage in postgres-agy-infrastructure postgres-agy-dns postgres-agy-ansible-local postgres-agy-cluster postgres-agy-acceptance; do
  [ -d "$base/$stage" ] || { echo "golden: missing stage $stage" >&2; exit 1; }
done

infra="$base/postgres-agy-infrastructure/main.tf"
grep -q 'resource "digitalocean_droplet" "node"' "$infra"
grep -q 'resource "digitalocean_firewall" "cluster"' "$infra"
grep -q 'data "digitalocean_vpc" "default"' "$infra"
grep -q 'output "vpc_id"' "$infra"
grep -q 'output "node_public_ips"' "$infra"
grep -q 'output "node_private_ips"' "$infra"
grep -q '129.159.242.163/32' "$infra"
[ "$(grep -c 'prevent_destroy = true' "$infra")" -ge 2 ] || {
  echo 'golden: deployment-owned infrastructure lost prevent_destroy' >&2; exit 1
}
if grep -q '0.0.0.0/0.*source' "$infra"; then
  echo 'golden: node ingress is open to the world' >&2
  exit 1
fi

grep -q 'postgres-agy-fixture/postgres-agy-infrastructure.tfstate' \
  "$tmp/r2/postgres-agy-fixture/postgres-agy-infrastructure/backend.tf.json"
grep -q 'postgres-agy-fixture/postgres-agy-dns.tfstate' \
  "$tmp/r2/postgres-agy-fixture/postgres-agy-dns/backend.tf.json"

dns="$base/postgres-agy-dns/main.tf"
grep -q 'resource "cloudflare_dns_record" "endpoint_1"' "$dns"
grep -q 'resource "cloudflare_dns_record" "endpoint_2"' "$dns"
grep -q 'resource "cloudflare_dns_record" "endpoint_3"' "$dns"
grep -q 'postgres-agy.bigconfig.online' "$dns"

cluster="$base/postgres-agy-cluster"
grep -q 'patroni=4.1.5-1.pgdg24.04+1' "$cluster/main.yml"
grep -q 'pgbackrest=2.59.0-1.pgdg24.04+1' "$cluster/main.yml"
grep -q 'etcd-v3.5.33-linux-amd64.tar.gz' "$cluster/main.yml"
grep -q '5025b5b24d81a9616b6e284ccd439b9a3df055ef8fdcdc142af3ec8f6a3b3c95' "$cluster/main.yml"
grep -q 'lookup.*COLORS_PAR_POSTGRES_ADMIN_PASSWORD' "$cluster/templates/patroni.yml.j2"
grep -q 'lookup.*COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID' "$cluster/templates/pgbackrest.conf.j2"
grep -q 'archive-mode=off' "$cluster/templates/postgres-agy-restore-check.j2"

acceptance="$base/postgres-agy-acceptance/acceptance.sh"
grep -q 'HOST="postgres-agy.bigconfig.online"' "$acceptance"

# Assert no credentials or secret keys are leaked in rendered templates
if grep -rEq 'client-certificate-data|client-key-data|BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|REPLACE_ME|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$tmp"; then
  echo 'golden: credential-shaped material was rendered' >&2
  exit 1
fi

echo 'all postgres-agy goldens and safety assertions pass'
