#!/usr/bin/env bash

set -euo pipefail

readonly source_repository="${VORTEX_TEST_SOURCE_REPOSITORY:-/source}"
readonly admission_script="${VORTEX_TEST_ADMISSION_SCRIPT:-/app/vortex-operations/admit-database-delivery.sh}"
readonly fixture_directory="${source_repository}/workflows/kestra/tests/fixtures"
readonly flow_file="${source_repository}/workflows/kestra/flows/testing-database-delivery.yml"
readonly test_root="$(mktemp -d /tmp/vortex-queued-admission-test.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

test -f "$admission_script"
fixture_source="$test_root/source"
mkdir -p "$fixture_source"
git -C "$fixture_source" init --quiet
git -C "$fixture_source" config user.name queued-admission-test
git -C "$fixture_source" config user.email queued-admission-test@example.invalid
touch "$fixture_source/fixture"
git -C "$fixture_source" add fixture
git -C "$fixture_source" commit --quiet -m 'Admission fixture base'
git clone --bare --quiet "$fixture_source" "$test_root/remote.git"
git --git-dir="$test_root/remote.git" config user.name queued-admission-test
git --git-dir="$test_root/remote.git" config user.email queued-admission-test@example.invalid
git clone --quiet "$test_root/remote.git" "$test_root/checkout"
git -C "$test_root/checkout" config user.name queued-admission-test
git -C "$test_root/checkout" config user.email queued-admission-test@example.invalid

commit_a="$(git -C "$fixture_source" rev-parse HEAD)"
git -C "$test_root/checkout" branch -f testing "$commit_a"
git -C "$test_root/checkout" checkout --quiet testing
git -C "$test_root/checkout" commit --quiet --allow-empty -m 'queued execution B'
commit_b="$(git -C "$test_root/checkout" rev-parse HEAD)"
git -C "$test_root/checkout" commit --quiet --allow-empty -m 'queued execution C'
commit_c="$(git -C "$test_root/checkout" rev-parse HEAD)"
git -C "$test_root/checkout" push --quiet origin testing
git -C "$test_root/checkout" checkout --quiet --detach "$commit_a"
git -C "$test_root/checkout" commit --quiet --allow-empty -m 'unrelated queued execution'
unrelated_commit="$(git -C "$test_root/checkout" rev-parse HEAD)"
git -C "$test_root/checkout" push --quiet origin HEAD:refs/heads/unrelated
git config --global "url.file://${test_root}/remote.git.insteadOf" https://github.com/Abzum-NZ/Abzum-Vortex.git

mock_bin="$test_root/bin"
mkdir -p "$mock_bin"
cat >"$mock_bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$VORTEX_TEST_CURL_LOG"
if [[ "$*" == *'/executions/search'* ]]; then
  if [ "${VORTEX_TEST_API_FAILURE:-false}" = true ]; then exit 22; fi
  sed -e "s/SELF_COMMIT/${VORTEX_GITHUB_COMMIT}/g" -e "s/CANDIDATE_COMMIT/${VORTEX_TEST_CANDIDATE_COMMIT}/g" -e "s/UNRELATED_COMMIT/${VORTEX_TEST_UNRELATED_COMMIT}/g" "$VORTEX_TEST_SEARCH_FIXTURE"
  exit 0
fi
if [[ "$*" == *"/executions/${VORTEX_EXECUTION_ID}"* ]]; then
  sed "s/SELF_COMMIT/${VORTEX_GITHUB_COMMIT}/g" "$VORTEX_TEST_SELF_FIXTURE"
  exit 0
fi
echo 'unexpected curl request' >&2
exit 1
MOCK
chmod 0755 "$mock_bin/curl"

export PATH="$mock_bin:$PATH"
export VORTEX_KESTRA_API_URL='https://kestra.example.invalid'
export VORTEX_KESTRA_API_USERNAME='fixture-operator'
export VORTEX_KESTRA_API_PASSWORD='fixture-password'
export VORTEX_GITHUB_REPOSITORY='Abzum-NZ/Abzum-Vortex'
export VORTEX_GITHUB_REF='refs/heads/testing'
export VORTEX_EXECUTION_ID='execution-b'
export VORTEX_TEST_SELF_FIXTURE="$fixture_directory/queued-admission-self.json"
export VORTEX_TEST_CANDIDATE_COMMIT="$commit_c"
export VORTEX_TEST_UNRELATED_COMMIT="$unrelated_commit"
export VORTEX_TEST_CURL_LOG="$test_root/curl.log"

run_admission() {
  export VORTEX_TEST_SEARCH_FIXTURE="$fixture_directory/$1"
  export VORTEX_ADMISSION_OUTPUT_PATH="$test_root/admission.json"
  rm -f "$VORTEX_ADMISSION_OUTPUT_PATH" "$VORTEX_TEST_CURL_LOG"
  bash "$admission_script"
  jq --exit-status . "$VORTEX_ADMISSION_OUTPUT_PATH" >/dev/null
}

