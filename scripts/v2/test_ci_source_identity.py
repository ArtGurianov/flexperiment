"""Admission wiring contracts; no credentials, deployment or provider calls."""
from pathlib import Path
import re
import unittest

WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/test.yml"


def verify(text):
    if text.count("github.sha") != 1 or "CI_SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}" not in text:
        raise ValueError("EXACT_CI_SOURCE_SELECTION_REQUIRED")
    jobs = [text.split("\n  " + name + ":\n", 1)[1].split("\n  docker-build:", 1)[0] for name in ["test", "docker-build"]]
    for job in jobs:
        if "- uses: actions/checkout@v4\n        with:\n          ref: ${{ env.CI_SOURCE_SHA }}" not in job \
                or 'run: test "$(git rev-parse HEAD)" = "$CI_SOURCE_SHA"' not in job:
            raise ValueError("EXACT_CHECKOUT_ASSERTION_REQUIRED")
    values = re.findall(r"SOURCE_COMMIT[:=]\s*(\$\{\{[^}]+\}\})", text)
    if len(values) < 10 or any(value != "${{ env.CI_SOURCE_SHA }}" for value in values):
        raise ValueError("BUILD_RUNTIME_CI_SOURCE_MISMATCH")


class CiSourceIdentity(unittest.TestCase):
    def test_actual_workflow_pins_and_asserts_both_jobs(self):
        verify(WORKFLOW.read_text())

    def test_synthetic_merge_checkout_or_baked_sha_is_detected(self):
        text = WORKFLOW.read_text()
        for mutation in [text.replace("ref: ${{ env.CI_SOURCE_SHA }}", "ref: ${{ github.sha }}", 1),
                         text.replace("SOURCE_COMMIT=${{ env.CI_SOURCE_SHA }}", "SOURCE_COMMIT=${{ github.sha }}", 1),
                         text.replace("github.event.pull_request.head.sha || github.sha", "github.sha", 1)]:
            with self.assertRaises(ValueError):
                verify(mutation)

    def test_missing_checkout_assertion_fails_closed(self):
        text = WORKFLOW.read_text().replace('run: test "$(git rev-parse HEAD)" = "$CI_SOURCE_SHA"', 'run: true', 1)
        with self.assertRaises(ValueError):
            verify(text)


if __name__ == "__main__":
    unittest.main()
