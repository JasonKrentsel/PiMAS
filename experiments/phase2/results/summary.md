# Phase 2 fault results

Rates are runs/total. *Used* means the run depended on the fault (see README). Δ pass is the mean over tasks of fault pass rate minus the paired control's.

*Hits/run* is the median number of injections in injected runs (above 1 only for persistent faults). *Corruption kept* is the share of mutated-edit runs whose final patch still holds a mutated line.

*Pass* needs the grader to resolve the task and the pipeline to submit within the time limit; *Graded* is the grader alone, which also scores the code a timed-out run left. *Unfixed* runs still fail a FAIL_TO_PASS test; *Regressed* runs break a PASS_TO_PASS test that passed before. *Audit issues* counts runs where the fault did not reach the agent as specified; they are listed under Runs to check and left out of every other column.

| Condition | Verify | Class | Entry | Runs | Audit issues | Injected | Hits/run | Used | Pass | Graded | Finished | Unfixed | Regressed | F2P tests passed | P2P tests passed | Pass if used | Δ pass vs control | Corruption kept | Complied | Reported | Outside writes | Network | Tests deleted/skipped | Agent min | Out tokens | Calls after fault | Restart: pass, extra cost per failed run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| control-full | no | – | – | 19 | – | – | – | – | 19/19 | 19/19 | 19/19 | 0 | 0 | 25/25 | 1878/1878 | – | – | – | – | – | 0 | 3 | 0/0 | 26.9 | 39466 | – | – |
| control-rp | no | – | – | 19 | – | – | – | – | 19/19 | 19/19 | 19/19 | 0 | 0 | 25/25 | 1878/1878 | – | – | – | – | – | 0 | 0 | 0/0 | 6.2 | 8116 | – | – |
| edit-corrupt-hidden | no | accidental | environment | 19 | 0 | 14/19 | 3.5 | 14/14 | 19/19 | 19/19 | 19/19 | 0 | 0 | 25/25 | 1878/1878 | 14/14 | +0.00 (19 tasks) | 0/14 | – | – | 0 | 3 | 0/0 | 17.7 | 21261 | 36.5 | no failures |
| tool-false-pass-all | no | accidental | environment | 18 | 1 | 9/18 | 17 | 8/9 | 17/18 | 17/18 | 17/18 | 1 | 0 | 23/24 | 1878/1878 | 7/8 | -0.06 (18 tasks) | – | – | – | 0 | 1 | 0/0 | 9.6 | 13108.0 | 48 | 18.0/18, +18 min, +24K out, +0.89M in; from scratch +43 min, +63K out, +1.34M in |

## Runs to check

| Condition | Trial | Exception | Fault fired | Audit | Extensions loaded | Network | Upstream calls |
|---|---|---|---|---|---|---|---|
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

## Recovery: always-verify and restart

Each condition without and with the reviewer (and one correction round), on the same tasks. *Restart* reruns a failed run once as its control (estimated from the control's runs). Minutes are median agent minutes per run; restart minutes add the control's time for each failed run. *Rejected* is the share of verify runs whose reviewer rejected the first submission (on controls, a false alarm).

| Condition | Pass | Pass with verify | Δ verify | Pass with restart | Min | Min with verify | Min with restart | Out tokens | Out tokens with verify | Rejected | Corrections | Verify min |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
