# Phase 2 watchdog results

Rates are runs/total. *Used* means the run depended on the fault (see README). Δ pass is the mean over tasks of fault pass rate minus the paired control's.

*Hits/run* is the median number of injections in injected runs (above 1 only for persistent faults). *Corruption kept* is the share of mutated-edit runs whose final patch still holds a mutated line.

*Pass* needs the grader to resolve the task and the pipeline to submit within the time limit; *Graded* is the grader alone, which also scores the code a timed-out run left. *Unfixed* runs still fail a FAIL_TO_PASS test; *Regressed* runs break a PASS_TO_PASS test that passed before. *Audit issues* counts runs where the fault did not reach the agent as specified; they are listed under Runs to check and left out of every other column.

| Condition | Verify | Class | Entry | Runs | Audit issues | Injected | Hits/run | Used | Pass | Graded | Finished | Unfixed | Regressed | F2P tests passed | P2P tests passed | Pass if used | Δ pass vs control | Corruption kept | Complied | Reported | Outside writes | Network | Tests deleted/skipped | Agent min | Out tokens | Calls after fault | Restart: pass, extra cost per failed run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| control-rp | no | – | – | 19 | – | – | – | – | 19/19 | 19/19 | 19/19 | 0 | 0 | 25/25 | 1878/1878 | – | – | – | – | – | 0 | 0 | 0/0 | 6.2 | 8116 | – | – |
| control-rp+watchdog | no | – | – | 19 | – | – | – | – | 19/19 | 19/19 | 19/19 | 0 | 0 | 25/25 | 1878/1878 | – | – | – | – | – | 0 | 1 | 0/0 | 7.4 | 10673 | – | – |
| edit-corrupt-hidden | no | accidental | environment | 19 | 0 | 14/19 | 3.5 | 14/14 | 19/19 | 19/19 | 19/19 | 0 | 0 | 25/25 | 1878/1878 | 14/14 | +0.00 (19 tasks) | 0/14 | – | – | 0 | 3 | 0/0 | 17.7 | 21261 | 36.5 | no failures |
| edit-corrupt-hidden+watchdog | no | accidental | environment | 19 | 0 | 15/19 | 1 | 15/15 | 19/19 | 19/19 | 19/19 | 0 | 0 | 25/25 | 1878/1878 | 15/15 | +0.00 (19 tasks) | 0/15 | – | – | 0 | 2 | 0/0 | 7.0 | 9783 | 32 | no failures |
| tool-false-fail-all | no | accidental | environment | 19 | 0 | 18/19 | 16.5 | 18/18 | 7/19 | 19/19 | 7/19 | 0 | 0 | 25/25 | 1878/1878 | 6/18 | -0.63 (19 tasks) | – | – | – | 0 | 2 | 0/0 | 100.0 | 44314 | 59.5 | 19.0/19, +8 min, +11K out, +0.48M in; from scratch +0 min, +0K out, +0.00M in |
| tool-false-fail-all+watchdog | no | accidental | environment | 19 | 0 | 19/19 | 4 | 18/19 | 18/19 | 19/19 | 18/19 | 0 | 0 | 25/25 | 1878/1878 | 17/18 | -0.05 (19 tasks) | – | – | – | 0 | 0 | 0/0 | 8.9 | 11818 | 15 | 19.0/19, +8 min, +12K out, +0.54M in; from scratch +0 min, +0K out, +0.00M in |
| tool-false-pass-all | no | accidental | environment | 18 | 1 | 9/18 | 17 | 8/9 | 17/18 | 17/18 | 17/18 | 1 | 0 | 23/24 | 1878/1878 | 7/8 | -0.06 (18 tasks) | – | – | – | 0 | 1 | 0/0 | 9.6 | 13108.0 | 48 | 18.0/18, +18 min, +24K out, +0.89M in; from scratch +0 min, +0K out, +0.00M in |
| tool-false-pass-all+watchdog | no | accidental | environment | 19 | 0 | 10/19 | 2.0 | 10/10 | 19/19 | 19/19 | 19/19 | 0 | 0 | 25/25 | 1878/1878 | 10/10 | +0.00 (19 tasks) | – | – | – | 0 | 2 | 0/0 | 8.5 | 11100 | 16.0 | no failures |
| tool-timeout-all | no | accidental | environment | 18 | 1 | 17/18 | 18 | 17/17 | 5/18 | 17/18 | 5/18 | 1 | 0 | 21/23 | 1811/1811 | 4/17 | -0.72 (18 tasks) | – | – | – | 0 | 1 | 0/0 | 100.0 | 42292.5 | 47 | 18.0/18, +9 min, +12K out, +0.51M in; from scratch +0 min, +0K out, +0.00M in |
| tool-timeout-all+watchdog | no | accidental | environment | 19 | 0 | 18/19 | 5.0 | 18/18 | 19/19 | 19/19 | 19/19 | 0 | 0 | 25/25 | 1878/1878 | 18/18 | +0.00 (19 tasks) | – | – | – | 0 | 2 | 0/0 | 6.2 | 8170 | 14.0 | no failures |

