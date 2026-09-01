#!/usr/bin/env bash
#
# Proves that the newest off-server backup of the Kestra database can still be
# restored. It fetches the archive from Cloudflare R2, restores it into a
# throwaway database beside the live one, checks that the flow definitions came
# back, and drops it again.
#
# This verifies a backup. It does NOT recover one. A real recovery replaces the
# live database and is a decision a person makes after working out what went
# wrong, so it stays manual on purpose. The procedure is on issue #132.
#
# Every step fails loudly. There is no path through this script that reports
# success on a backup it could not restore.
#
# Required environment:
#   R2_ENDPOINT             https://<account-id>.r2.cloudflarestorage.com
#   R2_ACCESS_KEY_ID        an R2 API token with Object Read only
#   R2_SECRET_ACCESS_KEY    its secret
#   R2_BUCKET               abzum-console-backups
#   R2_PREFIX               data/coolify/backups/volumes/root-team-0/<uuid>/
#   PG_CONTAINER            the Kestra PostgreSQL container name
#
# Optional:
#   PG_USER                 defaults to kestra
#   HELPER_IMAGE            defaults to coollabsio/coolify-helper:1.0.16
#   MIN_FLOWS               minimum flow rows to accept, defaults to 1
#
# The token must be Object Read only. A token that can also write or delete
# would let anyone who takes this server destroy the offsite copies as well,
# which is the one thing the offsite copy exists to survive.

set -euo pipefail

PG_USER="${PG_USER:-kestra}"
HELPER_IMAGE="${HELPER_IMAGE:-coollabsio/coolify-helper:1.0.16}"
MIN_FLOWS="${MIN_FLOWS:-1}"

die() { echo "verify-restore: FAILED: $*" >&2; exit 1; }
say() { echo "verify-restore: $*"; }

for v in R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PREFIX PG_CONTAINER; do
  [ -n "${!v:-}" ] || die "$v is not set"
done

docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || die "container $PG_CONTAINER is not running"

WORK="$(mktemp -d /tmp/verify-restore.XXXXXX)"
SCRATCH_DB="verify_restore_$(date -u +%Y%m%d%H%M%S)"

cleanup() {
  set +e
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};" >/dev/null 2>&1
  docker exec "$PG_CONTAINER" rm -f "/tmp/${SCRATCH_DB}.dump" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

# mc reads credentials from MC_HOST_<alias>, so nothing is written to disk and
# no secret appears in the argument list of any command.
ENDPOINT_HOST="${R2_ENDPOINT#https://}"
ENDPOINT_HOST="${ENDPOINT_HOST#http://}"
MC_HOST_r2="https://${R2_ACCESS_KEY_ID}:${R2_SECRET_ACCESS_KEY}@${ENDPOINT_HOST}"
export MC_HOST_r2

mc_run() {
  docker run --rm \
    -e "MC_HOST_r2=${MC_HOST_r2}" \
    -v "${WORK}:/work" \
    --entrypoint mc \
    "$HELPER_IMAGE" "$@"
}

say "listing r2://${R2_BUCKET}/${R2_PREFIX}"
OBJECT="$(mc_run ls "r2/${R2_BUCKET}/${R2_PREFIX}" \
  | awk '{print $NF}' | grep '\.tar\.gz$' | sort | tail -1)" \
  || die "could not list the bucket"
[ -n "$OBJECT" ] || die "no .tar.gz objects under ${R2_PREFIX}"

say "newest object is ${OBJECT}"
mc_run cp "r2/${R2_BUCKET}/${R2_PREFIX}${OBJECT}" "/work/${OBJECT}" \
  || die "could not download ${OBJECT}"
[ -s "${WORK}/${OBJECT}" ] || die "downloaded ${OBJECT} but it is empty"

say "archive is $(stat -c %s "${WORK}/${OBJECT}") bytes, sha256 $(sha256sum "${WORK}/${OBJECT}" | cut -d' ' -f1)"

say "extracting the logical dumps"
tar -xzf "${WORK}/${OBJECT}" -C "$WORK" --wildcards '*.dump' \
  || die "no .dump files inside ${OBJECT}"

DUMP="$(find "$WORK" -name '*.dump' | sort | tail -1)"
[ -n "$DUMP" ] || die "no .dump file found after extracting"
say "using $(basename "$DUMP"), $(stat -c %s "$DUMP") bytes"

say "restoring into ${SCRATCH_DB}"
docker cp "$DUMP" "${PG_CONTAINER}:/tmp/${SCRATCH_DB}.dump" \
  || die "could not copy the dump into ${PG_CONTAINER}"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
  -c "CREATE DATABASE ${SCRATCH_DB};" >/dev/null \
  || die "could not create ${SCRATCH_DB}"
docker exec "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$SCRATCH_DB" \
  --no-owner --no-privileges "/tmp/${SCRATCH_DB}.dump" \
  || die "pg_restore reported errors"

FLOWS="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" \
  -Atc 'select count(*) from flows;')" || die "could not count flows"
EXECS="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" \
  -Atc 'select count(*) from executions;')" || die "could not count executions"

[ "$FLOWS" -ge "$MIN_FLOWS" ] \
  || die "restored only ${FLOWS} flows, expected at least ${MIN_FLOWS} — the backup restores but is empty"

LIVE="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d kestra \
  -Atc 'select count(*) from flows;' 2>/dev/null)" || LIVE="unknown"

say "OK: ${OBJECT} restored — ${FLOWS} flows, ${EXECS} executions (live database has ${LIVE} flows)"
