# Local runtime persistence

The first local persistence adapter is SQLite, using Node's built-in
`node:sqlite`. It is a reference implementation, not an xMatrix deployment or a
claim that every runtime conformance case already passes. Node 22's SQLite API
is experimental. A browser or cloud host can implement `DurableStore` with a
different backend; the language does not depend on SQLite.

## Checkpoints and effects

`src/runtime/persistence.ts` defines the portable boundary. A checkpoint pins a
code identity and machine ABI, a monotonic revision, status, and JSON snapshot.
The evaluator owns the snapshot schema. Lexical environments and closures use
explicit identifiers inside that data instead of native JavaScript closures or
object cycles. Values that JSON would silently omit or change are refused;
special numeric values, including negative zero, need an explicit representation
in the evaluator's value format.

`commit(expected, change)` atomically saves a new checkpoint and its effect
intents. Two workers starting from the same revision cannot both commit. A
different code identity or machine ABI cannot replace the pinned definition,
and a terminal execution cannot be resumed. Effects receive stable identities
derived from the execution and committed revision; transport retries retain
those identities.

The dispatcher must commit an intent before sending anything. `beginDispatch`
claims a pending intent. If the process dies after that claim, recovery observes
`dispatching`, not a fresh pending action. It must reconcile the original request;
`markUncertain` makes an unconfirmed outcome explicit. It must never invent a
replacement request merely because an acknowledgement was lost.

`recordResult` stores one result for the original effect. This is not an
execution resumption or an authorization grant. The host must validate current
authority, request epoch, reply schema and correlation; the evaluator must still
commit its next checkpoint at the expected revision. A production host owns
those decisions at its existing authority boundary. A lease or a dispatcher
claim does not guarantee that a physical external action happened only once.

## Local durability and compatibility

`SqliteStore` uses transactions for checkpoint/outbox changes and full synchronous
commits. Concurrent processes serialize initialization and writes. Opening a
connection does not change the database's journal mode: concurrent changes to
WAL mode would introduce an initialization race unrelated to program execution.
It opens only its own schema version, refuses nonempty unversioned databases,
and requires an explicit migration for a newer storage version. It does not
rewrite user data to recover an unsupported schema.

New on-disk database files are created with owner-only permissions. The caller
must supply a private parent directory; existing files keep their permissions.
Snapshots can contain private captured inputs and must not become public debug
output. SQLite here supplies local durability, not encryption or a boundary
between processes running as the same OS user.

Focused checks run without third-party runtime dependencies:

```sh
node --experimental-strip-types --test test/runtime/store.test.ts
```

They exercise JSON restart recovery, a process killed immediately after commit,
competing workers, loss between dispatch and receipt, refusal of nonportable
state, code/ABI fencing and unsupported database versions. Request settlement,
time, permissions and actual language execution are covered by the evaluator
and simulated-host integration as those components land.
