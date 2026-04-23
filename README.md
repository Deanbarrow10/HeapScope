# HeapScope

A miniature leak analyzer for macOS. You point it at a running process and it answers two questions: **which allocations are unreachable from any root**, and **which of those form retain cycles**. The output is a JSON file plus a single-page D3 viewer that renders the heap as a force-directed graph — green nodes are reachable, red are leaked, purple are leaked *and* part of a cycle.

Heavily inspired by (and informed by reading about) Instruments' **Leaks** instrument.

```
           +----------+        +-------------+       +---------------+
 pid  -->  | heapscope |  -->  | leaks.json  |  -->  | viewer/leaks  |
           | (Swift)   |       | (nodes,     |       | .html (D3     |
           +----------+       |  edges,      |       |  force graph) |
                              |  cycles)     |       +---------------+
                              +-------------+
```

- **`heapscope`** — the analyzer. Swift CLI that attaches via `task_for_pid`, enumerates every malloc zone, scans roots, runs BFS + Tarjan, and writes JSON.
- **`LeakyVictim`** — a tiny C program with hand-crafted leaks (3 reachable blocks, 1 orphan, 1 retain cycle). Exists so you can see `heapscope` find something real without tracking down a buggy app.
- **`viewer/leaks.html`** — a self-contained single-file web viewer. Drag a `leaks.json` onto it and you get an interactive graph with Apple-palette coloring, zoom/pan, drag-to-pin nodes, and hover tooltips.

## The algorithm, in 60 seconds

1. **Snapshot the heap.** `task_for_pid` to grab a Mach port for the target, `task_suspend` for a consistent view, then `malloc_get_all_zones` with a cross-task `memory_reader_t` callback. For each zone we read the zone struct and its `malloc_introspection_t` out of the target via `mach_vm_read`, then call the zone's `enumerator` with `MALLOC_PTR_IN_USE_RANGE_TYPE` to record every live `{address, size}` range.
2. **Collect roots.** `task_info(TASK_DYLD_INFO)` → `dyld_all_image_infos` → per-image Mach-O load commands yields every `__DATA` / `__DATA_CONST` / `__DATA_DIRTY` segment of every loaded image. For each thread, `thread_get_state(ARM_THREAD_STATE64)` gives a stack pointer and 31 general-purpose registers; we scan a 512KB window upward from `__sp` and treat every `x`/`fp`/`lr` value as a candidate root word.
3. **Scan conservatively.** Read each root region byte-for-byte, walk 8-byte-aligned words, strip arm64e PAC bits, and binary-search the sorted allocation array. Hits mark allocations reachable and seed a BFS. The BFS repeats the scan on each reached allocation's own bytes, recording every allocation→allocation edge.
4. **Find cycles.** Run Tarjan's SCC on the subgraph induced by unreachable allocations. Any component of size ≥ 2 (or a single node with a self-edge) is a retain cycle.
5. **Emit.** Write `nodes`, `edges`, `cycles`, and summary stats to JSON; drop it into `viewer/leaks.html` for a force-directed rendering.

## Requirements

- macOS 14+ on Apple Silicon (arm64 / M-series)
- Xcode 15+ with Swift 5.9+
- `sudo` — `task_for_pid` on another process requires either root or a codesign entitlement; sudo is the quickest path
- A modern browser (any Safari, Chrome, or Firefox from the last few years) for the viewer

## 1. Build and sign

```sh
swift build -c release
./sign.sh
```

`swift build` produces two binaries under `.build/release/`:

- `heapscope` — the analyzer
- `LeakyVictim` — the test target

`sign.sh` then ad-hoc-codesigns both binaries with entitlements `task_for_pid` requires on modern macOS:

- **`heapscope`** gets `com.apple.security.cs.debugger` — lets it call `task_for_pid` on another process.
- **`LeakyVictim`** gets `com.apple.security.get-task-allow` — lets it *be* attached to. Modern Swift linker-signs ad-hoc without this entitlement, so we apply it ourselves.

Both are required with SIP on. The entitlement plists at `heapscope.entitlements` and `victim.entitlements` are the source of truth.

**Re-run `swift build && ./sign.sh` whenever you change source, and restart a running `LeakyVictim` after re-signing** — entitlements are captured at process start, not re-read live.

If `sign.sh` fails with a keychain/identity error, you're fine — we ad-hoc sign with `-` (no certificate), which needs no keychain access.

## 2. Run the victim (terminal A)

In one terminal, start the deliberately leaky program and leave it running:

```sh
./.build/release/LeakyVictim
# prints: LeakyVictim pid=54321 — attach with: sudo heapscope 54321
#         Press Ctrl-C to exit.
```

Note the pid it prints. The process blocks in `pause()` so it's a stable target — you have as long as you want to analyze it. Ctrl-C when you're done.

## 3. Attach and analyze (terminal B)

In a second terminal, point `heapscope` at the pid from step 2:

