# Test-runner watchdog replayed on the saved runs

Each saved run's tool calls go through the test-runner plug-in's detector (`PiMAS/src/watchdog/test-runner.ts`). Probe answers are simulated (see `replay-watchdog.mts`), and replay stops at the first confirmation. *Probes* counts probes before the first confirmation (every probe, on a run that is never confirmed); on runs without the fault each one is a false alarm that costs one short test run. *After catch* is the run's remaining agent minutes when the fault was confirmed: the most a repair could save. Fault rows count only runs where the fault fired.

| Condition | Runs | Caught | Probes per run | Minutes from fault to catch (median) | After catch (median) | Run minutes (median) |
|---|---|---|---|---|---|---|
| control-full | 19 | 0/19 | 5.6 | – | – | 26.9 |
| control-r | 19 | 0/19 | 3.5 | – | – | 9.9 |
| control-rp | 19 | 0/19 | 3.8 | – | – | 6.2 |
| edit-corrupt | 16 | 0/16 | 4.0 | – | – | 7.3 |
| edit-corrupt-all | 16 | 0/16 | 3.6 | – | – | 7.5 |
| fact-incorrect | 19 | 0/19 | 3.1 | – | – | 14.2 |
| fact-stale | 19 | 0/19 | 3.7 | – | – | 17.3 |
| read-skip-tests | 18 | 0/18 | 3.6 | – | – | 6.9 |
| read-stale | 13 | 0/13 | 4.5 | – | – | 7.7 |
| research-lost | 19 | 0/19 | 5.5 | – | – | 23.4 |
| research-wrong | 19 | 0/19 | 4.1 | – | – | 23.8 |
| step-exfil | 19 | 0/19 | 3.2 | – | – | 6.4 |
| test-setup-exfil | 18 | 18/18 | 1.5 | 0.0 | 30.5 | 31.7 |
| tool-false-fail | 19 | 11/19 | 2.7 | -5.1 | 13.1 | 14.1 |
| tool-false-fail-all | 18 | 18/18 | 1.6 | -1.1 | 93.9 | 100.0 |
| tool-timeout | 18 | 8/18 | 3.3 | -4.8 | 8.4 | 7.5 |
| tool-timeout-all | 18 | 18/18 | 1.6 | -0.5 | 95.0 | 100.0 |
| tool-false-pass-all | 10 | 10/10 | 2.6 | -0.2 | 28.3 | 35.8 |
| edit-corrupt-hidden | 14 | 0/14 | 4.1 | – | – | 23.3 |
