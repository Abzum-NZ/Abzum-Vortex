#!/usr/bin/env bash

set -euo pipefail

if [ -n "${VORTEX_TEST_SOURCE_REPOSITORY:-}" ]; then
  source_repository="$VORTEX_TEST_SOURCE_REPOSITORY"
elif command -v cygpath >/dev/null 2>&1; then
  source_repository="$(cygpath --windows "$PWD")"
else
  source_repository="$PWD"
fi
readonly source_repository
readonly fixture_path="$source_repository/workflows/kestra/tests/fixtures/issue-494-absent-baseline.yml"
readonly image="vortex-kestra-issue-494-fixture"
readonly container="vortex-kestra-issue-494-$RANDOM-$RANDOM"
readonly username=fixture@example.invalid
readonly password=FixturePass123
readonly test_root="$(mktemp -d)"
readonly materialized_source="$test_root/source"
server_port=""

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup EXIT

mkdir -p "$materialized_source"
tar \
  --create \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=.next \
  --exclude=.turbo \
  --directory "$source_repository" \
  . | tar --extract --file - --directory "$materialized_source"
git -C "$materialized_source" init --quiet
git -C "$materialized_source" config user.name fixture
git -C "$materialized_source" config user.email fixture@example.invalid
git -C "$materialized_source" add --all
git -C "$materialized_source" commit --quiet -m fixture

docker build --quiet --tag "$image" \
  --file "$source_repository/workflows/kestra/Dockerfile" \
  "$source_repository/workflows/kestra" >/dev/null

configuration="$(printf '%s\n' \
  'kestra:' \
  '  server:' \
  '    basic-auth:' \
  "      username: $username" \
  "      password: $password")"

docker run --detach --rm \
  --name "$container" \
  --publish 127.0.0.1::8080 \
  --volume "$materialized_source:/workspace:ro" \
  --env "KESTRA_CONFIGURATION=$configuration" \
  "$image" \
  server local --no-tutorials --port 8080 >/dev/null

server_port="$(docker port "$container" 8080/tcp | sed 's/.*://')"
readonly server_port
readonly server="http://127.0.0.1:${server_port}"
readonly auth="${username}:${password}"

for _ in $(seq 1 60); do
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --user "$auth" "$server/api/v1/main/executions/not-present" || true)"
  [ "$status" = 404 ] && break
  sleep 1
done
[ "${status:-}" = 404 ] || {
  docker logs --tail 80 "$container" >&2
  echo "pinned Kestra fixture server did not become ready" >&2
  exit 1
}

curl --fail --silent --show-error \
  --user "$auth" \
  --header 'Content-Type: application/x-yaml' \
  --data-binary "@$fixture_path" \
  "$server/api/v1/main/flows" >/dev/null

execution_json="$(curl --fail --silent --show-error \
  --request POST \
  --user "$auth" \
  "$server/api/v1/main/executions/vortex.tests/issue_494_absent_baseline?wait=true")"

if ! docker exec --interactive "$container" \
  jq --exit-status '.state.current == "SUCCESS"' \
  <<<"$execution_json" >/dev/null; then
  printf '%s\n' "$execution_json" >&2
  docker logs --tail 120 "$container" >&2
  exit 1
fi

execution_id="$(docker exec --interactive "$container" jq --raw-output '.id' <<<"$execution_json")"
printf 'pinned Kestra absent-baseline fixture: SUCCESS (execution %s)\n' "$execution_id"
