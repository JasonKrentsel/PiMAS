# Failing SWE-bench tests

| Condition | Trial | Finished | FAIL_TO_PASS still failing | PASS_TO_PASS broken |
|---|---|---|---|---|
| research-wrong | django__django-16801__KejJQSa | True | test_post_init_not_connected (model_fields.test_imagefield.ImageFieldNoDimensionsTests.test_post_init_not_connected) | – |
| research-wrong | pytest-dev__pytest-5262__rVKDAvg | True | – | testing/test_capture.py::test_typeerror_encodedfile_write |
| tool-timeout-all | scikit-learn__scikit-learn-13142__u7YBHVe | False | sklearn/mixture/tests/test_bayesian_mixture.py::test_bayesian_mixture_fit_predict_n_init; sklearn/mixture/tests/test_gaussian_mixture.py::test_gaussian_mixture_fit_predict_n_init | – |
