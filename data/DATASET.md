Dataset: DailyBuild build index — 215 rows, one per working day from 2024-09-02.
Columns: date, weekday, title, stack, tools, build_seconds, tests_run, tests_failed, lines_changed, cache_warm.
Two real signals: (1) step change 2025-01-15 — remote build cache enabled, every stack got faster;
(2) Swift App builds are 2-4x slower than everything else throughout.
