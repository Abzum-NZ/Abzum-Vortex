#!/usr/bin/env bash

set -euo pipefail

readonly state_root="${VORTEX_FAKE_PSQL_STATE:?VORTEX_FAKE_PSQL_STATE is required}"
readonly scenario="${VORTEX_FAKE_PSQL_SCENARIO:-success}"
sql=''

while [ "$#" -gt 0 ]; do
  if [ "$1" = '--command' ]; then
    shift
    sql="${1:?--command requires SQL}"
    break
  fi
  shift
done
if [ -z "$sql" ]; then
  sql="$(</dev/stdin)"
fi

if [[ "$sql" =~ (62[0-9a-f]{6}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) ]]; then
  scope="${BASH_REMATCH[1]//-/}"
else
  echo 'fake psql could not find the proof organization scope' >&2
  exit 90
fi

log_event() {
  printf '%s|%s\n' "$1" "$scope" >>"$state_root/events.log"
}

if [[ "$sql" == *'insert into vortex_identity.tenants'* ]]; then
  printf '%s' "$sql" >"$state_root/setup-$scope.sql"
  assert_transactional_setup=0
  if [[ "$sql" == *'begin;'* && "$sql" == *'commit;'* && "$sql" == *"raise exception 'Permission proof fixture scope already exists'"* ]]; then
    assert_transactional_setup=1
  fi
  [ "$assert_transactional_setup" -eq 1 ] || {
    log_event setup_not_transactional
    exit 91
  }
  case "$scenario" in
    collision)
      log_event setup_refused_collision
      exit 23
      ;;
    partial_setup)
      touch "$state_root/partial-$scope"
      log_event setup_failed_before_commit
      exit 24
      ;;
    *)
      touch "$state_root/claimed-$scope"
      log_event setup_committed
      exit 0
      ;;
  esac
fi

if [[ "$sql" == *'set local session_replication_role = replica'* ]]; then
  printf '%s' "$sql" >"$state_root/cleanup-$scope.sql"
  log_event cleanup_started
  if [ "$scenario" = cleanup_failure ] || [ "$scenario" = original_and_cleanup_failure ]; then
    log_event cleanup_failed
    exit 55
  fi
  [ -f "$state_root/claimed-$scope" ] || {
    log_event cleanup_rejected_unowned
    exit 92
  }
  rm -- "$state_root/claimed-$scope"
  log_event cleanup_finished
  exit 0
fi

case "${PGAPPNAME:-}" in
  vortex-permission-update-a-*)
    result_path=''
    if [[ "$sql" =~ \\g[[:space:]]+\'([^\']+)\' ]]; then
      result_path="${BASH_REMATCH[1]}"
    fi
    [ -n "$result_path" ] || exit 93
    printf '2|3\n' >"$result_path"
    log_event worker_a_barrier
    if [ "$scenario" = worker_failure ] || [ "$scenario" = original_and_cleanup_failure ]; then
      sleep 0.3
      log_event worker_a_failed
      exit 42
    fi
    sleep 0.15
    log_event worker_a_finished
    exit 0
    ;;
  vortex-permission-update-b-*)
    if [ "$scenario" = worker_failure ] || [ "$scenario" = original_and_cleanup_failure ]; then
      trap 'sleep 0.1; log_event worker_b_exited; exit 143' TERM
      log_event worker_b_waiting
      while :; do sleep 1; done
    fi
    echo 'Application permission registration revision is stale or unavailable' >&2
    log_event worker_b_refused
    exit 1
    ;;
esac

if [[ "$sql" == *'select revision from vortex_access.permission_registrations'* ]]; then
  printf '2\n'
elif [[ "$sql" == *'select current_version from vortex_access.organization_access_versions'* ]]; then
  printf '3\n'
elif [[ "$sql" == *'select count(*) from vortex_access.permission_registration_revisions'* ]]; then
  printf '2\n'
else
  echo 'fake psql received unexpected SQL' >&2
  exit 94
fi
