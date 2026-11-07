# Local runtime persistence

The SQLite adapter in `src/runtime/` is the local reference backend, using
Node's built-in `node:sqlite`. It is not an xMatrix deployment. The
`DurableStore` interface is asynchronous so browser and cloud adapters can use
IndexedDB or a remote database without changing the evaluator. SQLite's
transaction bodies remain synchronous; no transaction spans an awaited callback.

## Checkpoints, deliveries and requests

A checkpoint pins code and machine ABI, revision, JSON machine state and one
canonical `waitingFor` reference. Closures and lexical environments use explicit
identifiers, not native functions or object cycles. Nonportable values are
rejected before writes, including JSON's silent transformations. Special numbers
such as negative zero need an explicit evaluator representation.

`commit` atomically saves a checkpoint, effect intents and newly issued
requests. Two workers at the same revision cannot both commit. Terminal
executions cannot resume. Successful completion still drains messages already
committed by the program. Cancellation, revocation or failure withdraws queued
work. Every kind of program ending, including successful completion, closes
its still-open requests as `Cancelled`; terminal notices remain deliverable. Already
dispatched work cannot be undone by changing a database row.

A **delivery** records whether an original message was delivered. A **request**
independently records the current holder, assignment epoch and a single terminal
reply and absolute `by` deadline. Delivery acknowledgement never substitutes
for a person's answer. Replies are `Answered`, `Refused`, `Broke`, `NoReply`,
`Cancelled` or `Revoked`. Only the authority clock can produce `NoReply`.
A request closes at `by` even if nobody waits on it or scans at the boundary.
Replies, handovers, dispatch claims, status reads and recovery resolve expired
requests before proceeding. A reply exactly at `by` is too late. Relative
deadlines are converted once, using commit time, not a caller-supplied timestamp.

`handOver` keeps the request ID and original absolute deadline, advances its epoch, withdraws an unsent old
offer, notifies the previous holder and offers it to the next. Old holders
cannot settle it. Settlement atomically records the result, withdraws queued
offers and queues a terminal notice. This does not undo work a previous holder
already performed.

## Dispatch and recovery

Intent IDs survive retries. A dispatcher claims an intent with a lease and
fencing epoch. An expired or explicitly uncertain claim is recovered in
**reconcile** mode, never as permission to resend. `prepareRetry` requires host
confirmation that the original ID is deduplicated or the previous sender is
fenced and a subsequent host query confirms it never received that ID. That
evidence comes from the host, not the passage of time. Without it the intent
remains uncertain and visible. Retrying an obsolete request offer is refused
even if the host supports deduplication.

Lease fencing prevents obsolete workers from writing delivery state. It cannot
stop a process that has already issued an external action. Hosts must check
current authority, request assignment and reply schema at their own boundary; a
local lease, a notification label or a stored response is not an authorization
grant. Reconciliation may record an original delivery after cancellation, but
cannot resume the terminated program or send new work for it.

A failed reconciliation parks the intent as `blocked`, outside executable scans.
Only `provideEvidence` makes it eligible for another reconciliation. Obsolete
unconfirmed request offers become `superseded`; release/closure notices remain
deliverable, and no worker keeps reclaiming the old offer.

A wait persists its target set, independent observation deadline, event cursor
and result. An empty set, used by `never()`, has no occurrences. At this storage
boundary `StoredWait.outcome` is one of:

- `{tag: "Reply", reply}` for a request's terminal reply;
- `{tag: "Occurred", value}` for an event or timer's actual payload;
- `{tag: "Elapsed"}` when only the observation deadline passed.

These tags are storage data, not constructors programs use. `wait` returns a
request's reply or an event's value. `waitUntil` returns `Some` of that value
or `None`; it never cancels the observed request. A request's `NoReply` at the
same instant as the observation deadline wins (`Some(NoReply)`). Other replies
and occurrences must precede that deadline strictly. An already resolved wait
is immutable, so later inputs cannot reverse an earlier observation timeout.

Each event/timer target can persist a `path`, an outer-to-inner array of
`First`/`Second` constructors. `or` composes paths without replacing the
occurrence's value. Both paths and selected values survive restart. Facts may
predate registration; streams use a cursor captured in the registration
transaction. Self-caused occurrences are ignored and event IDs deduplicate
inputs. No physical delivery or live permission is inferred from a timer.

A valid late or obsolete reply is retained with `accepted: false`. Invalid
answers use `rejectAnswer`, which retains the original JSON and an
`invalidReason` without assigning any reply. In particular, an unrecognized
answer is not `Refused`. Production hosts validate their own reply schemas and
current authority before settlement; the reference simulated host performs
these checks for its declared interface.

Storage owns the trusted clock, injected into `SqliteStore` at construction.
Production defaults to the local system clock; tests share a `VirtualClock` with
the simulated host. Observation time is monotonic in the database across
connections/restarts. Event payload timestamps do not advance the clock or
arbitrate deadlines. Public calls do not accept a caller's `now` or default to
0. A distributed production adapter must use its authority's database/service
clock, rather than trusting the clocks of individual dispatch workers. A local system
clock that incorrectly jumps forward also advances the persisted floor; the
reference adapter cannot correct that by rewinding deadlines. The production
xMatrix adapter should use PostgreSQL authority time rather than this local
system-clock default.

`scanEffects` discovers queued deliveries and expired claims. `scanReady()`
discovers runnable checkpoints, including suspended executions whose referenced
delivery or request result was stored before a crash. Both support keyset
pagination. The snapshot is resumed only by another revision-checked commit;
recording an input alone never runs user code.

## Local storage and compatibility

SQLite uses full synchronous commits and serializes initialization and writes.
Connection startup leaves journal mode unchanged to avoid a concurrent WAL-mode
initialization race. Experimental schema version 8 refuses older/newer versions;
it does not silently reinterpret snapshots or rewrite an unsupported store.
The machine ABI is `norn-cek:4`: it includes request-returning verbs, distinct
request replies and event values, observation-only `waitUntil`, and tagged `or`.
Version errors name the stored and required versions. The previous schema 7 /
ABI 3 is refused; neither adapter silently migrates or reinterprets its state. A failed handler's notification
intent and continuation past reporting commit together under the same revision.
Earlier experimental stores and checkpoints need their matching runtime; this
prototype does not migrate them or silently change their built-in semantics.

New database files are owner-only. Supply a private parent directory; existing
files retain their permissions. Snapshots may contain private captured inputs.
The adapter provides local durability, not encryption or isolation from other
processes running as the same OS user.

Run the focused persistence checks with:

```sh
node --test test/runtime/store.test.ts test/runtime/store-contract.test.ts test/runtime/reply-contract.test.ts
```

They cover restart and SIGKILL recovery, competing workers, cancellation,
uncertain delivery, stale lease and request epochs, independent delivery/answer
state, discovery after restart, atomic refusal of invalid data, pinned code/ABI
and unsupported schema versions. Actual language execution and host permission
integration require the evaluator and simulated-host checks; persistence checks
alone do not establish language conformance.
