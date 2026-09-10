# Testing sign-in and organisation-page performance repair

Task: [#347](https://github.com/Abzum-NZ/Abzum-Vortex/issues/347).

## Outcome and scope

People should reach their organisation promptly after signing in. Fix measured
waiting in the existing journey without weakening session, membership or tenant
checks, changing product behaviour, or building new monitoring infrastructure.

## Measured baseline — 8 September 2026

Source: [Vercel request logs](https://vercel.com/abzumdevteam/abzum-vortex/logs),
Testing deployment `dpl_FDxrFLN1TGKhtBfqqygKV3NGz7Uw`.

| Request                                                                           | Server response | Function     | Middleware       |
| --------------------------------------------------------------------------------- | --------------- | ------------ | ---------------- |
| Successful sign-in, `pzb75-1788848493434-324951d24950`, 06:21:33.434 UTC          | 7.0 seconds     | 6.55 seconds | 45 milliseconds  |
| Protected organisation page, `p58g5-1788849355540-1bdf7197f202`, 06:35:55.540 UTC | 7.6 seconds     | 5.96 seconds | 994 milliseconds |

These are server-log measurements, not browser observation intervals or complete
click-to-painted-page measurements. Outgoing request timings are unavailable on
the existing plan; do not infer individual call durations from the totals.

The [function settings](https://vercel.com/abzumdevteam/abzum-vortex/settings/functions)
show Washington (`iad1`). The connected Supabase project listing confirms
Testing project `abflfptnguasinoussws` is in Sydney (`ap-southeast-2`). The page
performs several sequential database statements. Both middleware and page
processing fetched authentication signing keys in the observed request.

## First implementation

1. Set the existing web deployment's `regions` to `["syd1"]` in its tracked
   `apps/web/vercel.json`, using the [official Vercel configuration](https://vercel.com/docs/functions/configuring-functions/region#project-configuration).
2. Leave authentication, cookies, permissions, SQL, pool sizes, redirects and
   session checking unchanged in this first patch, so its effect is attributable.
3. Verify configuration, obtain independent Sol review of the actual patch,
   deploy through the normal Testing path and measure repeated protected-page
   requests and sign-in when an available authenticated journey permits it.
4. Investigate remaining repeated work only if the new measurements justify it.
   Inspect the installed SDK's actual signing-key cache before adding another.

## Acceptance

- [x] The deployed Testing function executes in Sydney beside its database.
- [x] Signed-in organisation loading still succeeds for the existing user.
- [x] Before/after request durations and exact deployed revisions are recorded;
      browser wall time is not represented as a network trace.
- [x] Session validation, immediate access checks and tenant isolation are unchanged.
- [x] Independent Sol reviews the actual configuration change.
- [x] GitHub task, build plan and hosting specification record the result.

No new service, paid plan, database reset, credential change, global cache of
user authority, security bypass or performance-based release gate is required.

## SDK finding

A repeat protected-page request, `qbmhs-1788849066650-243cf3ac508d` at
06:31:06.650 UTC on the same deployment, took **5.6 seconds** overall:
5.14 seconds in the function and 7 milliseconds in middleware. It made no
outgoing HTTP requests. This confirms the page remains slow even when signing
keys are already cached; do not attribute that warm delay to signing-key fetches.

The installed Supabase Auth SDK 2.115.0 already shares its signing-key cache across
clients in each JavaScript runtime, with a ten-minute lifetime. A fresh verifier
does not by itself defeat that cache. Middleware and page functions can have
separate or cold runtimes. Therefore this repair does not add a verifier singleton
or a second signing-key cache.

## Verified Testing result — 8 September 2026

[PR #348](https://github.com/Abzum-NZ/Abzum-Vortex/pull/348) passed independent
Sol review of the actual patch and the normal build, then merged into Testing.
The baseline source was [32d40f09](https://github.com/Abzum-NZ/Abzum-Vortex/commit/32d40f09b022dd292978d60a87f5c5052b9708b1).
The repaired source is [7d48e36a](https://github.com/Abzum-NZ/Abzum-Vortex/commit/7d48e36a22535eb45213064b223af8045db9d337),
deployed as [dpl_2TjPvTJnBxxVfu8G7hm9XpaedPWj](https://vercel.com/abzumdevteam/abzum-vortex/2TjPvTJnBxxVfu8G7hm9XpaedPWj).
Its [actual deployed resources](https://vercel.com/abzumdevteam/abzum-vortex/2TjPvTJnBxxVfu8G7hm9XpaedPWj/resources)
confirm the sign-in, signed-in redirect and organisation functions run in Sydney.
Middleware still uses Vercel's normal all-region placement.

| Request (UTC)                                                                | Server response  | Function         | Middleware       |
| ---------------------------------------------------------------------------- | ---------------- | ---------------- | ---------------- |
| Sign-in, 06:56:12.393, `rdtb4-1788850572393-8072a2f0bf7c`                    | 2.8 seconds      | 1.94 seconds     | 598 milliseconds |
| Organisation after sign-in, 06:56:15.504, `rdtb4-1788850575504-17506a3ff5e2` | 146 milliseconds | 107 milliseconds | 17 milliseconds  |
| Organisation reload, 07:01:35.255, `jbtqn-1788850895255-fc38247ad432`        | 725 milliseconds | 537 milliseconds | 81 milliseconds  |
| Organisation reload, 07:03:19.924, `rdtb4-1788850999924-e03c933d1cc2`        | 320 milliseconds | 189 milliseconds | 53 milliseconds  |

All requests returned HTTP 200 on the repaired Testing deployment and the page
showed the expected signed-in organisation and user. The three organisation
requests made no outgoing HTTP requests. Sign-in fetched signing keys and called
the unchanged authentication provider. The user supplied credentials; the test
submitted them without reading or recording them. An existing session was present,
so this is a successful reauthentication measurement, not a cookie-empty cold test.

The measured sign-in response decreased by 60%; the observed organisation
responses were 87–97% shorter than the 5.6-second warm baseline. These are small
before/after samples, not percentile guarantees or full browser paint timings.
A screenshot of the 725-millisecond request was shown in the work conversation.
No authentication checks, permissions, queries, credentials, database schema or
Production deployment changed. The hosting requirement is recorded in
[runtime storage and caching](../specification/17-runtime-storage-and-caching.md).
The demonstrated delay is sufficiently repaired; resume engine delivery rather
than add caches or redesign sign-in without a further measured problem.