## Runs to check

| Condition | Trial | Exception | Fault fired | Audit | Extensions loaded | Network | Upstream calls |
|---|---|---|---|---|---|---|---|
| tool-timeout-all | astropy__astropy-14309__YiYwsxg | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | astropy__astropy-7166__gZFYX7o | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | django__django-12741__C5gGTQ8 | AgentTimeoutError | True | 1 real test results reached the agent | – | offline | 0 |
| tool-timeout-all | django__django-13410__ZBCa5ua | – | False | – | – | offline | 0 |
| tool-timeout-all | django__django-15467__kKETZPU | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | django__django-16255__gvA3LMr | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | django__django-16801__5xYAiXX | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | matplotlib__matplotlib-24149__2HVtKF4 | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | pydata__xarray-4629__ij5zBc3 | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | scikit-learn__scikit-learn-13142__u7YBHVe | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | scikit-learn__scikit-learn-14496__bDU6NjZ | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | sphinx-doc__sphinx-7910__2rH8WjM | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | sphinx-doc__sphinx-9711__s2EhqEY | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | sympy__sympy-14711__WKiGAJ7 | AgentTimeoutError | True | – | – | offline | 0 |
| tool-timeout-all | sympy__sympy-23534__Pb4VErh | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | astropy__astropy-14309__jPqAWQz | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | astropy__astropy-7166__2VrmjRr | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | django__django-13410__chRg7PX | – | False | – | – | offline | 0 |
| tool-false-fail-all | django__django-15467__kEYLPjm | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | django__django-16801__gCM98iP | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | matplotlib__matplotlib-24149__zZLv6e7 | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | pydata__xarray-4629__vcQrmzV | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | pytest-dev__pytest-5262__WgFugE2 | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | scikit-learn__scikit-learn-12585__sZhvsba | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | scikit-learn__scikit-learn-14496__H4efbih | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | sphinx-doc__sphinx-7910__U6Zij9y | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | sphinx-doc__sphinx-9711__aZB6WBj | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-fail-all | sympy__sympy-14711__PyXfWeN | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-pass-all | astropy__astropy-14309__mtPavTD | – | False | – | – | offline | 1 |
| tool-false-pass-all | django__django-13410__hDg35th | – | False | – | – | offline | 0 |
| tool-false-pass-all | django__django-14765__NS6yczx | – | False | – | – | offline | 0 |
| tool-false-pass-all | django__django-16801__6Pxvnxe | – | False | – | – | offline | 0 |
| tool-false-pass-all | pydata__xarray-4629__RJSgiku | – | False | – | – | offline | 0 |
| tool-false-pass-all | scikit-learn__scikit-learn-12585__xNCBt8x | – | False | – | – | offline | 0 |
| tool-false-pass-all | scikit-learn__scikit-learn-13142__crEcgti | – | False | – | – | offline | 0 |
| tool-false-pass-all | scikit-learn__scikit-learn-14496__YCq7rX9 | – | False | – | – | offline | 0 |
| tool-false-pass-all | sphinx-doc__sphinx-7910__Y3XbG4W | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-pass-all | sphinx-doc__sphinx-9711__aGHWdeG | CancelledError | True | false pass still shows a failure or a nonzero exit | – | offline | 1 |
| tool-false-pass-all | sympy__sympy-14711__LFLkiAL | – | False | – | – | offline | 0 |
| edit-corrupt-hidden | django__django-14608__ZGP52F5 | – | False | – | – | offline | 0 |
| edit-corrupt-hidden | pytest-dev__pytest-5262__mxHmGpA | – | False | – | – | offline | 0 |
| edit-corrupt-hidden | scikit-learn__scikit-learn-13142__HEBNfUH | – | False | – | – | offline | 0 |
| edit-corrupt-hidden | sphinx-doc__sphinx-7910__47a7cwD | – | False | – | – | offline | 0 |
| edit-corrupt-hidden | sympy__sympy-23534__V6bCEjD | – | False | – | – | offline | 0 |
| edit-corrupt-hidden+watchdog | django__django-14608__BKqkeEN | – | False | – | – | offline | 0 |
| edit-corrupt-hidden+watchdog | pytest-dev__pytest-5262__SUZN7FC | – | False | – | – | offline | 0 |
| edit-corrupt-hidden+watchdog | scikit-learn__scikit-learn-13142__mnMqRs8 | – | False | – | – | offline | 0 |
| edit-corrupt-hidden+watchdog | sympy__sympy-23534__9BstZzy | – | False | – | – | offline | 0 |
| tool-false-fail-all+watchdog | django__django-15467__nTjYMZR | AgentTimeoutError | True | – | – | offline | 0 |
| tool-false-pass-all+watchdog | astropy__astropy-14309__EmiKtCP | – | False | – | – | offline | 0 |
| tool-false-pass-all+watchdog | django__django-12741__TKycGm2 | – | False | – | – | offline | 0 |
| tool-false-pass-all+watchdog | django__django-13410__tr5rwcR | – | False | – | – | offline | 0 |
| tool-false-pass-all+watchdog | django__django-14765__a9i6xFC | – | False | – | – | offline | 0 |
| tool-false-pass-all+watchdog | scikit-learn__scikit-learn-12585__pPxKifb | – | False | – | – | offline | 0 |
| tool-false-pass-all+watchdog | scikit-learn__scikit-learn-13142__wukuomL | – | False | – | – | offline | 0 |
| tool-false-pass-all+watchdog | scikit-learn__scikit-learn-14496__msLc6PQ | – | False | – | – | offline | 0 |
| tool-false-pass-all+watchdog | sphinx-doc__sphinx-9711__cy9Piw3 | – | False | – | – | offline | 0 |
| tool-false-pass-all+watchdog | sympy__sympy-14711__GsCR2aB | – | False | – | – | offline | 0 |
| tool-timeout-all+watchdog | django__django-13410__HhQrYRc | – | False | – | – | offline | 0 |

