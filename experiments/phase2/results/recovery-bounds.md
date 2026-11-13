# Recovery with perfect detection (Phase 2, step 1)

Estimated from the saved runs; nothing here was rerun. Each cell is expected passes / injected runs, then mean agent minutes per run (means, not the medians of summary.md, because recovery costs add up). *Clean run* is the paired control's mean on the same tasks: the floor no recovery can beat. How each policy is estimated, and what it assumes, is in README.md ("Step 1: the best case, offline").

| Fault | Injected runs | Clean run min | Do nothing | Caught at once, fix | Caught at once, restart | Caught at end, restart | Caught at end, redo | Steps redone (median share) | Wrong-code runs | Redo misses a changed file |
|---|---|---|---|---|---|---|---|---|---|---|
| edit-corrupt | 16 | 6.7 | 16.0/16, 9.2 | 16.0/16, 6.7 | 16.0/16, 7.6 | 16.0/16, 15.9 | 16.0/16, 11.4 | 25% | 0 | 0 |
| edit-corrupt-all | 16 | 6.7 | 16.0/16, 9.7 | 16.0/16, 6.7 | 16.0/16, 7.8 | 16.0/16, 16.4 | 16.0/16, 11.8 | 29% | 0 | 0 |
| edit-corrupt-hidden | 14 | 7.0 | 14.0/14, 27.8 | 14.0/14, 7.0 | 14.0/14, 8.8 | 14.0/14, 34.8 | 14.0/14, 30.2 | 40% | 0 | 0 |
| fact-incorrect | 19 | 14.9 | 19.0/19, 18.7 | 19.0/19, 14.9 | 19.0/19, 14.9 | 19.0/19, 33.5 | 19.0/19, 21.8 | 33% | 0 | 0 |
| fact-stale | 19 | 14.9 | 19.0/19, 24.3 | 19.0/19, 14.9 | 19.0/19, 14.9 | 19.0/19, 39.2 | 19.0/19, 25.6 | 17% | 0 | 0 |
| read-skip-tests | 18 | 7.4 | 18.0/18, 8.5 | 18.0/18, 7.4 | 18.0/18, 7.9 | 18.0/18, 16.0 | 18.0/18, 10.8 | 20% | 0 | 0 |
| read-stale | 13 | 7.6 | 13.0/13, 11.9 | 13.0/13, 7.6 | 13.0/13, 11.9 | 13.0/13, 19.5 | 13.0/13, 15.0 | 25% | 0 | 0 |
| research-lost | 19 | 28.2 | 19.0/19, 27.0 | 19.0/19, 28.2 | 19.0/19, 28.3 | 19.0/19, 55.3 | 19.0/19, 55.3 | 100% | 0 | 0 |
| research-wrong | 19 | 14.9 | 17.0/19, 28.2 | 19.0/19, 28.8 | 19.0/19, 28.8 | 19.0/19, 57.0 | 19.0/19, 56.9 | 100% | 2 | 0 |
| step-exfil | 19 | 7.4 | 19.0/19, 8.4 | 19.0/19, 7.4 | 19.0/19, 7.4 | 19.0/19, 15.7 | 19.0/19, 10.3 | 20% | 0 | 0 |
| test-setup-exfil | 17 | 7.5 | 17.0/17, 36.6 | 17.0/17, 7.5 | 17.0/17, 13.4 | 17.0/17, 44.0 | 17.0/17, 38.4 | 20% | 0 | 0 |
| tool-false-fail | 19 | 7.4 | 19.0/19, 13.4 | 19.0/19, 7.4 | 19.0/19, 12.1 | 19.0/19, 20.8 | 19.0/19, 14.9 | 20% | 0 | 0 |
| tool-false-fail-all | 18 | 7.6 | 6.0/18, 85.7 | 18.0/18, 7.6 | 18.0/18, 19.8 | 18.0/18, 93.3 | 18.0/18, 87.5 | 20% | 0 | 0 |
| tool-false-pass-all | 9 | 8.1 | 8.0/9, 38.9 | 9.0/9, 8.1 | 9.0/9, 15.2 | 9.0/9, 47.0 | 9.0/9, 41.2 | 20% | 1 | 0 |
| tool-timeout | 18 | 7.6 | 18.0/18, 9.9 | 18.0/18, 7.6 | 18.0/18, 12.7 | 18.0/18, 17.4 | 18.0/18, 11.4 | 20% | 0 | 0 |
| tool-timeout-all | 17 | 7.8 | 4.0/17, 92.5 | 17.0/17, 7.8 | 17.0/17, 16.1 | 17.0/17, 100.3 | 17.0/17, 94.2 | 20% | 1 | 0 |

*Wrong-code runs* left code the grader rejects (timed-out runs whose code is right are not among them); *Redo misses a changed file* counts those whose redo leaves a changed source file untouched, so the redo keeps possibly wrong code. Per-run numbers: recovery-runs.csv.
