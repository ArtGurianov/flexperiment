#!/usr/bin/env python3
"""Offline fault injection. No owner state, network, secrets or live Docker."""
import copy
import contextlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import art337_immutable_recovery as r


def artifact():
    return {"reference": "ghcr.io/artgurianov/flexperiment@sha256:" + "a" * 64,
            "manifestDigest": "sha256:" + "a" * 64,
            "manifest": {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                         "config": {"digest": "sha256:" + "b" * 64, "size": 100},
                         "layers": [{"digest": "sha256:" + "c" * 64, "size": 200}]},
            "imageId": "sha256:" + "d" * 64, "rootfs": ["sha256:" + "e" * 64],
            "os": "linux", "architecture": "amd64",
            "identity": {"schema": "flexperiment.build-identity/1", "service": "commerce-v2", "sourceCommit": r.TARGET}}


@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        (root / "erasure-admission-history").mkdir(mode=0o700)
        old = r.canonical({"version": 2, "sourceCommit": r.TARGET, "imageId": "sha256:" + "f" * 64})
        (root / "erasure-admission.json").write_bytes(old)
        now = datetime.now(timezone.utc).isoformat()
        inventory = {"issue": "ART-329", "environment": "canary-v2", "generated_at_utc": now,
            "snapshots": {kind: {"snapshot_sha256": r.CURRENT_SNAPSHOTS[kind], "integrity_check": "ok"} for kind in ("commerce", "payload")},
            "inventories": {kind: {"tables": [{"table": k, "count": (26 if k == "schema_migrations" else v)}
                for k, v in counts.items()]} for kind, counts in r.q.APPROVED_NONZERO.items()}}
        image = artifact()
        proof = {"sourceCommit": r.TARGET, "artifactSha256": r.q.digest(r.canonical(image)),
                 "inputCommerceSha256": r.CURRENT_SNAPSHOTS["commerce"], "schemaFingerprint": r.SCHEMA,
                 "beforeMigrations": 26, "afterMigrations": 26, "integrity": "ok", "foreignKeys": "ok",
                 "ledgerSequence": 1, "mirrorSha256": "2" * 64,
                 "proofScriptSha256": r.q.digest(pathlib.Path(r.__file__).with_name("art337-proof-continue.mjs").read_bytes())}
        backup = {"scope": "canary", "sourceCommit": r.TARGET, "state": "READBACK_PASS",
                  "previousChainReadback": "PASS", "recoveryKeys": "AVAILABLE", "archives": {},
                  "previousChainObjects": [{"object": "old.age", "sha256": "3" * 64, "remoteSha256": "3" * 64, "size": 20}]}
        for kind in ("commerce", "payload"):
            path = root / (kind + ".age"); path.write_bytes(b'isolated-ciphertext')
            sha = r.q.digest(path.read_bytes())
            backup["archives"][kind] = {"path": str(path), "sha256": sha, "remoteSha256": sha,
                                       "size": path.stat().st_size, "snapshotSha256": r.CURRENT_SNAPSHOTS[kind], "independentPlaintextSha256": r.CURRENT_SNAPSHOTS[kind]}
        reports = {"inventory": inventory, "backup": backup,
                   "artifact": {"artifact": image},
                   "restore": {**proof, "result": "PASS", "syntheticErasedAccounts": 1, "currentUsers": 0},
                   "boot": {**proof, "result": "BOOT_PASS", "fence": "OPEN", "leases": 0},
                   "isolation": {"payloadWriters": "STOPPED", "commerceWriters": "STOPPED", "queuedDeployments": 0},
                   "timers": {"state": "CANARY_TIMERS_ISOLATED", "profile": r.timers.FILES, "isolationOutcomeSha256": "4"*64},
                   "delivery": {"applicationUuid": "n" * 24, "sourceApplicationUuid": r.ORIGINAL_APP,
                       "buildPack": "dockerimage", "reference": image["reference"], "mountsVerified": "PASS",
                       "namespaceVerified": "PASS", "backupBindingVerified": "PASS"}}
        files = {}
        for kind, report in reports.items():
            if kind != "inventory": report["recordedAt"] = now
            path = root / (kind + ".json"); path.write_bytes(r.canonical(report))
            files[kind] = {"path": str(path), "sha256": r.q.digest(path.read_bytes())}
        isolation = reports['isolation']
        isolation.update(commerceTimers='ISOLATED', timerIsolationSha256=files['timers']['sha256'])
        pathlib.Path(files['isolation']['path']).write_bytes(r.canonical(isolation))
        files['isolation']['sha256'] = r.q.digest(r.canonical(isolation))
        manifest = {"version": 3, "scope": "canary", "sourceCommit": r.TARGET,
                    "parentJournalSha256": r.q.digest(old), "schemaFingerprint": r.SCHEMA,
                    "installationId": r.q.INSTALLATION, "readerBindingSha256": r.q.READER_BINDING,
                    "applicationUuid": "n" * 24, "controllerCommit": "6" * 40,
                    "ledgerSequence": 1, "mirrorSha256": "2" * 64, "files": files}
        def update(kind, change):
            value = json.loads(pathlib.Path(files[kind]["path"]).read_bytes()); change(value)
            pathlib.Path(files[kind]["path"]).write_bytes(r.canonical(value))
            files[kind]["sha256"] = r.q.digest(pathlib.Path(files[kind]["path"]).read_bytes())
        with patch.object(r, "ROOT", root), patch.object(r.q, "ROOT", root), patch.object(r, "PARENT", r.q.digest(old)), \
                patch.object(r, "read", side_effect=lambda path: pathlib.Path(path).read_bytes()), \
                patch.object(r, "history_directory", return_value=root / "erasure-admission-history"):
            yield root, manifest, old, update


