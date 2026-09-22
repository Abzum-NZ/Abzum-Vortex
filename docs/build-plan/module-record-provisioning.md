# Module installation and record storage

[Current roadmap](README.md) · [Architecture review](architecture-review-2026-09-21.md) · [Storage specification](../specification/17-runtime-storage-and-caching.md) · [Record save sequence](../specification/06-records-and-lifecycle.md#save-sequence)

Current issue descriptions own pickup order and bounded implementation scope. Completion is implementation plus independent code review. This note adds no tests, database proof, hosted checks or obsolete format support.

## Installation and storage

- Module owns exact binding activation and detachment; Record owns storage mappings and protected adapters. Application assembles installation and upgrades. Consume the existing Definition, Access and request-context services.
- Generate tables, typed columns, constraints and fixed adapters from the exact published Module release. A fixed private database operation owns generation; callers supply neither SQL nor DDL credentials. Use one current definition representation.
- Allocate storage under `record_data`, with `rt_<full storage-contract UUID hex>` tables and `f_<full field UUID hex>` columns. Physical sharing follows record-storage meaning, not application names or organisation count. Rule-only changes do not alter physical storage. Adoption of a changed storage shape must preserve valid retained data or refuse that adoption.
- Resolve the complete transitive dependency closure with one exact release per Module root. Provision all required bindings and register the exact Application permission snapshot before activating the complete pin set. Validate expected binding revisions and current storage mappings atomically.
- Installation authority binds the authenticated caller, exact application and lifecycle operation; it does not require the target to be active already. Ordinary installed-application discovery does not require installation-management authority.
- Provisioning commits valid inactive structures. Activation is separate; a failed activation retains those structures for retry. A failed provisioning transaction removes only its own uncommitted changes. Detachment retains data and leaves other installations intact.
- Record storage uses explicit row and field enforcement. Request/runtime roles do not inherit the Record owner or receive direct content-table grants. Organisation-shared and application-contained records retain their respective scopes.
- Event declarations are read from exact published definitions; installation does not create a second copied event catalogue or mock readiness state.

## Protected save

- Adapters submit a closed command: operation, target, expected revision, command identity and proposed writable values/relationships. They cannot submit generated values, SQL, helper names or a final mutation plan.
- The trusted server prepares final values from locked authoritative state using field preparation, the shared Rule interpreter, calculations and totals. Submitted changes obey changeable-field bounds; generated changes must match installed rule write sets or derived-field declarations. Revalidate the final values and live references before writing.
- Preparation and persistence use one short existing request transaction. A changed dependency set requires a transaction retry. No transaction spans user input, external services or background execution.
- One fixed terminal Record writer enforces context, current Access, exact installation, revision, field/reference constraints and the retry receipt. It commits records, content-free success Activity, declared events/start intents and queue entries together. Failure commits none of those effects; safe request-refusal Activity is separately specified.
- Runtime may invoke the fixed terminal writer without receiving raw-table or private Event-helper access. This is a trusted backend boundary, not a sandbox for arbitrary hostile SQL; protected adapters accept only fixed parameterized operations.
- An exact command retry returns the recorded result. Reusing that command identity with different inputs is refused. Dispatch after commit cannot turn a successful save into a false save failure.
- Record defines the closed Event participant interface; Application composition wires the Event implementation. Record does not import a higher-tier engine. The private writer unconditionally includes Activity and Event participation; no optional no-op hook or alternate effect-free save endpoint exists.

## Ownership, links and numbering

- Initial account ownership derives from the current account. Initial Group ownership requires current membership. Ownership uses the current Group vocabulary; [#283](https://github.com/Abzum-NZ/Abzum-Vortex/issues/283) removes the obsolete `team` spelling and its translation adapter.
- Reference allocation starts at one when omitted, honours an explicit start and treats digit width as a minimum. Allocation serializes within its null-safe counter scope.
- Link values and canonical edges change atomically. Link changes and target deletion lock affected rows and reread the actual link before applying declared behaviour. Optional clearing needs child update authority; dependent deletion needs child delete authority.
- Restore uses retained data but rechecks current definition, access, required values and fixed-target relationship consistency after locking targets. Full final-value and live-reference checks belong to the complete save operation.
- These storage primitives do not independently add transfer, retention scheduling, polymorphic links or execution-identity authority. Their current issue owners integrate those capabilities.

## Event ownership

- Only the protected Record owner calls the private Event append helper. Request, browser and general runtime callers cannot fabricate outbox entries or choose queue, actor, sequence or save-success claims.
- Append shares the lifecycle lock, then rereads current binding/release and the actual locked Record row. Lifecycle replacement/detachment uses the conflicting lock. Derive scope, actor, time and per-record occurrence sequence from trusted facts.
- Use one private immutable outbox and the existing logged queue. Each occurrence has its own identifier; the transport message identifier is separate. Several occurrences from one save retain distinct sequence positions.
- Fresh user operations have no parent cause. Caused work accepts only a trusted parent handoff; caller-authored causal claims cannot acquire authority.
- Atomic append belongs to the save foundation. Ordered dispatch, duplicate-safe consumers and recovery belong to the subsequent Event delivery issues.

Implementation owners are the current descriptions for #43, #44, #45, #47, #48, #50, #60, #64, #400, #401 and #402. Their dependencies determine pickup; this note does not impose whole-phase gates.
