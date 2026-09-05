#!/usr/bin/env bash
set -euo pipefail

# Green's regression net against the committed goldens: render every fixture
# under both state backends and diff against committed output. scripts/parity.sh
# is the net across colours.
#
# Two fixtures, because the SSH Keypair Standard has two modes and a package
# conforms only if both hold. `colors.yml` is keygen mode (no
# digitalocean-ssh-keys): the compute template must declare the profile-named
# digitalocean_ssh_key resource and reference it by attribute, and the local
# stage must name the generated key. `optout.yml` supplies an explicit key id
# and must create nothing — its rendering is byte-for-byte what the package
# rendered before the standard, under its own profile. Two backends: each
# fixture is rendered under local and again under r2 by overlaying
# COLORS_PAR_PROVIDER_BACKEND on the same file.
#
#   ./scripts/golden.sh            check
#   ./scripts/golden.sh --accept   regenerate after an intended change

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
goldens="$root/test/resources/golden"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
accept=0
[ "${1:-}" = --accept ] && accept=1
status=0

build() {
  local fixture=$1 backend=$2
  local state="$root/test/fixtures/$fixture.yml"
  local profile
  profile=$(sed -n 's/^profile: //p' "$state")
  (cd "$root/green" && env POSTGRES_AGY_LIB_ROOT="$root" COLORS_PAR_WORKDIR="$tmp/$backend-$fixture" \
    COLORS_PAR_PROVIDER_BACKEND="$backend" ./green build -f "$state" >/dev/null)
  local actual="$tmp/$backend-$fixture/$profile"
  local golden="$goldens/$backend/$profile"

  checks "$actual" "$profile" "$fixture" "$backend"

  if [ "$accept" = 1 ]; then
    rm -rf "${golden:?}"; mkdir -p "$golden"
    cp -r "$actual/." "$golden/"
    echo "  accepted — $backend/$profile"
  else
    [ -d "$golden" ] || { echo "golden missing for $backend/$profile; inspect build then run bb golden:accept" >&2; exit 1; }
    if diff -qr "$golden" "$actual"; then
      echo "  ok — $backend/$profile"
    else
      status=1
    fi
  fi
}

