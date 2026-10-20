"""The owner's storefront switch host tool (ART-319). Docker is replaced by a recorded fake."""
import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

spec = importlib.util.spec_from_file_location("storefront_switch", Path(__file__).with_name("storefront-switch.py"))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

META = ["--by", "owner", "--reason", "synthetic test change", "--evidence", "ART-319"]


class FakeDocker:
    """The container as the tool sees it: owner-cli JSON, docker inspect, the runtime write probe."""

    def __init__(self, layout):
        self.layout, self.calls = layout, []
        self.ready, self.failures = True, []
        self.readback = "MIRROR"  # MIRROR | STALE | FAIL
        self.mount_rw, self.probe = False, "EROFS"

    def __call__(self, argv, **_kwargs):
        self.calls.append(argv)
        out = lambda body, code=0: subprocess.CompletedProcess(argv, code, json.dumps(body).encode(), b"")
        if argv[:2] == ["docker", "inspect"]:
            return out([{"Mounts": [
                {"Type": "bind", "Source": self.layout.directory, "Destination": tool.MOUNT_TARGET, "RW": self.mount_rw},
                {"Type": "bind", "Source": self.layout.journal_directory, "Destination": tool.JOURNAL_MOUNT_TARGET, "RW": False}]}])
        if argv[:2] == ["docker", "exec"] and "-e" in argv:
            return out({"uid": 1000, **{tag + "." + k: self.probe for tag in ["switch", "journal"]
                                        for k in ["overwrite", "append", "create", "remove", "rename", "chmod"]}})
        command = argv[-2:] if argv[-2] in ("status",) else argv[-3:]
        if command[:2] == ["storefront-switch", "preflight"]:
            return out({"storefront": command[2], "ready": self.ready, "failures": self.failures})
        if argv[-2:] == ["storefront-switch", "status"]:
            if self.readback == "FAIL":
                return out({}, 1)
            current, _ = self.layout.current()
            if not current:
                return out({"state": "UNAVAILABLE"})
            return out({"state": "READ", "scope": self.layout.scope, "generation": current[0]["generation"] - (1 if self.readback == "STALE" else 0),
                        "documentSha256": current[1]})
        raise AssertionError(argv)


