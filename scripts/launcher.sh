#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
green_launcher="$root/skills/package-postgres-agy-green/green"
red_launcher="$root/skills/package-postgres-agy-red/red"
blue_launcher="$root/skills/package-postgres-agy-blue/blue"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
checks=0
fail(){ echo "launcher: FAIL — $*" >&2; exit 1; }
ok(){ checks=$((checks+1)); echo "  ok — $*"; }

for launcher in "$green_launcher" "$red_launcher" "$blue_launcher"; do
  [ -f "$launcher" ] || fail "payload launcher is missing: $launcher"
done
grep -q 'io.github.getcolors.postgres-agy.workflow/workflow' "$green_launcher" || fail 'workflow dispatch is missing'
for bad in 'defn.*-step' 'tofu/' 'babashka\.process' 'ProcessBuilder'; do
  ! grep -qE "$bad" "$green_launcher" || fail "green launcher contains package logic: $bad"
done
ok 'green dispatches to the library and contains no lifecycle logic'

grep -qE '\(def \^:private postgres-agy-sha (nil|"[0-9a-f]{40}")\)' "$green_launcher" || fail 'invalid green pin site'
grep -qE '"package-postgres-agy-red": (null|"github:getcolors/postgres-agy#[0-9a-f]{40}"),' "$red_launcher" || fail 'invalid red pin site'
grep -qE '(# dependencies = \[\]|postgres-agy\.git", rev = "[0-9a-f]{40}")' "$blue_launcher" || fail 'invalid blue pin site'
ok 'each payload has one managed immutable pin site'

[ -L "$root/green/green" ] && [ "$(readlink "$root/green/green")" = ../skills/package-postgres-agy-green/green ] || fail 'green/green is not the payload symlink'
[ -L "$root/red/red" ] && [ "$(readlink "$root/red/red")" = ../skills/package-postgres-agy-red/red ] || fail 'red/red is not the payload symlink'
[ -L "$root/blue/blue" ] && [ "$(readlink "$root/blue/blue")" = ../skills/package-postgres-agy-blue/blue ] || fail 'blue/blue is not the payload symlink'
ok 'each colour dir symlinks its skill payload'

mkdir "$tmp/bare"
cp "$green_launcher" "$tmp/bare/green"; chmod +x "$tmp/bare/green"
cp "$red_launcher" "$tmp/bare/red"; chmod +x "$tmp/bare/red"
cp "$blue_launcher" "$tmp/bare/blue"; chmod +x "$tmp/bare/blue"
if grep -q '(def \^:private postgres-agy-sha nil)' "$green_launcher"; then
  for colour in green red blue; do
    out=$(cd "$tmp/bare" && "./$colour" build 2>&1 || true)
    grep -q POSTGRES_AGY_LIB_ROOT <<<"$out" || fail "an unpinned $colour launcher did not explain POSTGRES_AGY_LIB_ROOT"
  done
  ok 'unstamped payloads fail with an actionable working-tree override'
else
  ok 'payloads carry a real package commit pin'
fi

for colour in green red blue; do
  mkdir "$tmp/project-$colour"
  cp "$tmp/bare/$colour" "$tmp/project-$colour/$colour"
  cp "$root/colors.yml" "$tmp/project-$colour/colors.yml"
  (cd "$tmp/project-$colour" && POSTGRES_AGY_LIB_ROOT="$root" "./$colour" build >/dev/null) || fail "POSTGRES_AGY_LIB_ROOT $colour build failed"
  [ -f "$tmp/project-$colour/.colors/postgres-agy-example/postgres-agy-infrastructure/shared/shared.tf.json" ] || fail "copied $colour payload rendered nothing"
done
ok 'working-tree override renders from a copied payload in every colour'

mkdir -p "$tmp/project-green/deep/path"
(cd "$tmp/project-green/deep/path" && POSTGRES_AGY_LIB_ROOT="$root" ../../green build >/dev/null) || fail 'upward desired-state search failed'
ok 'finds colors.yml by walking upward'

out=$(cd "$tmp/project-green" && POSTGRES_AGY_LIB_ROOT="$root" ./green nonsense 2>&1 || true)
grep -q Usage <<<"$out" || fail 'unknown command has no usage'
for verb in build create delete status switchover failover backup verify-restore psql; do
  grep -q "\"$verb\"" "$green_launcher" || fail "missing command $verb"
done
grep -q 'io.github.getcolors.postgres-agy.operator/run' "$green_launcher" || fail 'operator commands bypass tested code'
ok 'lifecycle and operator commands are dispatchable'

# colors-compute-red declares the Red SDK as a peer, so a cold launcher cache
# installs the SDK only because PINS names it. The pin must be the one
# red/package.json tests against, and a cold cache must actually resolve it:
# the working-tree builds reuse red/node_modules and cannot see a missing peer.
red_sdk_sha=$(grep -oE '"red": "github:getcolors/red#[0-9a-f]{40}"' "$root/red/package.json" | grep -oE '[0-9a-f]{40}')
[[ -n $red_sdk_sha ]] || fail 'red/package.json carries no Red SDK pin'
grep -q "\"red\": \"github:getcolors/red#$red_sdk_sha\"" "$red_launcher" || fail 'red payload PINS the Red SDK at a different commit than red/package.json'
ok 'the red payload PINS the Red SDK at the red/package.json commit'
mkdir "$tmp/red-cold"
cp "$red_launcher" "$tmp/red-cold/red"; chmod +x "$tmp/red-cold/red"
cp "$root/test/fixtures/colors.yml" "$tmp/red-cold/colors.yml"
# One retry: a cold install fetches GitHub tarballs and a transient fetch
# failure is not a payload defect. Each attempt starts from empty caches.
cold_ok=0
for attempt in 1 2; do
  rm -rf "$tmp/red-cold/xdg" "$tmp/red-cold/bun" "$tmp/red-cold/.colors"
  if (cd "$tmp/red-cold" && XDG_CACHE_HOME="$tmp/red-cold/xdg" BUN_INSTALL_CACHE_DIR="$tmp/red-cold/bun" ./red build >"$tmp/red-cold/build.log" 2>&1); then cold_ok=1; break; fi
done
[[ $cold_ok == 1 ]] || { tail -5 "$tmp/red-cold/build.log" >&2; fail 'red payload does not build from a cold cache'; }
ok 'red payload builds from a cold cache with only its PINS'

echo "launcher: $checks checks passed"
