"""Tests for scoring, provenance, durable commits and the intentionally absent backend."""
import copy
import hashlib
import json
import shutil
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from t4_lite.core import (ROOT, Invalid, create_run, fingerprint, load_benchmark, load_run,
                          read_json, read_results, record_result, sha256,
                          summarize, validate_result, verify_packages, write_json)
from t4_lite.__main__ import main, pilot_summary
from t4_lite.contracts import Harness


class BenchmarkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.benchmark = load_benchmark()
        cls.pilot = {r['task_id']: r for r in read_json(ROOT / 'pilot/results.json')['tasks']}
        cls.temp_root = ROOT / 'tests/.tmp'
        cls.temp_root.mkdir(exist_ok=True)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=self.temp_root)
        self.root = Path(self.temp.name)
        self.run = self.root / 'run'
        self.meta = create_run(self.benchmark, self.run, model='test-model', agent='test-only',
                               profile={'schema_version': 1, 'context_window_tokens': 262144})

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, task=None, status=None):
        task = task or self.benchmark.tasks[0]
        pilot = self.pilot[task['id']]
        status = status or pilot['status']
        folder = self.root / 'incoming' / task['id']
        folder.mkdir(parents=True, exist_ok=True)
        write_json(folder / 'native.json', {'test_fixture': True, 'reward': pilot['reward']})
        write_json(folder / 'verifier.json', {'test_fixture': True, 'checks': pilot['checks']})
        result = {'schema_version': 1, 'run_id': self.meta['run_id'],
                  'benchmark_sha256': self.benchmark.digest, 'profile_sha256': self.meta['profile_sha256'],
                  'task_id': task['id'], 'source_ref': task['source']['ref'], 'status': status,
                  'reward': pilot['reward'], 'checks': dict(pilot['checks']), 'health': dict(pilot['health']),
                  'evidence': [{'kind': kind, 'path': name, 'sha256': sha256(folder / name)} for kind, name in
                               [('native_result', 'native.json'), ('verifier', 'verifier.json')]]}
        if status not in ('pass', 'fail'):
            result.update(reward=None, checks={}, health={}, notes='Injected infrastructure fault')
        write_json(folder / 'result.json', result)
        return folder / 'result.json', result

    def test_frozen_packages_and_catalog(self):
        self.assertEqual(len(self.benchmark.tasks), 24)
        self.assertEqual(self.benchmark.manifest['check_count'], 333)
        self.assertGreater(verify_packages(self.benchmark)['verified_files'], 500)

    def test_selection_reproduces_the_draw(self):
        data = read_json(ROOT / 'benchmark/selection.json')
        excluded = {'freecad-impeller', 'freecad-spring-clip'}
        drawn = []
        for category, quota in data['quotas'].items():
            pool = [r for r in data['candidates'] if not r['quarantined'] and r['id'] not in excluded
                    and r['category'] == category]
            pool.sort(key=lambda r: hashlib.sha256((data['seed'] + '\n' + r['id']).encode()).hexdigest())
            drawn.extend(r['id'] for r in pool[:quota])
        self.assertEqual(drawn, data['selected'])
        self.assertEqual(drawn, [t['id'] for t in self.benchmark.tasks])

    def test_pilot_replays_evidence_and_two_scores(self):
        report = pilot_summary(self.benchmark)
        self.assertTrue(report['valid'])
        self.assertEqual(report['counts']['pass'], 7)
        self.assertEqual(report['checks'], {'passed_recorded': 254, 'total': 333})
        self.assertAlmostEqual(report['task_pass_percent'], 7 / 24 * 100)
        self.assertAlmostEqual(report['verification_pass_percent'], 254 / 333 * 100)
        self.assertEqual(report['kind'], 'historical_pilot')

    def test_parameterized_checks_keep_distinct_ids(self):
        task = self.benchmark.task('hof-topology-interpenetration')
        checks = task['checks']
        self.assertEqual(len(checks), 38)
        self.assertEqual(len({c['id'] for c in checks}), 38)
        self.assertLess(len({c['name'] for c in checks}), 38)

    def test_health_checks_are_separate(self):
        task = self.benchmark.task('ontology-kg-querying')
        self.assertEqual(len(task['health_checks']), 2)
        self.assertEqual(len(task['checks']), 11)
        source, result = self.bundle(task)
        result['health']['health-001'] = 'fail'
        with self.assertRaises(Invalid):
            validate_result(self.benchmark, self.meta, result)

    def test_react_workflow_is_not_double_counted(self):
        checks = self.benchmark.task('react-lead-form')['checks']
        self.assertEqual(len(checks), 1)
        self.assertEqual(checks[0]['unit'], 'composite_acceptance_test')

    def test_partial_run_withholds_both_scores(self):
        source, _ = self.bundle()
        record_result(self.benchmark, self.run, source)
        report = summarize(self.benchmark, read_results(self.benchmark, self.run))
        self.assertIsNone(report['task_pass_percent'])
        self.assertIsNone(report['verification_pass_percent'])
        self.assertEqual(report['checks']['total'], 333)
        self.assertEqual(len(read_results(self.benchmark, self.run)), 1)

    def test_record_all_tasks_then_resume_has_no_work(self):
        for task in self.benchmark.tasks:
            source, _ = self.bundle(task)
            record_result(self.benchmark, self.run, source)
        results = read_results(self.benchmark, self.run)
        report = summarize(self.benchmark, results)
        self.assertTrue(report['valid'])
        self.assertEqual(len(read_results(self.benchmark, self.run)), 24)
        self.assertEqual(report['checks']['passed_recorded'], 254)

    def test_bad_terminal_task_does_not_shrink_denominator(self):
        for i, task in enumerate(self.benchmark.tasks):
            source, _ = self.bundle(task, 'error' if i == 0 else None)
            record_result(self.benchmark, self.run, source)
        report = summarize(self.benchmark, read_results(self.benchmark, self.run))
        self.assertTrue(report['complete'])
        self.assertFalse(report['valid'])
        self.assertEqual(report['coverage']['total_tasks'], 24)
        self.assertIsNone(report['verification_pass_percent'])
        self.assertEqual(len(read_results(self.benchmark, self.run)), 24)

    def test_missing_unknown_or_invalid_check_rejected(self):
        source, original = self.bundle()
        for mode in ('missing', 'unknown', 'invalid'):
            result = copy.deepcopy(original)
            if mode == 'missing': result['checks'].pop(next(iter(result['checks'])))
            elif mode == 'unknown': result['checks']['made-up'] = 'pass'
            else: result['checks'][next(iter(result['checks']))] = 'unknown'
            with self.assertRaises(Invalid): validate_result(self.benchmark, self.meta, result)

    def test_skipped_check_stays_in_denominator(self):
        source, result = self.bundle()
        result['checks'][next(iter(result['checks']))] = 'skipped'
        validate_result(self.benchmark, self.meta, result)

    def test_native_reward_is_not_inferred_from_check_fraction(self):
        source, result = self.bundle()
        result.update(status='fail', reward=0, checks={c: 'pass' for c in result['checks']})
        validate_result(self.benchmark, self.meta, result)
        result['reward'] = 1
        with self.assertRaises(Invalid): validate_result(self.benchmark, self.meta, result)

    def test_boolean_reward_rejected(self):
        source, result = self.bundle()
        result['reward'] = False
        with self.assertRaises(Invalid): validate_result(self.benchmark, self.meta, result)

    def test_cross_run_version_or_profile_results_rejected(self):
        source, original = self.bundle()
        for key in ('run_id', 'benchmark_sha256', 'profile_sha256', 'source_ref'):
            result = copy.deepcopy(original)
            result[key] = 'wrong'
            with self.assertRaises(Invalid): validate_result(self.benchmark, self.meta, result)

    def test_identical_commit_is_idempotent_and_different_one_rejected(self):
        source, result = self.bundle()
        self.assertEqual(record_result(self.benchmark, self.run, source), 'recorded')
        self.assertEqual(record_result(self.benchmark, self.run, source), 'already_recorded')
        result['notes'] = 'Try to replace an existing outcome'
        write_json(source, result)
        with self.assertRaises(Invalid): record_result(self.benchmark, self.run, source)

    def test_concurrent_identical_commits_preserve_one_result(self):
        source, _ = self.bundle()
        with ThreadPoolExecutor(max_workers=2) as pool:
            answers = list(pool.map(lambda _: record_result(self.benchmark, self.run, source), range(2)))
        self.assertEqual(answers.count('recorded'), 1)
        self.assertEqual(answers.count('already_recorded'), 1)
        self.assertEqual(len(read_results(self.benchmark, self.run)), 1)

    def test_evidence_checked_before_commit_and_on_every_read(self):
        source, result = self.bundle()
        record_result(self.benchmark, self.run, source)
        target = self.run / 'results' / result['task_id'] / 'verifier.json'
        target.write_text('tampered', encoding='utf-8')
        with self.assertRaises(Invalid): read_results(self.benchmark, self.run)
        (source.parent / 'verifier.json').write_text('tampered', encoding='utf-8')
        with self.assertRaises(Invalid): record_result(self.benchmark, self.run, source)

    def test_traversal_rejected(self):
        source, result = self.bundle()
        for path in ('../outside', '/absolute', 'C:/absolute', 'x\\y', 'result.json'):
            result['evidence'][0]['path'] = path
            with self.assertRaises(Invalid): validate_result(self.benchmark, self.meta, result)

    def test_incomplete_commit_directory_is_ignored(self):
        stage = self.run / 'results/.pending-interrupted'
        stage.mkdir()
        (stage / 'uncommitted.txt').write_text('partial')
        self.assertEqual(read_results(self.benchmark, self.run), {})

    def test_run_metadata_change_rejected(self):
        data = read_json(self.run / 'run.json')
        data['model'] = 'another-model'
        write_json(self.run / 'run.json', data)
        with self.assertRaises(Invalid): load_run(self.benchmark, self.run)

    def test_committed_result_modification_rejected(self):
        source, result = self.bundle()
        record_result(self.benchmark, self.run, source)
        path = self.run / 'results' / result['task_id'] / 'result.json'
        changed = read_json(path)
        changed['notes'] = 'Changed after commit'
        write_json(path, changed)
        with self.assertRaises(Invalid): read_results(self.benchmark, self.run)

    def test_cli_incomplete_report_and_csv(self):
        import contextlib
        import csv
        import io
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            code = main(['report', str(self.run), '--json'])
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(stream.getvalue())['valid'])
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            code = main(['export', str(self.run)])
        self.assertEqual(code, 0)
        self.assertEqual(len(list(csv.DictReader(io.StringIO(stream.getvalue())))), 24)

    def test_duplicate_json_keys_rejected(self):
        path = self.root / 'duplicate.json'
        path.write_text('{"checks": {}, "checks": {"x": "pass"}}')
        with self.assertRaises(Invalid): read_json(path)

    def test_credential_profile_rejected(self):
        with self.assertRaises(Invalid):
            create_run(self.benchmark, self.root / 'bad', model='m', agent='a',
                       profile={'schema_version': 1, 'nested': {'api_key': 'secret'}})
        self.assertFalse((self.root / 'bad').exists())

    def test_harness_command_is_required(self):
        with self.assertRaises(ValueError):
            Harness(command=())


if __name__ == '__main__':
    unittest.main()