class StorefrontSwitchTool(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.temp.name, "flexperiment-sales-canary")
        self.layout = tool.Layout(self.root, "canary", os.getuid())
        self.docker = FakeDocker(self.layout)

    def tearDown(self):
        for directory in (self.layout.directory, self.layout.journal_directory):
            if os.path.isdir(directory):
                os.chmod(directory, 0o755)
        self.temp.cleanup()

    def run_tool(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = tool.main([argv[0], "--scope", "canary", "--root", self.root, *argv[1:]], runner=self.docker, owner_uid=os.getuid())
        return code, json.loads(out.getvalue() or err.getvalue())

    def document(self):
        return json.loads(Path(self.layout.file).read_text())

    def journal(self):
        return [json.loads(line) for line in Path(self.layout.journal).read_text().splitlines() if line.startswith("{")]

    def tamper(self, path, data, append=False):
        """Change a host file the way a restore, a crash or a disk fault would: outside the tool."""
        folder = os.path.dirname(path)
        os.chmod(folder, 0o755)
        os.chmod(path, 0o644)
        with open(path, "ab" if append else "wb") as target:
            target.write(data)
        os.chmod(path, 0o444)
        os.chmod(folder, 0o555)

    def test_install_writes_a_closed_root_owned_read_only_layout(self):
        code, result = self.run_tool("install", *META)
        self.assertEqual(code, 0)
        self.assertEqual(result["storefronts"], {"COURSES": {"state": "CLOSED"}, "LAB": {"state": "CLOSED"}})
        self.assertEqual(result["mounts"], [self.layout.directory + ":/etc/flexperiment-sales:ro",
                                            self.layout.journal_directory + ":/etc/flexperiment-sales-journal:ro"])
        for path, mode in [(self.layout.directory, 0o555), (self.layout.file, 0o444),
                           (self.layout.journal_directory, 0o555), (self.layout.journal, 0o444)]:
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), mode, path)
        self.assertEqual(self.document()["generation"], 1)
        self.assertEqual(self.run_tool("install", *META), (1, {"result": "REFUSED", "code": "SWITCH_ALREADY_INSTALLED"}))

    def test_open_requires_preflight_and_a_runtime_readback(self):
        self.run_tool("install", *META)
        self.docker.ready, self.docker.failures = False, ["FISCAL_POLICY_NOT_QUALIFIED"]
        code, refused = self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)
        self.assertEqual((code, refused["code"]), (1, "SWITCH_PREFLIGHT_REFUSED:FISCAL_POLICY_NOT_QUALIFIED"))
        self.assertEqual(self.document()["generation"], 1)
        self.docker.ready, self.docker.failures = True, []
        code, opened = self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)
        self.assertEqual(code, 0)
        self.assertEqual(opened["storefronts"], {"COURSES": {"state": "OPEN", "openSince": 2}, "LAB": {"state": "CLOSED"}})
        self.assertEqual(opened["runtime"]["generation"], 2)
        self.assertEqual(self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)[1]["code"], "SWITCH_ALREADY_OPEN")

    def test_an_opening_the_runtime_does_not_read_back_is_closed_again(self):
        self.run_tool("install", *META)
        self.docker.readback = "STALE"
        code, result = self.run_tool("open", "--storefront", "LAB", "--container", "commerce", *META)
        self.assertEqual((code, result["code"]), (1, "SWITCH_OPEN_ROLLED_BACK"))
        self.assertEqual(self.document()["storefronts"]["LAB"], {"state": "CLOSED"})
        self.assertEqual(self.document()["generation"], 3)

    def test_close_needs_no_container_and_works_whatever_the_file_says(self):
        self.run_tool("install", *META)
        self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)
        calls = len(self.docker.calls)
        code, closed = self.run_tool("close", "--storefront", "ALL", *META)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.docker.calls), calls)
        self.assertEqual(closed["storefronts"], {"COURSES": {"state": "CLOSED"}, "LAB": {"state": "CLOSED"}})
        # A damaged, then a deleted file: the next stop still writes a fresh, never reused generation.
        self.tamper(self.layout.file, b"{")
        code, repaired = self.run_tool("close", "--storefront", "LAB", *META)
        self.assertEqual((code, repaired["previousFile"], repaired["generation"]), (0, "SWITCH_DOCUMENT_INVALID", 4))
        self.assertEqual(stat.S_IMODE(os.stat(self.layout.directory).st_mode), 0o555)
        os.chmod(self.layout.directory, 0o755)
        os.unlink(self.layout.file)
        code, recreated = self.run_tool("close", "--storefront", "COURSES", *META)
        self.assertEqual((code, recreated["previousFile"], recreated["generation"]), (0, "SWITCH_FILE_MISSING", 5))
        self.assertEqual(recreated["storefronts"], {"COURSES": {"state": "CLOSED"}, "LAB": {"state": "CLOSED"}})
        self.assertEqual([row["generation"] for row in self.journal()], [1, 2, 3, 4, 5])

    def test_close_reports_but_never_depends_on_the_runtime(self):
        self.run_tool("install", *META)
        self.docker.readback = "FAIL"
        code, closed = self.run_tool("close", "--storefront", "ALL", "--container", "commerce", *META)
        self.assertEqual(code, 0)
        self.assertEqual(closed["runtime"], {"readback": "UNAVAILABLE", "code": "CONTAINER_COMMAND_FAILED"})
        self.assertEqual(self.document()["generation"], 2)

    def test_min_generation_steps_over_what_the_runtime_has_already_seen(self):
        code, result = self.run_tool("close", "--storefront", "ALL", "--min-generation", "41", *META)
        self.assertEqual((code, result["generation"]), (0, 42))

    def test_reopening_starts_a_new_opening(self):
        self.run_tool("install", *META)
        self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)
        self.run_tool("close", "--storefront", "COURSES", *META)
        code, reopened = self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)
        self.assertEqual((code, reopened["storefronts"]["COURSES"]), (0, {"state": "OPEN", "openSince": 4}))

    def test_changes_require_actor_reason_and_evidence_issue(self):
        for meta in (["--by", "Owner Name", "--reason", "x" * 5, "--evidence", "ART-1"],
                     ["--by", "owner", "--reason", "no", "--evidence", "ART-1"],
                     ["--by", "owner", "--reason", "valid reason", "--evidence", "LIN-1"]):
            self.assertEqual(self.run_tool("close", "--storefront", "ALL", *meta)[1]["code"], "SWITCH_CHANGE_EVIDENCE_REQUIRED")
        self.assertFalse(os.path.exists(self.layout.directory))

    def test_verify_proves_a_read_only_mount_and_no_runtime_writer(self):
        self.run_tool("install", *META)
        code, verified = self.run_tool("verify", "--container", "commerce")
        self.assertEqual(code, 0)
        self.assertEqual(verified["runtimeWriteAttempts"]["journal.append"], "EROFS")
        self.docker.mount_rw = True
        self.assertEqual(self.run_tool("verify", "--container", "commerce")[1]["code"], "SWITCH_MOUNT_NOT_READ_ONLY")
        self.docker.mount_rw, self.docker.probe = False, "WRITTEN"
        self.assertEqual(self.run_tool("verify", "--container", "commerce")[1]["code"], "SWITCH_WRITABLE_FROM_RUNTIME")

    def test_a_switch_restored_without_its_journal_is_refused_until_a_new_close(self):
        # Review P1-1: generation 2 OPEN, then a stop at 3; the switch file comes back as the generation 2
        # copy while the journal still ends at 3. Neither the tool nor the runtime admits it.
        self.run_tool("install", *META)
        self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)
        opened = Path(self.layout.file).read_bytes()
        self.run_tool("close", "--storefront", "ALL", *META)
        self.tamper(self.layout.file, opened)
        current, problem = self.layout.current()
        self.assertEqual((current, problem), (None, "SWITCH_JOURNAL_MISMATCH"))
        self.assertEqual(self.run_tool("status")[1]["storefronts"]["COURSES"], {"state": "CLOSED"})
        code, refused = self.run_tool("open", "--storefront", "LAB", "--container", "commerce", *META)
        self.assertEqual((code, refused["code"]), (1, "SWITCH_CURRENT_FILE_REQUIRED:SWITCH_JOURNAL_MISMATCH"))
        code, closed = self.run_tool("close", "--storefront", "ALL", *META)
        self.assertEqual((code, closed["previousFile"], closed["generation"]), (0, "SWITCH_JOURNAL_MISMATCH", 4))
        self.assertEqual(self.layout.current()[1], None)

    def test_a_journal_restored_without_its_switch_is_refused(self):
        self.run_tool("install", *META)
        journal = Path(self.layout.journal).read_bytes()
        self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)
        self.tamper(self.layout.journal, journal)
        self.assertEqual(self.layout.current(), (None, "SWITCH_JOURNAL_MISMATCH"))

    def test_close_works_over_a_damaged_last_journal_line_while_the_switch_is_open(self):
        # Review P1-2: a valid OPEN switch and a garbage last journal record must not block the stop.
        self.run_tool("install", *META)
        self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)
        self.tamper(self.layout.journal, b'{"generation": 2, "sha2', append=True)  # torn append
        code, closed = self.run_tool("close", "--storefront", "ALL", *META)
        self.assertEqual(code, 0)
        self.assertEqual((closed["generation"], closed["journalProblems"]), (3, ["JOURNAL_PARTIAL_TAIL"]))
        self.assertEqual(self.document()["storefronts"]["COURSES"], {"state": "CLOSED"})
        self.tamper(self.layout.journal, b"not json at all\n", append=True)  # complete but garbage
        code, closed = self.run_tool("close", "--storefront", "ALL", *META)
        self.assertEqual(code, 0)
        self.assertEqual(closed["generation"], 4)
        self.assertIn("JOURNAL_LINE_INVALID:5", closed["journalProblems"])
        records, last, _ = self.layout.journal_records()
        self.assertEqual(([r["generation"] for r in records], last["generation"]), ([1, 2, 3, 4], 4))
        self.assertEqual(self.layout.current()[1], None)

    def test_a_journal_record_needs_the_switch_generation_and_a_positive_one(self):
        self.run_tool("install", *META)
        digest = hashlib.sha256(Path(self.layout.file).read_bytes()).hexdigest()
        self.tamper(self.layout.journal, (json.dumps({"generation": 5, "sha256": digest}) + "\n").encode(), append=True)
        self.assertEqual(self.layout.current(), (None, "SWITCH_JOURNAL_MISMATCH"))
        self.tamper(self.layout.journal, (json.dumps({"generation": True, "sha256": digest}) + "\n").encode(), append=True)
        self.assertEqual(self.layout.journal_records()[1], None)
        code, closed = self.run_tool("close", "--storefront", "ALL", *META)
        # Generation 5 was named in the journal, so the stop takes 6, never a number already used.
        self.assertEqual((code, closed["generation"]), (0, 6))

    def test_close_moves_a_journal_that_is_not_a_file_aside_and_never_reuses_a_generation(self):
        self.run_tool("install", *META)
        self.run_tool("open", "--storefront", "COURSES", "--container", "commerce", *META)
        os.chmod(self.layout.journal_directory, 0o755)
        os.chmod(self.layout.journal, 0o644)
        os.unlink(self.layout.journal)
        os.mkdir(self.layout.journal)
        os.chmod(self.layout.journal_directory, 0o555)
        code, closed = self.run_tool("close", "--storefront", "ALL", *META)
        # The switch file still says 2, so the stop is 3 even though the journal history is gone.
        self.assertEqual((code, closed["generation"], closed["journalProblems"]), (0, 3, ["JOURNAL_NOT_A_FILE"]))
        self.assertEqual(len([n for n in os.listdir(self.layout.journal_directory) if n.startswith("journal.jsonl.damaged-")]), 1)
        self.assertEqual(self.layout.current()[1], None)

    def test_status_reports_closed_for_a_missing_file(self):
        code, status = self.run_tool("status")
        self.assertEqual((code, status["file"], status["storefronts"]["COURSES"]), (0, "SWITCH_FILE_MISSING", {"state": "CLOSED"}))


if __name__ == "__main__":
    unittest.main()
