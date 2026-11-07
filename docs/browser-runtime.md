# Browser runtime

Import the evaluator through `src/runtime/browser.ts`. It exports `MemoryStore`,
`Runtime`, `SimulatedHost`, `VirtualClock`, `compile`, `compileAstJson`, the
portable types, and value constructors. Its dependency graph has no Node
modules or globals. The SQLite adapter remains a separate Node entry.

The host supplies the program and standard-library ASTs already used by its
checker. Parsing, type checking and execution are separate steps: `compile`
pins and links code; it does not replace type checking or host authorization.
The browser application bundles or fetches `std/std.norn`, then parses it. The
runtime never reads a file or fetches a dependency on its own.

```ts
import {parse} from '../src/frontend/parser.ts';
import {compile, MemoryStore, Runtime, VirtualClock, SimulatedHost, text, variant}
  from '../src/runtime/browser.ts';

// stdSource is the same library source supplied to the checker.
const std = parse(stdSource);
const program = parse('open Std\nremind(@alice, "Review", ~at=1h)');
if (!std.ok || !program.ok) throw new Error('Parse diagnostics need attention');

const clock = new VirtualClock();
const store = new MemoryStore(clock);
const host = new SimulatedHost(store, clock);
let runtime = new Runtime(compile(program.program, {std: std.program}), store, host);
await runtime.create('demo');
await host.pump(runtime);
await host.advanceTo(3_600_000);
await host.pump(runtime);

const offer = (await store.effects('demo')).find(e => e.operation === 'request.offer');
if (offer) {
  const request = await store.request((offer.arguments as {requestId: string}).requestId);
  if (request) await host.reply(request, variant('Done', text('Reviewed')));
}
runtime = await Runtime.restore('demo', store, host);
await host.pump(runtime);
await store.close();
```

`MemoryStore` implements the same asynchronous `DurableStore` contract as
SQLite, including checkpoint compare-and-swap, atomic intents, request epochs,
independent waits, deadlines, event cursors and lease recovery. It validates
JSON and copies inputs and results: mutating a returned object cannot alter a
stored checkpoint. Transactions are synchronous and roll back as a unit.
There are no background jobs; the application drives the clock and scheduler.

Memory is **session-local**. `Runtime.restore` can replace an evaluator while
the same store remains alive. Closing the store, refreshing or closing the
page loses all state. It is not durable storage for production work or a
substitute for IndexedDB or PostgreSQL. Each playground session should own its
store and close it when discarded. Native SQLite disk/crash guarantees remain
specific to that adapter.

## Pinned standard library

`compile(program, {std})` links `open Std` to the supplied AST. Library binding
declarations initialize once in a private lexical scope before the main
program. Each `open` brings their exports into the caller's scope; later caller
bindings can shadow them without changing the library's own bindings. Only
type and binding declarations are accepted in Std.

The linked definition is ordinary versioned AST data. It includes the library
definitions and exports, so restoring a checkpoint needs neither the current
library nor a file loader. Changing a library definition changes the code
identity. The source program's trailing `open` does not replace its final
expression value. An unresolved import in a saved artifact is rejected visibly;
older experimental artifacts with such imports need recompiling with their
original library, not loading today's version silently.

Programs without `open Std` retain their original AST bytes and code identities.
SHA-256 is implemented over UTF-8 using standard JavaScript primitives; known
answers, block boundaries and Unicode inputs are compared with Node's crypto
implementation in tests. This does not change the machine ABI or SQLite schema.

## Checks

CI type-checks this entry without Node types using `tsconfig.browser.json`.
An isolated ESM test refuses every non-relative import and supplies no
`process`, `Buffer` or `require`. It loads the browser entry, runs Std's reminder,
advances time, answers and restores the execution. Shared backend contract
tests exercise MemoryStore and SQLite with the same scenarios. These establish
runtime portability; actual playground interactions and deployment are verified
by the application that embeds it.
