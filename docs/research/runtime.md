# Norn: durable runtime research

> Written by Codex for the Norn design discussion, 2026-11-06. The xMatrix-specific adapter proposal from the original study lives in the xMatrix repository.

Design study, 2026-11-06. This is a proposal, not an implemented runtime or a performance benchmark. The language direction is modern functional programming with readable expression syntax. The language and its reference implementation should be independent of xMatrix; xMatrix is the first host.

## Recommendation

Define a pure functional core with host-interpreted durable effects. Keep the public language independent of how an execution is saved. A continuation is a useful account of what remains to execute, not a requirement to persist native stacks, adopt Lisp, or expose `call/cc`.

For the first implementation, compare two runners over the same typed program and effect protocol:

1. An explicit, serializable evaluator state, checkpointed at effects, with a small effect journal.
2. A deterministic runner backed by an existing durable workflow service, using recorded effect results when recovering.

The first is the leading candidate for the xMatrix host because it can keep program state, pending effect intents and current authorization at the existing PostgreSQL authority boundary. That is an architectural inference, not evidence that a custom engine is already cheaper or more reliable. Cloudflare Workflows is the practical managed challenger given the current deployment platform. A small failure-injection prototype should settle the backend choice before a production interpreter is committed to.

Do not select a platform just because its documentation says “durable,” and do not reject replay simply because a program waits for weeks. Program version pinning and long waits are available in existing replay systems too.

## Compare independent choices separately

| Question | Alternatives | Consequence |
| --- | --- | --- |
| How does an author express cooperation? | Functions, effects, actor messages, streams, protocol types | User-facing semantics and composition |
| How is progress recovered? | Replay, explicit evaluator checkpoints, process snapshots, hybrids | Crash recovery and compatibility |
| Where does an execution run? | Worker, process, Wasm executor, managed workflow service | Deployment and resource costs |
| Who owns each durable fact? | A scoped single authority with authenticated messages between scopes | Concurrency, permissions and cancellation |

An actor can execute an effectful functional program and recover it by replay or snapshots. These are compatible layers. A distributed implementation also needs an authority for each fact; decentralized participants do not require conflicting writers for the same request.

## Primary-source survey

The final column is our assessment for this project, not a vendor guarantee. No paid service was provisioned and no runtime was installed for this study.

