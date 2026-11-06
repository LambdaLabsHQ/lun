# Local runtime persistence

The SQLite adapter in `src/runtime/` is the local reference backend, using Node's
built-in `node:sqlite`. It is not an xMatrix deployment. The `DurableStore`
interface is asynchronous so browser and cloud adapters can use IndexedDB or a
remote database without changing the evaluator. SQLite's transaction bodies
remain synchronous; no transaction spans an awaited callback.

## Checkpoints, deliveries and requests

A checkpoint pins code and machine ABI, revision, JSON machine state and one
canonical `waitingFor` reference. Closures and lexical environments use explicit
identifiers, not native functions or object cycles. Nonportable values are
rejected before writes, including JSON's silent transformations. Special numbers
such as negative zero need an explicit evaluator representation.

`commit` atomically saves a checkpoint, effect intents and newly issued requests.
Two workers at the same revision cannot both commit. Terminal executions cannot
resume. A terminal transition withdraws queued work and closes open requests;
terminal notices remain deliverable. Already dispatched work cannot be undone by
changing a database row.

A **delivery** records whether an original message was delivered. A **request**
independently records the current holder, assignment epoch and a single terminal
outcome. Delivery acknowledgement never substitutes for a person's answer.
`TimedOut` belongs to a wait and is not a terminal request outcome. Request
outcomes are `Done`, `Declined`, `Failed`, `Cancelled` or `Revoked`.

`handOver` keeps the request ID, advances its epoch, withdraws an unsent old offer,
notifies the previous holder and offers it to the next. Old holders cannot settle
it. Settlement atomically records the result, withdraws queued offers and queues
a terminal notice. This does not undo work a previous holder already performed.

## Dispatch and recovery

Intent IDs survive retries. A dispatcher claims an intent with a lease and
fencing epoch. An expired or explicitly uncertain claim is recovered in
**reconcile** mode, never as permission to resend. `prepareRetry` requires host
confirmation that the original ID is deduplicated or the previous sender is fenced and a subsequent host query confirms it never
received that ID. That evidence comes from the host, not the passage of time. Without
it the intent remains uncertain and visible. Retrying an obsolete request offer
is refused even if the host supports deduplication.

Lease fencing prevents obsolete workers from writing delivery state. It cannot
stop a process that has already issued an external action. Hosts must check
current authority, request assignment and reply schema at their own boundary;
a local lease, a notification label or a stored response is not an authorization
grant. Reconciliation may record an original delivery after cancellation, but
cannot resume the terminated program or send new work for it.

A failed reconciliation parks the intent as `blocked`, outside executable
scans. Only `provideEvidence` makes it eligible for another reconciliation.
Obsolete unconfirmed request offers become `superseded`; release/closure notices
remain deliverable, and no worker keeps reclaiming the old offer.

A wait persists its target set, deadline, event cursor and terminal outcome.
The target set may include requests, external facts/occurrences and timers.
Observing an existing fact and recording a stream cursor happen in the same
transaction as registration. Self-caused events are ignored. Deadlines are
exclusive: an answer at the deadline loses to timeout. An `ask`-style timeout
withdraws its request; an explicit handle wait leaves it open. Late inputs cannot
overwrite a stored wait outcome.

`scanEffects` discovers queued deliveries and expired claims. `scanReady(now)`
discovers runnable checkpoints, including suspended executions whose referenced
delivery or request result was stored before a crash. Both support keyset
pagination. The snapshot is resumed only by another revision-checked commit;
recording an input alone never runs user code.

## Local storage and compatibility

SQLite uses full synchronous commits and serializes initialization and writes.
Connection startup leaves journal mode unchanged to avoid a concurrent WAL-mode
initialization race. Experimental schema version 4 refuses older/newer versions;
it does not silently reinterpret snapshots or rewrite an unsupported store.

New database files are owner-only. Supply a private parent directory; existing
files retain their permissions. Snapshots may contain private captured inputs.
The adapter provides local durability, not encryption or isolation from other
processes running as the same OS user.

Run the focused persistence checks with:

```sh
node --experimental-strip-types --test test/runtime/store.test.ts
```

They cover restart and SIGKILL recovery, competing workers, cancellation,
uncertain delivery, stale lease and request epochs, independent delivery/answer
state, discovery after restart, atomic refusal of invalid data, pinned code/ABI
and unsupported schema versions. Actual language execution and host permission
integration require the evaluator and simulated-host checks; persistence checks
alone do not establish language conformance.