class Descriptor(unittest.TestCase):
    def test_single_manifest_qualified(self):
        self.assertEqual(r.descriptor(artifact()), artifact())

    def test_native_platform_and_admin_contracts_derive_resource_role(self):
        for service in ("platform-v2", "admin-v2"):
            a = artifact(); a["identity"] = copy.deepcopy(r.NATIVE_IDENTITIES[service])
            self.assertEqual(r.descriptor(a), a)
            self.assertEqual(r.artifact_service(a), service)

    def test_native_contract_unknown_source_role_or_admin_version_refuses(self):
        for identity in ({"schema": "flexperiment.build-identity/1", "service": "platform-v2", "sourceCommit": r.TARGET},
                         {"source_commit": "7" * 40, "admin_contract_version": "sales-availability-v1"},
                         {"source_commit": r.TARGET, "admin_contract_version": "unknown"},
                         {**r.NATIVE_IDENTITIES["admin-v2"], "service": "commerce-v2"}):
            a = artifact(); a["identity"] = identity
            with self.subTest(identity=identity), self.assertRaises(r.Refusal): r.descriptor(a)

    def test_inspect_native_images_uses_real_paths_and_refuses_role_confusion(self):
        for service in ("platform-v2", "admin-v2"):
            a = artifact(); a["identity"] = copy.deepcopy(r.NATIVE_IDENTITIES[service])
            raw = r.canonical(a["manifest"])
            a["manifestDigest"] = "sha256:" + r.q.digest(raw)
            a["reference"] = a["reference"].partition("@")[0] + "@" + a["manifestDigest"]
            image = {"Id": a["imageId"], "RootFS": {"Layers": a["rootfs"]}, "Os": "linux", "Architecture": "amd64"}
            outputs = [raw, b"pulled", json.dumps([image]).encode(), json.dumps(a["identity"]).encode()]
            with patch.object(r, "run", side_effect=outputs) as run:
                self.assertEqual(r.inspect_artifact(a["reference"], service), a)
                self.assertEqual(run.call_args.args[0][-1], r.NATIVE_IDENTITY_PATHS[service])
            with patch.object(r, "run", side_effect=outputs), self.assertRaisesRegex(r.Refusal, "ARTIFACT_SERVICE_DRIFT"):
                r.inspect_artifact(a["reference"], "commerce-v2")

    def test_runtime_native_admin_rejects_descriptor_drift_and_uses_nginx_path(self):
        a = artifact(); a["identity"] = copy.deepcopy(r.NATIVE_IDENTITIES["admin-v2"])
        container = {"Id": "cid", "Image": a["imageId"], "Config": {"Image": a["reference"]}}
        image = {"Id": a["imageId"], "RootFS": {"Layers": a["rootfs"]}, "Os": "linux", "Architecture": "amd64"}
        for contract in (a["identity"], {**a["identity"], "source_commit": "7" * 40}):
            with patch.object(r, "run", side_effect=[json.dumps([container]).encode(), json.dumps([image]).encode(), json.dumps(contract).encode()]) as run:
                if contract == a["identity"]: self.assertEqual(r.verify_runtime(a, "cid")["identity"], contract)
                else:
                    with self.assertRaisesRegex(r.Refusal, "INSTALLED_BAKED_IDENTITY_MISMATCH"): r.verify_runtime(a, "cid")
                self.assertEqual(run.call_args.args[0][-1], "/usr/share/nginx/html/release.json")

    def test_native_admin_cannot_be_admitted_as_commerce(self):
        with fixture() as (_, manifest, _, update):
            update("artifact", lambda value: value["artifact"].update(identity=copy.deepcopy(r.NATIVE_IDENTITIES["admin-v2"])))
            with self.assertRaisesRegex(r.Refusal, "COMMERCE_ARTIFACT_REQUIRED"): r.validate(manifest)

    def test_mutable_tags_indexes_wrong_architecture_service_layers(self):
        changes = [lambda a: a.update(reference="ghcr.io/artgurianov/flexperiment:latest"),
                   lambda a: a["manifest"].update(manifests=[]), lambda a: a.update(architecture="arm64"),
                   lambda a: a.update(rootfs=[]), lambda a: a["identity"].update(sourceCommit="7" * 40),
                   lambda a: a["manifest"]["config"].update(size=0)]
        for change in changes:
            a = artifact(); change(a)
            with self.subTest(a=a), self.assertRaises(r.Refusal): r.descriptor(a)

    def test_manifest_exact_bytes_are_hashed_before_pull(self):
        with patch.object(r, "run", return_value=b'{"schemaVersion":2}') as run, self.assertRaisesRegex(r.Refusal, "REGISTRY_MANIFEST_DIGEST_DRIFT"):
            r.inspect_artifact(artifact()["reference"], "commerce-v2")
        self.assertEqual(run.call_count, 1)

    def test_source_equal_different_image_or_layers_refuses(self):
        a = artifact()
        container = {"Id": "cid", "Image": a["imageId"], "Config": {"Image": a["reference"]}}
        image = {"Id": a["imageId"], "RootFS": {"Layers": a["rootfs"]}, "Os": "linux", "Architecture": "amd64"}
        for change in ("image", "layers", "tag", "source"):
            c, i, identity = copy.deepcopy(container), copy.deepcopy(image), copy.deepcopy(a["identity"])
            if change == "image": c["Image"] = "sha256:" + "f" * 64
            if change == "layers": i["RootFS"]["Layers"] = ["sha256:" + "f" * 64]
            if change == "tag": c["Config"]["Image"] = "mutable:latest"
            if change == "source": identity["sourceCommit"] = "7" * 40
            outputs = [json.dumps([c]).encode(), json.dumps([i]).encode(), json.dumps(identity).encode()]
            with self.subTest(change=change), patch.object(r, "run", side_effect=outputs), self.assertRaises(r.Refusal):
                r.verify_runtime(a, "cid")


