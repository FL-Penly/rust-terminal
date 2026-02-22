# Web Terminal Performance Benchmarks

## Usage

Start the server first:
```bash
./run.sh
```

Then run all benchmarks:
```bash
bash benchmarks/run-all.sh
```

Or run individual benchmarks:
```bash
node benchmarks/throughput.js   # MB/s throughput
node benchmarks/latency.js      # Keystroke-to-echo latency (p50/p95/p99)
node benchmarks/memory.js       # Server RSS under sustained output
```

## Saving Results

For before/after comparison:
```bash
# Before optimizations (baseline):
bash benchmarks/run-all.sh > benchmarks/results/baseline.txt

# After optimizations:
bash benchmarks/run-all.sh > benchmarks/results/optimized.txt
```

## Metrics

| Test | Metric | What It Measures |
|------|--------|-----------------|
| throughput | throughput_mbs | MB/s for `seq 1 500000` (~3.4MB output) |
| latency | p50/p95/p99_ms | Keystroke → echo round-trip time (50 samples) |
| memory | peak_rss_mb | Server RSS peak during 5MB sustained output |

## Requirements

- Node.js 16+ (uses the globally available `ws` package)
- Server running on localhost:7682
- `pgrep`, `ps` commands available (for memory test)
