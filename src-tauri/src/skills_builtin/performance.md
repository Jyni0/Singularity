---
name: performance
description: "Find and fix performance problems (slow pages, endpoints, queries, builds, high memory) based on measurements, not guesses."
---
# Steps
1. Define the problem as a number: which operation, how slow, under what load/data size, and the target.
2. Measure first: profiler (Chrome Performance, Node --prof / clinic, py-spy / cProfile, cargo flamegraph, dotnet-trace), query plans (EXPLAIN ANALYZE), bundle analyzers, timing logs.
3. Find the biggest cost and fix that first. Typical culprits:
   - N+1 queries, missing indexes, fetching unused columns/rows;
   - work repeated in loops, O(n²) where a map/set gives O(n);
   - blocking I/O on the main thread / event loop; sequential awaits that could run in parallel;
   - React: unnecessary re-renders, huge lists without virtualization, heavy work in render;
   - large bundles: unused dependencies, missing code splitting, unoptimized images.
4. Measure again with the same method. Keep a change only if it helps measurably.
5. Report before/after numbers and any trade-offs (memory, complexity, cache invalidation).