class Evidence(unittest.TestCase):
    def test_real_python310_accepts_node_iso_utc_and_refuses_future(self):
        r.fresh(datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
        with self.assertRaisesRegex(r.Refusal, "STALE_OR_FUTURE"):
            r.fresh((datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat().replace("+00:00", "Z"))

    def test_schema26_positive(self):
        with fixture() as (_, manifest, _, _): r.validate(manifest)

    def test_new_customer_old_schema_restore_old_artifact_and_leases_refuse(self):
        cases = [("inventory", lambda v: v["inventories"]["commerce"]["tables"].append({"table": "customers", "count": 1})),
                 ("inventory", lambda v: v["snapshots"]["commerce"].update(snapshot_sha256="9" * 64)),
                 ("inventory", lambda v: next(x for x in v["inventories"]["commerce"]["tables"] if x["table"] == "schema_migrations").update(count=25)),
                 ("restore", lambda v: v.update(beforeMigrations=25)),
                 ("boot", lambda v: v.update(artifactSha256="9" * 64)),
                 ("boot", lambda v: v.update(leases=1)), ("boot", lambda v: v.update(ledgerSequence=2)),
                 ("backup", lambda v: v["previousChainObjects"][0].update(remoteSha256="9" * 64)),
                 ("backup", lambda v: v["archives"]["commerce"].update(independentPlaintextSha256="9" * 64)),
                 ("delivery", lambda v: v.update(applicationUuid=r.ORIGINAL_APP)),
                 ("artifact", lambda v: v.update(recordedAt=(datetime.now(timezone.utc)-timedelta(hours=2)).isoformat()))]
        for kind, change in cases:
            with self.subTest(kind=kind), fixture() as (_, manifest, _, update):
                update(kind, change)
                with self.assertRaises(r.Refusal): r.validate(manifest)

    def test_release_checks_latest_exact_ci_and_controller_blob(self):
        with patch.object(r, "github", return_value={"object": {"sha": "7" * 40}}), self.assertRaisesRegex(r.Refusal, "NOT_MAIN"):
            r.verify_release("6" * 40)
        def api(path):
            if path.startswith("git/"): return {"object": {"sha": r.TARGET}}
            return {"check_runs": []}
        with patch.object(r, "github", side_effect=api), self.assertRaisesRegex(r.Refusal, "EXACT_HEAD_CI_REQUIRED"):
            r.verify_release("6" * 40)


class DeliveryBoundary(unittest.TestCase):
    def parent_app(self):
        return {"uuid": r.ORIGINAL_APP, "environment_id": 6, "destination_id": 0,
                "environment": {"name": "canary-v2", "uuid": "v"*24, "project": {"uuid": "wclu2wovf4ctpbgam3h7grzb"}},
                "destination": {"uuid": "5gwzwaau6dfwx3xrqgahstzi", "server": {"uuid": "1460ru9bxuxzrqnswauxqxhc"}}}

    def test_create_only_canary_no_deploy_or_new_volume(self):
        rpc = Mock(); parent = self.parent_app()
        created = {"uuid": "n"*24, "environment_id": 6, "destination_id": 0, "build_pack": "dockerimage",
                   "name": "flexperiment-commerce-v2-canary-immutable",
                   "settings": {"is_auto_deploy_enabled": False, "is_preview_deployments_enabled": False},
                   **r.coolify_image_fields(artifact()["reference"])}
        rpc.exclusive_canary.return_value = {"exclusive": True}; rpc.container.return_value = None
        requests = []
        def api(method, path, body=None):
            requests.append((method, path, body))
            if method == "POST": return {"uuid": "n"*24}
            return parent if path.endswith(r.ORIGINAL_APP) else created
        rpc.api.side_effect = api
        with patch.object(r, "verify_parent"), patch.object(r.q, "verify_payload_stopped"), \
                patch.object(r, "verify_artifact"), patch.object(r, "once", side_effect=lambda name, body, action: action()):
            self.assertEqual(r.create_delivery(artifact(), rpc)["state"], "CREATED_STOPPED_NOT_ADMITTED")
        posts = [x for x in requests if x[0] == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0][1], "/applications/dockerimage")
        self.assertFalse(posts[0][2]["instant_deploy"])
        self.assertFalse(posts[0][2]["is_auto_deploy_enabled"])
        self.assertFalse(posts[0][2]["is_preview_deployments_enabled"])
        self.assertEqual(posts[0][2]["domains"], "")
        self.assertEqual(posts[0][2]["docker_registry_image_name"], "ghcr.io/artgurianov/flexperiment")
        self.assertEqual(posts[0][2]["docker_registry_image_tag"], "sha256-" + "a"*64)
        self.assertEqual(posts[0][2]["custom_network_aliases"], r.ORIGINAL_APP)
        self.assertNotIn("git_commit_sha", posts[0][2])

    def test_validate_rejects_bare_tag_before_reading_secrets_or_mounts(self):
        with fixture() as (_, manifest, _, _), patch.object(r, "configured_uuid", return_value="n"*24):
            rpc = Mock(); rpc.api.return_value = {"uuid":"n"*24,
                "name":"flexperiment-commerce-v2-canary-immutable", "build_pack":"dockerimage",
                "docker_registry_image_name":"ghcr.io/artgurianov/flexperiment", "docker_registry_image_tag":"a"*64}
            with self.assertRaisesRegex(r.Refusal, "IMMUTABLE_RESOURCE_DRIFT"):
                r.validate_delivery(manifest, rpc, {})
            self.assertEqual(rpc.api.call_count, 1)

    def test_namespace_change_after_configure_refuses_before_reading_secrets(self):
        with fixture() as (_,manifest,_,_),patch.object(r,'configured_uuid',return_value='n'*24):
            app={'uuid':'n'*24,'name':'flexperiment-commerce-v2-canary-immutable','build_pack':'dockerimage',
                 'ports_exposes':'3002','custom_network_aliases':r.ORIGINAL_APP,'status':'exited:unhealthy',
                 'environment_id':99,'destination_id':0,**r.coolify_image_fields(artifact()['reference']),
                 'settings':{'is_auto_deploy_enabled':False,'is_preview_deployments_enabled':False}}
            rpc=Mock();rpc.container.return_value=None;rpc.api.side_effect=[app,self.parent_app()]
            with self.assertRaisesRegex(r.Refusal,'DELIVERY_NAMESPACE_DRIFT'):r.validate_delivery(manifest,rpc,{})
            self.assertEqual(rpc.api.call_count,2)

    def test_configure_rejects_bare_tag_before_provisioning(self):
        with fixture() as (root, _, _, _), patch.object(r, "verify_parent"), \
                patch.object(r, "verify_timer_isolation"), patch.object(r, "verify_repair_receipt"), patch.object(r, "verify_existing_resource"), \
                patch.object(r, "configured_uuid", return_value="n"*24), patch.object(r.q, "verify_payload_stopped"):
            directory=root/"immutable-operations"; directory.mkdir()
            (directory/"commerce-resource-create.intent.json").write_bytes(r.canonical({"reference":artifact()["reference"]}))
            rpc=Mock(); rpc.exclusive_canary.return_value={"exclusive":True}
            rpc.api.side_effect=[self.parent_app(), {"docker_registry_image_name":"ghcr.io/artgurianov/flexperiment", "docker_registry_image_tag":"a"*64}]
            with self.assertRaisesRegex(r.Refusal, "CONFIGURATION_ARTIFACT_OR_AUTODEPLOY_DRIFT"):
                r.configure_delivery(rpc)
            self.assertTrue(all(call.args[0]=="GET" for call in rpc.api.call_args_list))

    def test_unknown_topology_refuses_before_post(self):
        for mutation in ("project", "environment", "destination"):
            rpc = Mock(); app = self.parent_app()
            if mutation == "project": app["environment"]["project"]["uuid"] = "p"*24
            if mutation == "environment": app["environment"]["name"] = "production"
            if mutation == "destination": app["destination"]["uuid"] = "p"*24
            rpc.api.return_value = app; rpc.exclusive_canary.return_value = {"exclusive": True}
            with self.subTest(mutation=mutation), patch.object(r, "verify_parent"), \
                    patch.object(r.q, "verify_payload_stopped"), patch.object(r, "verify_artifact"), \
                    patch.object(r, "once") as once, self.assertRaisesRegex(r.Refusal, "TOPOLOGY_DRIFT"):
                r.create_delivery(artifact(), rpc)
            once.assert_not_called()
            self.assertTrue(all(x.args[0] == "GET" for x in rpc.api.call_args_list))

    def test_writable_installation_directory_refuses_before_marker_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary); (root/"installation").mkdir(mode=0o755)
            with patch.object(r.q, "ERASURE_ROOT", root), patch.object(r.q, "json_file") as read, \
                    self.assertRaisesRegex(r.Refusal, "INSTALLATION_DIRECTORY_CUSTODY_DRIFT"):
                r.installation_custody(Mock(), "n"*24)
            read.assert_not_called()

    def test_concurrent_queue_unknown_response_refuses(self):
        for response in ({"deployments": [{"deployment_uuid": "active"}]}, {"unexpected": []}):
            rpc = Mock(); rpc.api.return_value = response
            with self.subTest(response=response), self.assertRaises(r.Refusal): r.no_queued_deployments(rpc, ())
        rpc.api.return_value = {"deployments": []}; r.no_queued_deployments(rpc, ())

    def test_parent_change_refuses_without_rewriting_history(self):
        with fixture() as (root, _, _, _):
            (root/"erasure-admission.json").write_bytes(b'unknown')
            rpc = Mock()
            with self.assertRaisesRegex(r.Refusal, "PARENT_JOURNAL_DRIFT_OR_REPLAY"): r.verify_parent(rpc)
            rpc.verify_requalified_admission.assert_not_called()
            self.assertEqual((root/"erasure-admission.json").read_bytes(), b'unknown')

    def test_backup_lookup_changed_source_app_refuses(self):
        with fixture() as (root, manifest, _, _), patch.object(r, "verify_release"), patch.object(r, "observe"):
            (root/"deploy-config.json").write_bytes(r.canonical({"apps": {"canary": "unknown", "production": "p"*24}}))
            with self.assertRaisesRegex(r.Refusal, "OWNER_CONFIG_REPLAY_OR_DRIFT"): r.adopt_delivery(manifest, Mock())
            self.assertFalse((root/"deploy-config.json.immutable-pending").exists())