export VORTEX_GITHUB_COMMIT="$commit_b"
run_admission queued-admission-descendant.json
jq --exit-status --arg self_commit "$commit_b" --arg successor_commit "$commit_c" '
  .schema_version == 1 and .decision == "superseded" and
  .execution.id == "execution-b" and .execution.commit == $self_commit and
  .superseding_execution.id == "execution-c" and .superseding_execution.commit == $successor_commit and
  .reason == "oldest_queued_successor_is_a_strict_descendant" and
  (.recorded_at | type == "string")
' "$VORTEX_ADMISSION_OUTPUT_PATH" >/dev/null
grep --fixed-strings --quiet '/executions/execution-b' "$VORTEX_TEST_CURL_LOG"
if grep --extended-regexp --ignore-case --quiet '(kill|restart|cancel|delete|pause|resume|unqueue|force-run)' "$VORTEX_TEST_CURL_LOG"; then
  echo 'admission attempted a mutating execution API call' >&2
  exit 1
fi
if grep --fixed-strings --quiet "$commit_a" "$VORTEX_TEST_CURL_LOG"; then
  echo 'active execution A must not be addressed by queued admission' >&2
  exit 1
fi

run_admission queued-admission-non-descendant.json
jq --exit-status '.decision == "run_normally"' "$VORTEX_ADMISSION_OUTPUT_PATH" >/dev/null
run_admission queued-admission-empty.json
jq --exit-status '.decision == "run_normally"' "$VORTEX_ADMISSION_OUTPUT_PATH" >/dev/null
run_admission queued-admission-missing-after.json
jq --exit-status '.decision == "run_normally"' "$VORTEX_ADMISSION_OUTPUT_PATH" >/dev/null
run_admission queued-admission-ambiguous.json
jq --exit-status '.decision == "run_normally"' "$VORTEX_ADMISSION_OUTPUT_PATH" >/dev/null
export VORTEX_TEST_API_FAILURE=true
run_admission queued-admission-descendant.json
jq --exit-status '.decision == "run_normally"' "$VORTEX_ADMISSION_OUTPUT_PATH" >/dev/null
unset VORTEX_TEST_API_FAILURE

if grep --extended-regexp --ignore-case --quiet '(curl.*(-X|--request).*(POST|PUT|PATCH|DELETE)|\b(kill|restart|cancel|delete|pause|resume|unqueue|force-run)\b)' "$admission_script"; then
  echo 'admission script contains a mutating execution API verb' >&2
  exit 1
fi
grep --fixed-strings --quiet 'outputs.admit_queued_database_delivery.outputFiles' "$flow_file"
grep --fixed-strings --quiet 'database-testing-admission-{{ execution.id }}' "$flow_file"
grep --fixed-strings --quiet 'io.kestra.plugin.core.execution.Exit' "$flow_file"
grep --fixed-strings --quiet 'state: CANCELED' "$flow_file"
admit_line="$(grep --line-number --fixed-strings 'id: admit_queued_database_delivery' "$flow_file" | head -1 | cut -d: -f1)"
invalidate_line="$(grep --line-number --fixed-strings 'id: invalidate_reusable_full_baseline' "$flow_file" | head -1 | cut -d: -f1)"
apply_line="$(grep --line-number --fixed-strings 'id: apply_and_verify' "$flow_file" | head -1 | cut -d: -f1)"
if [ "$admit_line" -ge "$invalidate_line" ] || [ "$admit_line" -ge "$apply_line" ]; then
  echo 'admission output is not consumed before baseline invalidation and delivery' >&2
  exit 1
fi
if ! awk '/id: admit_queued_database_delivery/{admit=NR} /VORTEX_DOPPLER_TOKEN/{doppler=NR} END{exit !(admit && doppler && admit < doppler)}' "$flow_file"; then
  echo 'admission must occur before Doppler credential resolution' >&2
  exit 1
fi
superseded_branch="$(awk '/^    then:/{inside=1; next} /^    else:/{inside=0} inside{print}' "$flow_file")"
normal_branch="$(awk '/^    else:/{inside=1; next} /^triggers:/{inside=0} inside{print}' "$flow_file")"
grep --fixed-strings --quiet 'id: record_superseded_admission' <<<"$superseded_branch"
grep --fixed-strings --quiet 'io.kestra.plugin.core.execution.Exit' <<<"$superseded_branch"
grep --fixed-strings --quiet 'state: CANCELED' <<<"$superseded_branch"
if grep --extended-regexp --quiet '(invalidate_reusable_full_baseline|apply_and_verify|publish_testing_evidence|publish_immutable_fresh_receipt|publish_reusable_full_baseline|VORTEX_DOPPLER_TOKEN)' <<<"$superseded_branch"; then
  echo 'superseded branch must terminate without delivery or evidence publication' >&2
  exit 1
fi
grep --fixed-strings --quiet 'id: invalidate_reusable_full_baseline' <<<"$normal_branch"
grep --fixed-strings --quiet 'id: apply_and_verify' <<<"$normal_branch"
grep --fixed-strings --quiet 'id: publish_testing_evidence' <<<"$normal_branch"

echo 'queued database admission contract tests passed'
