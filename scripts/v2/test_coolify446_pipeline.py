#!/usr/bin/env python3
"""Actual installed API/job code, captured commands only. No live resource."""
import json
from pathlib import Path
import shutil
import sys
import unittest
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import art337_immutable_recovery as r
from coolify446_pipeline import replay


@unittest.skipUnless(shutil.which('php'), 'PHP CLI required; enforced by CI prerequisite')
class InstalledCoolifyPipeline(unittest.TestCase):
    def test_canonical_create_persistence_compose_pull_and_up(self):
        for repository in ('ghcr.io/artgurianov/flexperiment', 'localhost:51234/flexperiment/art337-proof'):
            reference = repository + '@sha256:' + 'a'*64
            fields = r.coolify_image_fields(reference)
            proof = replay(fields)
            self.assertEqual(proof['persisted'], fields)
            self.assertEqual(proof['job']['productionImage'], reference)
            self.assertEqual(proof['job']['compose']['services']['art337-fixture']['image'], reference)
            self.assertNotIn('build', proof['job']['compose']['services']['art337-fixture'])
            self.assertEqual(proof['job']['compose']['services']['art337-fixture']['cpu_shares'], 1024)
            self.assertEqual(proof['job']['commands'][-2:], [
                'docker compose --project-name art337-fixture --project-directory /proof pull',
                ' docker compose --project-name art337-fixture --project-directory /proof up --build -d'])

    def test_bare_hash_api_normalizes_name_and_breaks_old_readback_contract(self):
        # 4.4.6 API happens to normalize this to a digest too, but the previous
        # controller wrongly required unchanged repository on GET. Exercise the
        # actual code rather than infer this from only DockerImageParser.
        proof = replay({'docker_registry_image_name':'ghcr.io/artgurianov/flexperiment',
                        'docker_registry_image_tag':'a'*64})
        self.assertEqual(proof['persisted']['docker_registry_image_name'], 'ghcr.io/artgurianov/flexperiment@sha256')
        self.assertEqual(proof['job']['productionImage'], 'ghcr.io/artgurianov/flexperiment@sha256:'+'a'*64)
        self.assertNotEqual(proof['persisted'], r.coolify_image_fields(proof['job']['productionImage']))

    def test_mutable_tag_resolves_as_tag_and_cannot_satisfy_expected_digest(self):
        for tag in ('latest', 'release-85', 'a'*63):
            proof = replay({'docker_registry_image_name':'ghcr.io/artgurianov/flexperiment', 'docker_registry_image_tag':tag})
            self.assertEqual(proof['job']['productionImage'], 'ghcr.io/artgurianov/flexperiment:'+tag)
            self.assertNotEqual(proof['job']['productionImage'], 'ghcr.io/artgurianov/flexperiment@sha256:'+'a'*64)

    def test_reference_inputs_refuse_tags_or_malformed_digests(self):
        for reference in ('ghcr.io/x/y:latest', 'ghcr.io/x/y@sha256:'+'a'*63, 'ghcr.io/x/y@sha256:'+'A'*64):
            with self.assertRaises(r.Refusal): r.coolify_image_fields(reference)


if __name__ == '__main__': unittest.main()