class Durability(unittest.TestCase):
    def test_journal_parent_and_archives_preserved_no_replay(self):
        with fixture() as (root, manifest, old, _), patch.object(r, "verify_release"), \
                patch.object(r.q, "merchant_write_barrier", return_value=contextlib.nullcontext()), \
                patch.object(r, "verify_live", return_value=old):
            rpc = Mock()
            sha = r.publish(manifest, rpc)
            archived = root / "erasure-admission-history" / (r.q.digest(old) + ".json")
            self.assertEqual(archived.read_bytes(), old)
            self.assertNotEqual(json.loads(old)["imageId"], json.loads((root / "erasure-admission.json").read_bytes())["artifact"]["imageId"])
            self.assertEqual(sha, r.q.digest((root / "erasure-admission.json").read_bytes()))
            with self.assertRaisesRegex(r.Refusal, "REPLAY"): r.publish(manifest, rpc)

    def test_rename_failure_keeps_pending_and_intent(self):
        with fixture() as (root, manifest, old, _), patch.object(r, "verify_release"), \
                patch.object(r.q, "merchant_write_barrier", return_value=contextlib.nullcontext()), \
                patch.object(r, "verify_live", return_value=old), patch.object(r.os, "replace", side_effect=OSError("fault")):
            with self.assertRaises(OSError): r.publish(manifest, Mock())
            self.assertEqual((root / "erasure-admission.json").read_bytes(), old)
            self.assertTrue((root / "erasure-admission.json.immutable-pending").exists())
            self.assertTrue((root / "art337-immutable-publication.intent.json").exists())
            with self.assertRaisesRegex(r.Refusal, "REPLAY"): r.publish(manifest, Mock())

    def test_fsync_after_rename_uncertainty_preserves_new_and_parent(self):
        with fixture() as (root, manifest, old, _), patch.object(r, "verify_release"), \
                patch.object(r.q, "merchant_write_barrier", return_value=contextlib.nullcontext()), \
                patch.object(r, "verify_live", return_value=old):
            original = r.q.sync_directory
            def fault(path):
                if pathlib.Path(path) == root and (root / "erasure-admission.json").read_bytes() != old:
                    raise OSError("directory-fsync")
                return original(path)
            with patch.object(r.q, "sync_directory", side_effect=fault), self.assertRaises(OSError):
                r.publish(manifest, Mock())
            self.assertEqual((root / "erasure-admission.json").read_bytes(), r.candidate(manifest))
            self.assertFalse((root / "art337-immutable-publication.outcome.json").exists())
            self.assertEqual((root / "erasure-admission-history" / (r.q.digest(old)+".json")).read_bytes(), old)
            with self.assertRaises(r.Refusal): r.publish(manifest, Mock())

    def test_uncertain_api_never_retried_and_reconcile_read_only(self):
        with fixture() as (root, _, _, _):
            # Test directory ownership checks with actual root in CI; Mac's UID is
            # replaced only on this private test directory, never owner files.
            original = pathlib.Path.lstat
            def local_stat(path, **kw):
                info = original(path, **kw)
                if pathlib.Path(path) == root / "immutable-operations":
                    return type("Stat", (), {"st_uid": 0, "st_mode": info.st_mode})()
                return info
            action = Mock(side_effect=TimeoutError("uncertain"))
            with patch.object(pathlib.Path, "lstat", new=local_stat):
                with self.assertRaises(TimeoutError): r.once("deploy", {"sha": "x"}, action)
                with self.assertRaisesRegex(r.Refusal, "REPLAY"): r.once("deploy", {"sha": "x"}, action)
                result = r.reconcile("deploy")
                self.assertEqual(result["state"], "HOLD")
                self.assertIsNone(result["outcomeSha256"])
            self.assertEqual(action.call_count, 1)

    def test_fsync_before_api_blocks_call(self):
        with fixture() as (root, _, _, _):
            directory = root / "immutable-operations"; directory.mkdir(mode=0o700)
            original = pathlib.Path.lstat
            def local_stat(path):
                info = original(path)
                if path == directory: return type("Stat", (), {"st_uid": 0, "st_mode": info.st_mode})()
                return info
            action = Mock()
            with patch.object(pathlib.Path, "lstat", new=local_stat), \
                    patch.object(r.q.os, "fsync", side_effect=OSError("fsync")), self.assertRaises(OSError):
                r.once("deploy", {"request": "isolated"}, action)
            action.assert_not_called()
            self.assertTrue((directory / "deploy.intent.json").exists())

    def test_outcome_fsync_after_api_keeps_intent_and_refuses_replay(self):
        with fixture() as (root, _, _, _):
            directory = root / "immutable-operations"; directory.mkdir(mode=0o700)
            original = pathlib.Path.lstat
            def local_stat(path):
                info = original(path)
                if path == directory: return type("Stat", (), {"st_uid": 0, "st_mode": info.st_mode})()
                return info
            create = r.q.atomic_create
            def fail_outcome(path, data):
                create(path, data)
                if path.name.endswith("outcome.json"): raise OSError("outcome-fsync-unknown")
            action = Mock(return_value={"deployment": "isolated-id"})
            with patch.object(pathlib.Path, "lstat", new=local_stat), patch.object(r.q, "atomic_create", side_effect=fail_outcome):
                with self.assertRaises(OSError): r.once("deploy", {"request": "isolated"}, action)
                with self.assertRaises(r.Refusal): r.once("deploy", {"request": "isolated"}, action)
            self.assertEqual(action.call_count, 1)
            self.assertTrue((directory / "deploy.intent.json").exists())
            self.assertTrue((directory / "deploy.outcome.json").exists())


if __name__ == "__main__": unittest.main()