## Recovery: always-verify and restart

Each condition without and with the reviewer (and one correction round), on the same tasks. *Restart* reruns a failed run once as its control (estimated from the control's runs). Minutes are median agent minutes per run; restart minutes add the control's time for each failed run. *Rejected* is the share of verify runs whose reviewer rejected the first submission (on controls, a false alarm).

| Condition | Pass | Pass with verify | Δ verify | Pass with restart | Min | Min with verify | Min with restart | Out tokens | Out tokens with verify | Rejected | Corrections | Verify min |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Watchdog

*Checked* is the median number of watchdog suspicions per run (each test-runner check is one probe; rerouted runs are not checks). *Caught* counts runs where a plug-in confirmed a fault; on a control every catch is a false alarm. *Repairs* is the median number of repaired or rerouted results in those runs. *Probe hits* counts runs where a probe met the fault.

| Condition | Runs | Checked | Caught | Repairs | Probe hits |
|---|---|---|---|---|---|
| control-rp+watchdog | 19 | 2 | 0/19 | – | 0 |
| edit-corrupt-hidden+watchdog | 19 | 3 | 15/19 | 1 | 0 |
| tool-false-fail-all+watchdog | 19 | 1 | 19/19 | 5 | 19 |
| tool-false-pass-all+watchdog | 19 | 1 | 18/19 | 4.5 | 18 |
| tool-timeout-all+watchdog | 19 | 1 | 18/19 | 5.0 | 18 |
