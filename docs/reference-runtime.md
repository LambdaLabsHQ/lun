# Reference machine and simulated host

The reference machine executes the versioned AST in `src/frontend/ast.ts`.
`compile` pins its JSON document by SHA-256 and assigns deterministic node IDs.
The canonical AST is stored immutably by its hash. `Runtime.restore` reloads
that artifact rather than reparsing source with a newer parser. The compiler
also freezes a private AST copy so later caller mutations cannot change pinned
code. The machine stores control, continuation frames and lexical environments
as JSON; closures contain a code node ID and environment ID. No native function
or native stack is persisted. Reload the same code identity and machine ABI to
resume it.

`advance` evaluates a finite time slice. Exhausting that slice yields a ready
machine, not a failed program. Tail calls discard completed sequence frames, and
unreachable environments are collected before checkpointing. Integers are
arbitrary precision decimal strings; floating values use explicit strings so
negative zero survives JSON. Non-finite arithmetic results fail visibly.

The machine supports immutable bindings, mutually recursive functions, labelled
arguments/defaults, variants, records, lists, tuples, interpolation,
expressions, guards, patterns, pipes, short-circuiting and function-local `?`.
Its `Effect` value is a suspension description, not permission to perform an
action.

`Runtime` drives that machine through `DurableStore`. Participant requests,
request assignment changes, waits and outgoing messages are committed with the
continuation under the checkpoint revision check. A worker that loses the check
cannot dispatch its abandoned intents. Temporary host/policy/storage failures
propagate without changing a checkpoint; only program errors commit failure.
Request answers and wait outcomes are independent, including after timeouts and
handover. The host's `Policy` is required and is consulted for effects; a real
transport must check current permissions again at delivery.

`SimulatedHost` never starts an agent or contacts an external service. It shares
a `VirtualClock` injected into the SQLite store, advanced by `advanceTo`, and
scripted replies go through the same request ID/epoch checks. Use `reply` and
`emit` to supply inputs, then `pump` to run ready programs and expose simulated
messages. On restart, supply the same pinned code, store and current host clock;
the deadlines and subscription positions are already persisted. The store owns
observation time and persists its monotonic floor. External event timestamps
remain data. Hosts cannot pass a new clock value with a reply.

This is an incremental prototype, not the entire draft specification. Request
and event waits, merged alternatives, one-shot timers, message effects and
scripted judging are implemented. Stream `map`/`filter`, durable structured
`scope`, configurable concurrent/coalescing stream processing, child programs,
real agent transports and host authorization integration are not implemented.
Unsupported operations fail visibly. The initial `forEach` machine helper is
sequential and rearms a relative timer after each callback; it does not claim
fixed-cadence or coalescing semantics. A production host also needs an alarm
adapter; advancing the virtual clock is not a background polling service.

The runtime remains separate from xMatrix's production mechanisms. No schedule,
approval, request or PR subscription has been migrated by this prototype.

## Try a simulated request

From the repository root, with Node 24 and `npm ci` already run:

```sh
node --input-type=module <<'JS'
import { parse } from './src/frontend/parser.ts';
import { compile } from './src/runtime/code.ts';
import { VirtualClock } from './src/runtime/clock.ts';
import { SqliteStore } from './src/runtime/sqlite-store.ts';
import { Runtime } from './src/runtime/runtime.ts';
import { SimulatedHost } from './src/runtime/simulated-host.ts';
import { text, variant } from './src/runtime/value.ts';

const parsed = parse('ask(@alice, "Ship?", ~until=1h)');
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const clock = new VirtualClock();
const store = new SqliteStore(':memory:', clock);
try {
  const host = new SimulatedHost(store, clock);
  const runtime = new Runtime(compile(parsed.program), store, host);
  await runtime.create('demo');
  await host.pump(runtime);
  const offer = (await store.effects('demo')).find(e => e.operation === 'request.offer');
  const request = await store.request(offer.arguments.requestId);
  await host.reply(request, variant('Done', text('yes')));
  await host.pump(runtime);
  console.log((await store.load('demo')).status); // completed
} finally {
  await store.close();
}
JS
```

To exercise expiry instead of a reply, replace the reply with `await
host.advanceTo(3_600_000)`, then pump. This returns `TimedOut` and withdraws the
convenience request. The four source examples and restart/crash checks run with
`npm test`.