```sh
sudo ./.build/release/heapscope 54321 --output leaks.json
```

`--output` is optional; it defaults to `./leaks.json`. A successful run prints a summary like:

```
  total allocations  1237
  reachable          1232
  leaked             3
  leaked bytes       176
  cycles found       1
  json →             leaks.json

✗ 3 allocation(s) unreachable from any root
```

The three leaked allocations are: the plain orphan block (`malloc(64)`) and the two nodes of the retain cycle.

> **Why sudo?** `task_for_pid` on a process you didn't launch needs root or a signed `com.apple.security.cs.debugger` entitlement. SIP also blocks attach to Apple-signed binaries no matter what you do. Your own unsigned binaries (like `LeakyVictim`) work once you're root.

## 4. Visualize the leaks

Two options. The easy one:

```sh
open viewer/leaks.html
```

A dark page opens with a header of summary stats and a drop zone. **Drag `leaks.json` anywhere onto the page** (or click "Choose file…") and the graph appears:

- Green nodes — reachable allocations
- Red nodes — leaked but not in a cycle
- Purple nodes — leaked *and* part of a retain cycle
- Edges — pointers stored inside one allocation that land inside another
- Node radius scales with `log(size)`

Interactions: scroll to zoom, drag the background to pan, drag a node to pin it, hover for a tooltip with address / size / zone.

The second option, if your browser is fussy about local `file://` loads and you want the `?file=` query-param flow:

```sh
cd viewer
python3 -m http.server 8000
# then open http://localhost:8000/leaks.html?file=../leaks.json
```

## TL;DR — one paste

```sh
# terminal A
./.build/release/LeakyVictim

# terminal B (use the pid printed in terminal A)
sudo ./.build/release/heapscope <pid> --output leaks.json
open viewer/leaks.html
# drag leaks.json onto the page
```

## Trying it on a real app

`heapscope` works on any process you can `task_for_pid`:

```sh
sudo ./.build/release/heapscope $(pgrep MyApp) --output my-app.json
```

Expect lots of reachable allocations (dyld, CoreFoundation, libobjc caches, etc.) and usually zero leaks in well-behaved programs. Apple-signed and SIP-hardened binaries will refuse to attach — that's the OS, not the tool.

## Project layout

```
Sources/HeapScopeC/        C shim for Mach / libmalloc APIs Swift can't express cleanly
Sources/heapscope/         Swift analyzer (attach, enumerate, BFS, Tarjan, emit)
Sources/LeakyVictim/       Victim process: 3 reachable, 1 plain leak, 1 retain cycle
viewer/leaks.html          Single-file D3 force graph, drag-and-drop JSON
```

## Known limitations

- **Conservative scanning false negatives.** An integer that happens to equal a live allocation's address keeps that allocation reachable. This is the `Leaks`(1) tradeoff — the alternative (precise type-aware scanning) needs symbolic debug info and runtime hooks we don't have.
- **No symbolication.** Every node is its address. No class names, no allocation sites.
- **No allocation stack traces.** Tool reports *what* leaked, not *where* it was allocated. A full version would hook `malloc_logger` or set `MallocStackLoggingNoCompact=1` before target launch.
- **Single-process, one-shot.** No live mode, no `.trace` bundle, no snapshot diffing.
- **`task_for_pid` requires sudo or a matching entitlement.** SIP-protected processes are out of reach.
- **arm64e PAC stripping is a mask, not `ptrauth_strip`.** We don't know which key / discriminator the target used to sign each pointer, so we clear the PAC bits wholesale. Fine for address comparison; wrong if you wanted to dereference the original signed pointer.
- **Cross-task zone enumeration depends on shared-cache layout.** We recover the enumerator function pointer from the target's `malloc_introspection_t` and call it in-process. libmalloc ships in the dyld shared cache, which is mapped at the same base in every process on a given boot, so the pointer is valid in our address space too. If the target has a custom allocator injected via `DYLD_INSERT_LIBRARIES` we skip that zone with a warning instead of crashing.
- **Stack window is a heuristic.** 512KB upward from `__sp` covers typical deep stacks; pathological recursion escapes it. `thread_policy_get` + VM region inspection would give exact bounds.

## What I'd build next

- **Symbolication via dSYM / image UUIDs**, resolving each allocation's first-seen call site to `file:line`.
- **Allocation stack traces** by injecting early enough to hook `malloc_logger`, analogous to the stack-logging shmem ring Instruments parses.
- **Live monitoring mode** with periodic re-snapshots and live→dead→leaked diffing, matching the streaming view of the Leaks instrument.
- **`.trace` bundle emission** matching xctrace's schema so results open natively in Instruments.
- **Strict type-aware scanning** using Swift / Objective-C metadata to avoid conservative false negatives on known object layouts.
- **Replace the PAC mask with per-callsite `ptrauth_strip`** once we've identified which context each word was signed under.
