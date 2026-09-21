#!/usr/bin/env bash

set -euo pipefail

readonly expected_namespace='vortex.operations'
readonly expected_flow='testing_database_delivery'
readonly expected_ref='refs/heads/testing'
readonly expected_repository='Abzum-NZ/Abzum-Vortex'
readonly output_path="${VORTEX_ADMISSION_OUTPUT_PATH:-admission-decision.json}"
readonly execution_id="${VORTEX_EXECUTION_ID:-}"
readonly execution_commit="${VORTEX_GITHUB_COMMIT:-}"
readonly api_url="${VORTEX_KESTRA_API_URL:-}"
readonly api_username="${VORTEX_KESTRA_API_USERNAME:-}"
readonly api_password="${VORTEX_KESTRA_API_PASSWORD:-}"

decision='run_normally'
reason='admission_uncertain'
superseding_execution_id=''
superseding_execution_commit=''
workdir=''

cleanup() {
  if [ -n "$workdir" ]; then
    rm -rf "$workdir"
  fi
}
trap cleanup EXIT

write_decision() {
  local recorded_at
  recorded_at="$(date --utc +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$decision" = 'superseded' ]; then
    jq --null-input \
      --arg execution_id "$execution_id" \
      --arg execution_commit "$execution_commit" \
      --arg superseding_execution_id "$superseding_execution_id" \
      --arg superseding_execution_commit "$superseding_execution_commit" \
      --arg reason "$reason" \
      --arg recorded_at "$recorded_at" \
      '{schema_version: 1, decision: "superseded", execution: {id: $execution_id, commit: $execution_commit}, superseding_execution: {id: $superseding_execution_id, commit: $superseding_execution_commit}, reason: $reason, recorded_at: $recorded_at}' \
      >"$output_path"
  else
    jq --null-input \
      --arg execution_id "$execution_id" \
      --arg execution_commit "$execution_commit" \
      --arg reason "$reason" \
      --arg recorded_at "$recorded_at" \
      '{schema_version: 1, decision: "run_normally", execution: {id: $execution_id, commit: $execution_commit}, reason: $reason, recorded_at: $recorded_at}' \
      >"$output_path"
  fi
}

try_supersede() {
  local self_execution search_response self_start candidate_json candidate_start
  local candidate_id candidate_commit resolved_self resolved_candidate

  [[ "$execution_id" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  [[ "$execution_commit" =~ ^[0-9a-f]{40}$ ]] || return 0
  [ -n "$api_url" ] && [ -n "$api_username" ] && [ -n "$api_password" ] || return 0

  if ! self_execution="$(curl --silent --show-error --fail --max-time 10 \
    --user "${api_username}:${api_password}" \
    "${api_url%/}/api/v1/main/executions/${execution_id}")"; then
    return 0
  fi
  if ! self_start="$(jq --exit-status --raw-output \
    --arg execution_id "$execution_id" \
    --arg namespace "$expected_namespace" \
    --arg flow "$expected_flow" \
    --arg ref "$expected_ref" \
    --arg repository "$expected_repository" \
    --arg commit "$execution_commit" '
      if (.id == $execution_id) and (.namespace == $namespace) and (.flowId == $flow) and
         ((.state.startDate | type) == "string") and
         ((.state.startDate | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))) and
         (.trigger.type == "io.kestra.plugin.core.trigger.Webhook") and
         (.trigger.variables.body.ref == $ref) and
         (.trigger.variables.body.repository.full_name == $repository) and
         (.trigger.variables.body.after == $commit)
      then .state.startDate else error("unresolved self execution") end
    ' <<<"$self_execution" 2>/dev/null)"; then
    return 0
  fi

  if ! search_response="$(curl --silent --show-error --fail --max-time 10 \
    --user "${api_username}:${api_password}" \
    --get \
    --data-urlencode "namespace=${expected_namespace}" \
    --data-urlencode "flowId=${expected_flow}" \
    --data-urlencode 'state=QUEUED' \
    --data-urlencode 'size=100' \
    "${api_url%/}/api/v1/main/executions/search")"; then
    return 0
  fi
  if ! candidate_json="$(jq --compact-output --exit-status \
    --arg execution_id "$execution_id" \
    --arg namespace "$expected_namespace" \
    --arg flow "$expected_flow" \
    --arg ref "$expected_ref" \
    --arg repository "$expected_repository" \
    --arg self_start "$self_start" '
      if (.results | type) != "array" or (.total | type) != "number" or .total != (.results | length) then
        error("ambiguous execution search result")
      else
        [ .results[] |
          if .id == $execution_id then empty
          elif (.namespace != $namespace) or (.flowId != $flow) or (.state.current != "QUEUED") or
               (.state.startDate | type) != "string" or
               ((.state.startDate | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")) | not) or
               (.trigger.type != "io.kestra.plugin.core.trigger.Webhook") or
               (.trigger.variables.body.ref != $ref) or
               (.trigger.variables.body.repository.full_name != $repository) or
               (.trigger.variables.body.after | type) != "string" or
               ((.trigger.variables.body.after | test("^[0-9a-f]{40}$")) | not) or
               (.id | type) != "string"
          then error("ambiguous queued execution")
          else {id: .id, commit: .trigger.variables.body.after, start_date: .state.startDate}
          end
        ] | map(select(.start_date > $self_start)) | sort_by(.start_date) |
        if length == 0 then null
        elif length > 1 and .[0].start_date == .[1].start_date then error("ambiguous oldest queued execution")
        else .[0]
        end
      end
    ' <<<"$search_response" 2>/dev/null)"; then
    return 0
  fi
  [ "$candidate_json" != 'null' ] || return 0

  candidate_id="$(jq --raw-output '.id' <<<"$candidate_json")"
  candidate_commit="$(jq --raw-output '.commit' <<<"$candidate_json")"
  [[ "$candidate_id" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  [[ "$candidate_commit" =~ ^[0-9a-f]{40}$ ]] || return 0

  workdir="$(mktemp -d /tmp/vortex-queued-admission.XXXXXX)"
  local checkout="${workdir}/checkout"
  git init --quiet "$checkout"
  git -C "$checkout" remote add origin "https://github.com/${expected_repository}.git"
  if ! git -C "$checkout" fetch --quiet --no-tags origin "$execution_commit"; then
    return 0
  fi
  resolved_self="$(git -C "$checkout" rev-parse FETCH_HEAD)"
  [ "$resolved_self" = "$execution_commit" ] || return 0
  if ! git -C "$checkout" fetch --quiet --no-tags origin "$candidate_commit"; then
    return 0
  fi
  resolved_candidate="$(git -C "$checkout" rev-parse FETCH_HEAD)"
  [ "$resolved_candidate" = "$candidate_commit" ] || return 0
  [ "$resolved_self" != "$resolved_candidate" ] || return 0
  if ! git -C "$checkout" merge-base --is-ancestor "$resolved_self" "$resolved_candidate"; then
    return 0
  fi

  decision='superseded'
  reason='oldest_queued_successor_is_a_strict_descendant'
  superseding_execution_id="$candidate_id"
  superseding_execution_commit="$candidate_commit"
}

try_supersede
write_decision
