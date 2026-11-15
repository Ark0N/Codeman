---
'aicodeman': patch
---

The header CPU reading shows CPU use: busy time across all cores since the previous reading, from `os.cpus()`. It used to show the 1-minute load average divided by the core count, capped at 100, which counts runnable tasks rather than busy time. A host with bursty short-lived processes, or with a VM whose vCPU threads count as runnable, read 100% while most of its cores were idle. Readings under a second apart reuse the last value, so several open browsers share one window. The load-average figure remains only as a fallback for a platform that reports no core times.