| System | Documented mechanism | Useful lesson and fit |
| --- | --- | --- |
| [Temporal](https://docs.temporal.io/encyclopedia/event-history/event-history-typescript), [Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning) | Replays workflow history and reuses activity results. Pinned executions can remain on their starting worker deployment version. | Strong baseline for recovery, signals and version management. It does not require one live process during a long wait. Adopting it adds service/worker operation and still leaves xMatrix identity, grants and result evidence to the adapter. |
| [Restate](https://docs.restate.dev/foundations/actions), [awakeable SDK contract](https://docs.rs/restate-sdk/latest/restate_sdk/context/trait.ContextAwakeables.html), [failure semantics](https://restate.dev/blog/why-we-built-restate) | Journals durable operations; awakeables expose a persistent completion handle for external participants. Side effects can repeat if execution succeeds before their result becomes durable. | Closest ready-made reference for `request` plus later completion. Durable promises are useful, but a promise ID does not establish who is authorized to answer. |
| [Cloudflare Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/), [events](https://developers.cloudflare.com/workflows/build/events-and-parameters/), [limits](https://developers.cloudflare.com/workflows/reference/limits/) | Named steps save results; execution can restart around those steps. Nondeterministic operations belong inside steps. External events and sleeps suspend execution. | Fits current hosting. Step identity, lifetime/retention constraints and authorization across the service-to-PG boundary need evaluation. An event callback is not a substitute for a transactional request admission. |
| [Azure Durable Functions](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-external-events), [Dapr Workflow](https://docs.dapr.io/contributing/protocol-reference/workflow-protocol/workflow-protocol-orchestration-lifecycle/) | Event history and replay; external events can be raced with durable timers. Azure documents duplicate external events for some storage providers. | Confirms that people replying after long waits is an established durable-execution use case. Correlation, deduplication and timeout races remain explicit contracts. These add a different hosting stack for xMatrix. |
| [Inngest execution](https://www.inngest.com/docs/durable-execution/durable-workflows), [event waits](https://www.inngest.com/docs/durable-execution/primitives/step-waitforevent) | Saves named step results and injects them when executing a resumed function. Event waits match only events arriving after listening begins. | Good event-driven reference. “Wait for a fact that may already be true” needs a state observation/subscription protocol; waiting for the next event is insufficient. |
| [Trigger.dev](https://trigger.dev/docs/how-it-works), [waitpoint tokens](https://trigger.dev/docs/wait-for-token) | CRIU checkpoints the task process, including memory and registers, for later restoration. Waitpoint tokens support external completion. | Demonstrates an alternative to replay and a custom language VM. For small coordination programs, process snapshots would introduce a separate execution environment and more opaque state than the current Worker host needs. |
| [Golem durable execution](https://learn.golem.cloud/v1.6/concepts/durable-execution), [snapshotting](https://learn.golem.cloud/v1.6/develop/snapshotting) | Wasm execution recovers by replaying an operation log. User state snapshots shorten replay. In-flight external HTTP calls can be resent with the same idempotency key. | Wasm is an execution substrate, not automatically a portable serialized continuation. Golem is a useful hybrid reference; adopting its executor is a broader decision than embedding a Wasm parser. External services must honor deduplication keys. |
| [Unison abilities](https://www.unison-lang.org/docs/fundamentals/abilities/writing-abilities/), [production experience](https://www.unison-lang.org/blog/experience-report-unison-in-production/), [distributed consistency](https://www.unison-lang.org/blog/volturno-design/) | Handlers receive resumptions; functions can be serialized and shipped with content-addressed code. Its distributed stream implementation separately reasons about state/message consistency. | Strong language/runtime reference for effectful functional programs and code identity. Serializable code does not itself establish delivery, revocation, cancellation or exactly-once external actions. |

### What these sources change

- Replay is a viable candidate, not a temporary hack that prevents all source editing. An active execution needs its original definition or an explicit migration under either strategy; newer definitions can coexist.
- Snapshots and journals are often complementary. Saving program memory does not resolve a request that reached an external recipient just before a crash.
- Native process snapshots, portable evaluator state and saved step results are different things. A product using the word “checkpoint” does not tell us which it persists.
- No surveyed mechanism removes the host's responsibility to authenticate a reply, recheck current grants, distinguish missing evidence and arbitrate competing outcomes.

## Semantics the backend must preserve

### Requests and waits have separate lifetimes

Creating a request returns a durable handle after the intent is recorded. It does not assert that the recipient accepted, started or completed it. The resolved participant is a stable identity; `auto` is a routing policy, and a display name is not identity or permission.

The following is an illustrative type contract, not settled concrete syntax:

```text
request : Participant * Instruction<T> -> Request<T>

RequestOutcome<T> =
  | Completed(T, CompletionEvidence)
  | Declined(Reason)
  | Failed(Error)
  | Cancelled(CancellationEvidence)
  | PermissionRevoked

WaitResult<T> =
  | Ready(RequestOutcome<T>)
  | DeadlineReached(Request<T>)
```

Dispatch uncertainty and unconfirmed process cleanup remain observable request progress, not fabricated terminal results. Absence of a receipt does not prove failure. `Completed` means the recipient supplied the completion evidence required by that request; it does not automatically mean a person accepted the work or that an LLM's claim was verified.

An `ask` or `run` convenience function can compose request creation and waiting. Its timeout must not silently erase the request handle. A host may revoke pending authority at a deadline, but it cannot infer that the recipient's process stopped or that prior actions were undone.

Retargeting is an explicit generation change to a logical request. Transport retries reuse the existing request and effect identities. They do not allocate new work because an acknowledgement was lost.

### Single committed resumption, not single physical evaluation

A worker can reevaluate pure code after a crash. The invariant is that only one state transition from a particular suspended execution revision commits. Worker leases provide scheduling, while a revision/epoch check fences stale writers at commit.

The program state and durable effect intent must be recorded together before dispatch. The receiver deduplicates the logical effect identity and binds a reply to that exact request generation. An incoming outcome competes with timeout, cancellation and revocation at the owning authority boundary. Losing or late replies remain evidence; they do not resume the consumed wait again.

After dispatch but before confirmation, reconcile the same identity. If the receiver cannot deduplicate or report the outcome, keep the uncertainty visible rather than blindly repeat a potentially non-idempotent action. This applies under replay, checkpoints and process snapshots alike.

### Events and facts are different APIs

`next(stream, cursor)` asks for an event after a position. Waiting for a condition such as “this PR has a successfully deployed beta” asks for a fact that might already hold.

For the latter, record an authorized observation/cursor and register a durable wait with a recheck, so an event cannot fall between observing false and subscribing. Correlate the exact PR/SHA/release or request identity, not a later unrelated message. Durable event ingestion must precede acknowledging delivery; unfinished fan-out needs a durable continuation of its own.

Use each authority's committed order to resolve deadline races, with a documented late-delivery policy. A source timestamp in an arbitrary webhook cannot backdate an already settled timeout. This rule does not assume a global clock or total event order across all Spaces.

Stream operators need execution policies too. `forEach` over daily ticks and CI failures must define whether work is serialized, coalesced, queued or concurrent. Library syntax must preserve that distinction. Cancelling one losing wait in a race is separate from cancelling the work it observes.

### Versioned code, current authority

Pin the program definition and imported dependency closure for an execution. Record the compiler/IR version, persisted-value schema and host effect ABI needed to resume. Hashing source code identifies code; it cannot make an incompatible runtime or result schema compatible.

Every host effect is admitted under current owner membership, source lifecycle, recipient grants, resource scope and policy. Store credential references, never credentials or live authorization tokens in suspended program state. Private values captured by a program remain protected runtime data; they are not automatically Page content or public debugging output.

Executable Page content requires a deliberate execution declaration and the existing policy-controlled admission boundary. Examples, imported documents and quoted code remain content. A page-edit grant is not automatically permission to start arbitrary Agent work.

Changing an executable definition creates a new version. The activation contract must say whether an existing execution drains, is cancelled or is explicitly migrated; it must not launch both versions accidentally or transplant old frames into new code. Removing its source must not leave invisible authorized work behind.

### Concurrency and participant autonomy

Prefer structured child executions and explicit requests over exposing unrestricted multi-shot resumptions. Two child requests have distinct identities; they do not duplicate an already granted approval or an in-flight external write. This is compatible with a Turing-complete pure language.

A participant reference can be passed between programs without granting the caller the right to act as that participant. Cross-Space cooperation is an authenticated protocol between authorities, with current grants checked at each receiving boundary. No central graph editor or global execution singleton is required.

## A portable kernel and a host adapter

The standalone language project should own:

- The grammar, type rules, standard library and program/effect semantics.
- A versioned portable program representation and a reference evaluator.
- A host contract for durable state transitions, request delivery, event observation, time and authorization results.
- A local durable store/clock implementation for running examples and restart tests without xMatrix.
- A deterministic failure-injection conformance suite, usable by every host implementation.

The xMatrix adapter should own stable Human/registration/Instance/Run bindings, Page and Channel provenance, existing launch admission, connector permissions, secrets, cancellation and result receipts. The core should not import Hub modules, PostgreSQL table names, Cloudflare bindings or xMatrix account registration.

One possible evaluator interface is `(program, state, input) -> transition`, where a transition describes the next durable state and pending host effects. This is an internal implementation model; authors still write ordinary functional programs, not nodes, edges or transition tables. An implementation may use CPS, defunctionalized frames, a bytecode machine or compiled resumable functions to produce that interface.

## Backend selection experiment

Use the same modern-functional source examples and the same effect adapter with both shortlisted runners. Measure implementation complexity, state/journal size, recovery work, deployment footprint and clarity of upgrade behavior. No performance or cost winner is claimed before this experiment.

| Case | Required observable behavior |
| --- | --- |
| Human replies after a long wait and a host restart | One authorized reply resumes one wait; no retained process was required. |
| A release fact exists before registration | Fact waiting succeeds; next-event waiting retains its distinct cursor semantics. |
| Duplicate event and concurrent workers | One committed resumption and one logical request identity. |
| Crash after intent commit, before dispatch | The same pending effect is durably rediscovered. |
| Crash after dispatch, before receipt | Reconcile the original request; no invented success or uncorrelated replacement. |
| Reply races timeout or source deletion | One authoritative resolution; a late reply remains inspectable evidence. |
| Cancellation while an Agent is already running | Execution authority and process-stop confirmation stay distinct. |
| Permission is withdrawn while suspended | The next effect is denied under current grants. |
| Definition, library or VM ABI changes | Old executions resume against a supported pinned version or visibly require migration. |
| Event stream bursts while a task runs | Declared serialization/coalescing/concurrency policy is preserved. |
| Pure code loops without performing effects | Execution yields fairly and can be cancelled without blocking other programs. |
| A fork or cross-Space handoff carries a handle | It neither duplicates approval rights nor grants access by naming a participant. |

These are acceptance cases to implement later, not tests reported as passed by this study.
