# Application-owned field value consumers

[Field definitions #44](https://github.com/Abzum-NZ/Abzum-Vortex/issues/44) ·
[Plan](../build-plan/issue-44-record-field-values.md#rule-consumer-handoff) ·
[Value specification](../specification/05-modules-fields-and-relationships.md#record-value-formats)

## Confirmed problem

Application compilation and validation resolve exact Module dependencies, but
several consumers then discard the owning Module's value format. Application
rules, actions, query filters, page visibility, pipeline gates and workflow
conditions/assignments can consequently interpret V2 exact decimals, money or
typed references using V1 assumptions. The containing Application's version is
not the correct selector.

## Scope and delivery status

Implementation, independent review and Testing delivery are complete. The correction reuses existing value helpers and
retains ownership through the Application consumer path. It does not add another
rule engine, invent new legacy input types, change database permissions or deliver
protected record saving. New exact-value flow inputs and served-interface wire
types remain explicit requirements of
[#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58) and
[#102](https://github.com/Abzum-NZ/Abzum-Vortex/issues/102).

The review also found that workflow record-field inputs dropped their authored
allowed record types during compilation. The canonical input now retains those
identifiers; historical canonical inputs without them still use the owning
field's declared targets. This preserves existing source meaning rather than
adding an input type or authority grant.

Two editable application workflow literals still used plain strings for fields
whose Modules now require structured text. Those fixture literals are deliberately
authored as paragraph documents. The compiler does not silently convert strings,
and the historical fixture files remain unchanged.

The Service Desk comment operation also needs a structured document input. An
explicit `formatted_text` interface input descriptor is added through source and
canonical contracts; the fixture keeps its operation rather than dropping it.
This is a Definition prerequisite for [#102](https://github.com/Abzum-NZ/Abzum-Vortex/issues/102),
not a delivered HTTP/MCP interface or an implemented action save. Existing input
types and interface output types retain their meanings.

The editable Service Desk interface advances to `2.0.0` because changing its
comment input from plain text to a structured document is a breaking wire change.
Its permanent identifiers and historical fixtures remain unchanged.

## Evidence recorded so far

- Before code changes, the existing Module V2 and complete current application
  suites passed: two files, eleven tests. These passing baseline cases did not
  cover the discovered Application-owned value-consumer gap.
- An independent Sol architecture review approved the owning-Module semantics
  and the one-engine delivery sequence after correcting the dependency diagram.
  This is a documentation verdict, not approval of the implementation.
- The focused Application consumer suite passes 23 tests, including actual
  Definition publication and consumer readback for Application V1 and V2.
  The nine Module V2 cases and two complete current-bundle cases also pass.
  These prove definition handling, not protected record persistence or HTTP/MCP
  operation execution.
- Root regression: 69 files, 1,036 tests passed across Definition, Contracts,
  Rule, fixtures and the Access definition adapter. Scoped formatting/lint,
  all 23 package boundaries and diff checks passed.
- Independent Sol actual-patch review approved all fourteen scoped files with
  no remaining findings. Independent verification passed 48 tests in four files,
  the focused interface version-impact test, Contracts/Definition type checks,
  scoped lint and diff checks. Final reviewed compiler hash:
  `62018826ef99b7eacd2f879699060016b912b6e82e03b7b346e23f6941cea781`.
- [PR #366](https://github.com/Abzum-NZ/Abzum-Vortex/pull/366) merged into Testing
  as `e8b35f3ce2b74af070f0bedfa753d35e50788502` after the actual source preview
  passed. The unchanged merge-only branch update was not substituted for that
  source build evidence.
- [Testing deployment](https://vercel.com/abzumdevteam/abzum-vortex/G6LSGc2kCpb9zUnHmJ6VMrWZqAd7)
  is Ready, with that exact merge commit and `vortex-testing.abzum.com` assigned.
  Build duration: 3 minutes 6 seconds. Fresh signed-in navigation still resolves
  to the organisation page rather than asking for credentials again.
- No whole-task acceptance is closed by this document. Protected persistence
  and served operation execution remain in their owning tasks.
