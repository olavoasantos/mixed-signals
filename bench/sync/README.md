# Sync RPC Microbenchmarks

Microbenchmark suite for the sync RPC sub-bundle, powered by vitest's
native `bench()` mode (tinybench under the hood).

## Quick start

```bash
# Run all benchmarks
pnpm bench

# Save current numbers as a local baseline
pnpm bench:baseline

# Compare current run against the saved baseline
pnpm bench:check
```

## Scenarios

| Scenario | What it measures | Design target |
|---|---|---|
| `rpc_wait_single_primitive` | Single bool return via fast path | 3-5 µs |
| `rpc_wait_3_primitives` | N-arity batch (3 primitives) | ~1.1 µs/call |
| `handle_return` | Pre-registered handle return | 4-6 µs |
| `new_handle_return` | First-emission object return | 15-20 µs |
| `1kb_string_arg` | 1 KB string echo (single-chunk JSON) | ~5-10 µs |
| `64kb_string_arg` | 64 KB string echo (near SAB boundary) | ~40-60 µs |
| `sync_abort_timeout_recover` | Timeout throw + state cleanup | low |
| `with_1_captured_signal_delta` | 1 signal mutation during dispatch | 10-15 µs |
| `with_10_captured_signal_deltas` | 10 signal mutations (linear scaling) | ~100-150 µs |
| `cross_origin_postmessage_rtt` | Cross-origin postMessage RTT (Playwright) | ~100-200 µs |
| `async_baseline_clean` | Async round-trip (no contention) | ~110-220 µs |
| `contested_async_baseline` | Async under event-loop saturation | ~2-10 ms |
| `worker_teardown_cleanup` | terminate() → onClientDead callback | tens of ms |
| `prelude_flush_zero_entries` | Sync call with no pending notifications | ~3-5 µs |
| `prelude_flush_with_entries` | Sync call flushing 5 pending @W entries | marginal per entry |

## How it works

Each benchmark uses `MixedSignalsNodeHarness` (the same test harness
used by the test suite) with `sync: true` for the sync scenarios, and
without sync for the async baseline. The full production sync-RPC
stack runs through a real Node `worker_threads` Worker.

### Measurement methodology

For µs-class scenarios (primitives, payloads, reactivity, prelude),
the measurement loop runs **inside the worker** via a single
`evaluate()` call that executes N iterations. This amortizes the
~30-80 µs `evaluate()` IPC overhead across N iterations so the
outer wall-clock (which is what vitest/tinybench reports) is
dominated by the actual sync-RPC work. The numbers vitest shows
are useful for **regression detection** (relative changes between
runs) even though the absolute values include fixed evaluate
overhead per sample.

For ms-class scenarios (teardown, contested async), the overhead is
negligible relative to the measured cost.

Exceptions:
- **Teardown** spawns a fresh worker per iteration (terminate is
  one-shot). The measurement window is `terminate() → onClientDead`,
  excluding spawn and handshake.
- **Cross-origin** uses Playwright with an in-browser measurement
  loop. Measures postMessage RTT only — the full broker topology
  bench is deferred until the browser harness supports sync.

### Baseline workflow

1. Run `pnpm bench:baseline` to save current numbers to
   `bench/sync/baseline.json` (vitest's native JSON format).
2. Make your changes.
3. Run `pnpm bench:check` — vitest's `--compare` flag shows a
   side-by-side diff table with percentage changes per scenario.

The baseline file is gitignored — it's machine-specific and not
reproducible across environments. The performance contract lives
in the design document (§10); the bench suite validates those
targets, it doesn't persist specific numbers.

### Cross-origin bench

The `cross_origin_postmessage_rtt` scenario requires Playwright
browsers (`npx playwright install chromium`). It is skipped if
Playwright is not installed or browsers aren't available. This
bench measures the cross-origin postMessage round-trip — the
dominant variable cost in the §6.2 broker topology. The full
broker bench (worker + SAB + broker bridge + parent dispatch) is
deferred until `MixedSignalsBrowserHarness` supports sync.

### Recommended setup

For stable numbers:
- Close other CPU-intensive apps
- Plug in your laptop (thermal throttling affects results)
- Run on a quiet machine (no heavy background processes)
- Run multiple times to confirm consistency

## Architecture

```
bench/sync/
├── primitives.bench.ts    # Single primitive, N-arity, handle, new handle
├── payloads.bench.ts      # 1 KB, 64 KB string payloads
├── timeout.bench.ts       # Timeout throw + state recovery
├── reactivity.bench.ts    # 1 and 10 captured signal deltas
├── async-baseline.bench.ts # Clean and contested async baselines
├── teardown.bench.ts      # Worker terminate → death detection callback
├── prelude.bench.ts       # Prelude flush with/without pending entries
├── cross-origin.bench.ts  # Playwright cross-origin postMessage RTT
├── baseline.json          # Local-only baseline (gitignored)
└── README.md              # This file
```