checks() {
  local base=$1 profile=$2 fixture=$3 backend=$4
  for stage in postgres-agy-infrastructure postgres-agy-dns postgres-agy-ansible-local postgres-agy-cluster postgres-agy-acceptance; do
    [ -d "$base/$stage" ] || { echo "golden: $profile is missing stage $stage" >&2; exit 1; }
  done

  local infra="$base/postgres-agy-infrastructure/main.tf"
  grep -q 'resource "digitalocean_droplet" "node"' "$infra"
  grep -q 'resource "digitalocean_firewall" "cluster"' "$infra"
  grep -q 'data "digitalocean_vpc" "default"' "$infra"
  grep -q 'output "vpc_id"' "$infra"
  grep -q 'output "node_public_ips"' "$infra"
  grep -q 'output "node_private_ips"' "$infra"
  grep -q 'output "params"' "$infra"
  grep -q '129.159.242.163/32' "$infra"
  [ "$(grep -c 'prevent_destroy = true' "$infra")" -ge 2 ] || {
    echo "golden: $profile: deployment-owned infrastructure lost prevent_destroy" >&2; exit 1
  }
  if grep -q '0.0.0.0/0.*source' "$infra"; then
    echo "golden: $profile: node ingress is open to the world" >&2
    exit 1
  fi
  # The SSH Keypair Standard, both modes: keygen declares the profile-named key
  # resource and references it by attribute; opt-out keeps the literal list and
  # creates nothing.
  if [ "$fixture" = colors ]; then
    grep -q 'resource "digitalocean_ssh_key" "machine"' "$infra" || { echo "golden: $profile: keygen mode declares no key resource" >&2; exit 1; }
    grep -q 'ssh_keys       = \[digitalocean_ssh_key.machine.id\]' "$infra" || { echo "golden: $profile: keygen mode does not reference the key by attribute" >&2; exit 1; }
    grep -q 'ssh_key_id   = digitalocean_ssh_key.machine.id' "$infra" || { echo "golden: $profile: params carries no ssh_key_id" >&2; exit 1; }
    grep -q 'IdentityFile ~/.ssh/postgres-agy-fixture' "$base/postgres-agy-ansible-local/main.yml" || { echo "golden: $profile: the local stage names no identity file" >&2; exit 1; }
    grep -q '"ansible_ssh_private_key_file" : "/home/build-placeholder/.ssh/postgres-agy-fixture"' "$base/postgres-agy-cluster/inventory.json" || { echo "golden: $profile: the inventory does not name the generated key" >&2; exit 1; }
  else
    ! grep -q 'digitalocean_ssh_key' "$infra" || { echo "golden: $profile: opt-out mode must create no key" >&2; exit 1; }
    grep -qE '^\s+ssh_keys\s+= \["' "$infra" || { echo "golden: $profile: opt-out mode lost the literal key list" >&2; exit 1; }
    ! grep -qE '^\s+IdentityFile ' "$base/postgres-agy-ansible-local/main.yml" || { echo "golden: $profile: opt-out mode must not guess an identity file" >&2; exit 1; }
  fi

  if [ "$backend" = r2 ]; then
    grep -q "$profile/postgres-agy-infrastructure.tfstate" "$base/postgres-agy-infrastructure/backend.tf.json"
    grep -q "$profile/postgres-agy-dns.tfstate" "$base/postgres-agy-dns/backend.tf.json"
  fi

  local dns="$base/postgres-agy-dns/main.tf"
  grep -q 'resource "cloudflare_dns_record" "endpoint_1"' "$dns"
  grep -q 'resource "cloudflare_dns_record" "endpoint_2"' "$dns"
  grep -q 'resource "cloudflare_dns_record" "endpoint_3"' "$dns"
  grep -q 'postgres-agy.bigconfig.online' "$dns"

  local cluster="$base/postgres-agy-cluster"
  grep -q 'patroni=4.1.5-1.pgdg24.04+1' "$cluster/main.yml"
  grep -q 'pgbackrest=2.59.0-1.pgdg24.04+1' "$cluster/main.yml"
  grep -q 'etcd-v3.5.33-linux-amd64.tar.gz' "$cluster/main.yml"
  grep -q '5025b5b24d81a9616b6e284ccd439b9a3df055ef8fdcdc142af3ec8f6a3b3c95' "$cluster/main.yml"
  grep -q 'lookup.*COLORS_PAR_POSTGRES_ADMIN_PASSWORD' "$cluster/templates/patroni.yml.j2"
  grep -q 'lookup.*COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID' "$cluster/templates/pgbackrest.conf.j2"
  grep -q 'archive-mode=off' "$cluster/templates/postgres-agy-restore-check.j2"

  local acceptance="$base/postgres-agy-acceptance/acceptance.sh"
  grep -q 'HOST="postgres-agy.bigconfig.online"' "$acceptance"

  # Assert no credentials or secret keys are leaked in rendered templates
  if grep -rEq 'client-certificate-data|client-key-data|BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|REPLACE_ME|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$base"; then
    echo "golden: $profile: credential-shaped material was rendered" >&2
    exit 1
  fi
  # A Selmer tag that survived rendering is a typo or an unsupplied key.
  if grep -rn '<{' "$base"; then
    echo "golden: $profile left an unrendered Selmer tag" >&2; exit 1
  fi
  # A build that reached the real ~/.ssh would leak the operator's home into
  # committed bytes and make the goldens workstation-specific.
  if grep -rq "$HOME/.ssh" "$base"; then
    echo "golden: $profile rendered a real home directory; build must use the placeholder" >&2; exit 1
  fi
  # SSH Config Standard §6: the local stage takes addresses and the aliases as
  # Ansible extra-vars, never through Selmer, so its rendered playbook carries
  # no address at all.
  if grep -rEq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$base/postgres-agy-ansible-local"; then
    echo "golden: $profile rendered an address into the local ssh_config stage" >&2; exit 1
  fi
}

for fixture in colors optout; do
  for backend in local r2; do
    build "$fixture" "$backend"
  done
done

[ "$status" = 0 ] && echo 'all postgres-agy goldens and safety assertions pass'
exit "$status"
