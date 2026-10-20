#!/usr/bin/env python3
"""The owner's storefront switch (ART-319): the only writer of the host file Commerce reads.

Run as root on the VPS, over SSH. Commerce mounts <root>/switch read-only at /etc/flexperiment-sales
and reads switch.json on every admission (commerce-v2/src/storefront-switch.ts). Missing, invalid,
writable or older than a generation it has seen means CLOSED there, so:

  close    always works: Commerce down, unready, its database lost, or the file damaged. It never
           needs the container. A stop is in force as soon as this command has renamed the file.
  open     needs a valid current file, the container's preflight (legal release, qualified fiscal
           policies, PAYMENT_MODE=refref) and a read-back that the runtime sees the new generation.
  status   reads the host file and the journal; with --container, also the runtime's own view.
  verify   proves the container's mount is read-only and that its runtime user cannot change it.
  install  creates the layout with both storefronts CLOSED.

Every write gets the next generation (above everything the journal and the current file name, and
--min-generation), is appended to <root>/journal/journal.jsonl before it replaces the switch file by
an atomic rename inside <root>/switch. Both directories are mounted read-only into Commerce, which
admits the switch only while the journal's last complete record names the switch file's digest: a
switch file restored without its journal, or the reverse, is CLOSED. Nothing secret is written.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

SCHEMA = "flexperiment.storefront-switch/1"
STOREFRONTS = ("COURSES", "LAB")
FILE = "switch.json"
JOURNAL = "journal.jsonl"
MOUNT_TARGET = "/etc/flexperiment-sales"
JOURNAL_MOUNT_TARGET = "/etc/flexperiment-sales-journal"
MAX_BYTES = 4096
ACTOR = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
ISSUE = re.compile(r"^ART-[0-9]{1,6}$")
OWNER_CLI = ["node", "--import", "tsx", "commerce-v2/src/owner-cli.ts"]


class Refused(Exception):
    pass


def default_root(scope):
    return "/var/lib/flexperiment-sales-" + scope


def validate(document, scope):
    """The same rules as the runtime's schema; anything else is refused here before it is written."""
    keys = {"schema", "scope", "generation", "changedAt", "changedBy", "reason", "evidenceIssue", "storefronts"}
    if not isinstance(document, dict) or set(document) != keys or document["schema"] != SCHEMA or document["scope"] != scope:
        raise Refused("SWITCH_DOCUMENT_INVALID")
    generation = document["generation"]
    if not isinstance(generation, int) or isinstance(generation, bool) or not 1 <= generation <= 2 ** 53 - 1:
        raise Refused("SWITCH_DOCUMENT_INVALID")
    if not ACTOR.match(document["changedBy"]) or not ISSUE.match(document["evidenceIssue"]) \
            or not isinstance(document["reason"], str) or not 3 <= len(document["reason"].strip()) <= 500:
        raise Refused("SWITCH_DOCUMENT_INVALID")
    try:
        datetime.datetime.fromisoformat(document["changedAt"].replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        raise Refused("SWITCH_DOCUMENT_INVALID")
    storefronts = document["storefronts"]
    if not isinstance(storefronts, dict) or set(storefronts) != set(STOREFRONTS):
        raise Refused("SWITCH_DOCUMENT_INVALID")
    for state in storefronts.values():
        if state == {"state": "CLOSED"}:
            continue
        since = state.get("openSince") if isinstance(state, dict) else None
        if not isinstance(state, dict) or set(state) != {"state", "openSince"} or state["state"] != "OPEN" \
                or not isinstance(since, int) or isinstance(since, bool) or not 1 <= since <= generation:
            raise Refused("SWITCH_DOCUMENT_INVALID")
    return document


def encode(document):
    raw = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf8")
    if len(raw) > MAX_BYTES:
        raise Refused("SWITCH_DOCUMENT_TOO_LARGE")
    return raw


def owned_directory(path, owner_uid):
    """Create or repair a root-owned 0555 directory (the layout the runtime admits)."""
    if not os.path.lexists(path):
        os.mkdir(path, 0o555)
    if os.path.islink(path) or not os.path.isdir(path):
        raise Refused("SWITCH_DIRECTORY_INVALID")
    if os.geteuid() == 0:
        os.chown(path, 0, 0)
    os.chmod(path, 0o555)


@contextlib.contextmanager
def writable(path):
    # Root writes through 0555/0444 as they are; only an unprivileged test owner needs the bit.
    if os.geteuid() == 0:
        yield
        return
    mode = stat.S_IMODE(os.lstat(path).st_mode)
    os.chmod(path, mode | 0o200)
    try:
        yield
    finally:
        os.chmod(path, mode)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Layout:
    """<root>/switch/switch.json and <root>/journal/journal.jsonl, each directory mounted read-only.

    The runtime admits the switch only while the journal's last complete record names exactly the
    switch file's digest: restoring either path without the other (an older switch over a newer
    stop, or the reverse) is CLOSED. The journal is append-only; a generation is never reused.
    """

    def __init__(self, root, scope, owner_uid=0):
        self.root, self.scope, self.owner_uid = root, scope, owner_uid
        self.directory = os.path.join(root, "switch")
        self.file = os.path.join(self.directory, FILE)
        self.journal_directory = os.path.join(root, "journal")
        self.journal = os.path.join(self.journal_directory, JOURNAL)

    def _admitted(self, path, mode, kind):
        info = os.lstat(path)
        return kind(info.st_mode) and info.st_uid == self.owner_uid and stat.S_IMODE(info.st_mode) == mode \
            and (kind is stat.S_ISDIR or info.st_nlink == 1), info

    def journal_records(self):
        """Every parseable record, the last complete record (or None) and what was skipped. Never raises
        on content: a damaged journal must not stop an emergency close."""
        problems, records = [], []
        try:
            info = os.lstat(self.journal)
        except FileNotFoundError:
            return records, None, ["JOURNAL_MISSING"]
        if not stat.S_ISREG(info.st_mode):
            return records, None, ["JOURNAL_NOT_A_FILE"]
        with open(self.journal, "rb") as source:
            raw = source.read()
        complete, _, partial = raw.rpartition(b"\n")
        if partial:
            problems.append("JOURNAL_PARTIAL_TAIL")
        last = None
        for number, line in enumerate(complete.split(b"\n") if complete else [], start=1):
            try:
                record = json.loads(line)
                generation = record.get("generation") if isinstance(record, dict) else None
                if not isinstance(generation, int) or isinstance(generation, bool) or not 1 <= generation <= 2 ** 53 - 1 \
                        or not re.fullmatch(r"[0-9a-f]{64}", str(record.get("sha256", ""))):
                    raise ValueError
                records.append(record)
                last = record
            except ValueError:
                problems.append("JOURNAL_LINE_INVALID:%d" % number)
                last = None  # the runtime reads only the last complete line
        return records, last, problems

    def current(self):
        """The current switch if it is exactly what the runtime would admit, else None (with the reason)."""
        try:
            folder_ok, _ = self._admitted(self.directory, 0o555, stat.S_ISDIR)
            file_ok, record = self._admitted(self.file, 0o444, stat.S_ISREG)
            journal_folder_ok, _ = self._admitted(self.journal_directory, 0o555, stat.S_ISDIR)
            journal_ok, _ = self._admitted(self.journal, 0o444, stat.S_ISREG)
        except FileNotFoundError:
            return None, "SWITCH_FILE_MISSING"
        if not folder_ok or not journal_folder_ok:
            return None, "SWITCH_DIRECTORY_PERMISSIONS"
        if not file_ok or not journal_ok or not 0 < record.st_size <= MAX_BYTES:
            return None, "SWITCH_FILE_PERMISSIONS"
        with open(self.file, "rb") as source:
            raw = source.read()
        try:
            document = validate(json.loads(raw), self.scope)
        except (Refused, ValueError):
            return None, "SWITCH_DOCUMENT_INVALID"
        digest = hashlib.sha256(raw).hexdigest()
        _, last, _ = self.journal_records()
        if not last or last["sha256"] != digest or last["generation"] != document["generation"]:
            return None, "SWITCH_JOURNAL_MISMATCH"
        return (document, digest), None

    def generation_floor(self):
        """The highest generation anything on the host has ever named: never written again."""
        records, _, problems = self.journal_records()
        floor = max([r["generation"] for r in records] or [0])
        try:
            with open(self.file, "rb") as source:
                floor = max(floor, int(json.loads(source.read())["generation"]))
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return floor, problems

    @contextlib.contextmanager
    def locked(self):
        os.makedirs(self.root, mode=0o700, exist_ok=True)
        descriptor = os.open(os.path.join(self.root, ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    def ensure_layout(self):
        """A close repairs the layout: directories created, ownership and modes restored, a journal
        that is not a regular file moved aside (never deleted)."""
        owned_directory(self.directory, self.owner_uid)
        owned_directory(self.journal_directory, self.owner_uid)
        if os.path.lexists(self.journal) and not stat.S_ISREG(os.lstat(self.journal).st_mode):
            with writable(self.journal_directory):
                os.rename(self.journal, "%s.damaged-%d" % (self.journal, int(datetime.datetime.now().timestamp())))

    def append_journal(self, record):
        line = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf8")
        with writable(self.journal_directory):
            existing = os.path.lexists(self.journal)
            with writable(self.journal) if existing else contextlib.nullcontext():
                descriptor = os.open(self.journal, os.O_CREAT | os.O_RDWR | os.O_APPEND, 0o444)
                try:
                    size = os.fstat(descriptor).st_size
                    # A torn tail (crash mid-append) stays its own skipped line; the new record is whole.
                    if size and os.pread(descriptor, 1, size - 1) != b"\n":
                        os.write(descriptor, b"\n")
                    os.write(descriptor, line)
                    os.fsync(descriptor)
                    if os.geteuid() == 0:
                        os.fchown(descriptor, 0, 0)
                finally:
                    os.close(descriptor)
            os.chmod(self.journal, 0o444)
        fsync_directory(self.journal_directory)

    def write(self, document):
        validate(document, self.scope)
        raw = encode(document)
        digest = hashlib.sha256(raw).hexdigest()
        # The journal first: from here the old switch no longer matches it, so a crash before the
        # rename below leaves the runtime CLOSED, never on a generation the journal has passed.
        self.append_journal({"generation": document["generation"], "sha256": digest, "document": document})
        temporary = os.path.join(self.directory, ".%s.%d.tmp" % (FILE, os.getpid()))
        with writable(self.directory):
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o444)
            try:
                os.write(descriptor, raw)
                os.fsync(descriptor)
                if os.geteuid() == 0:
                    os.fchown(descriptor, 0, 0)
                os.fchmod(descriptor, 0o444)
            finally:
                os.close(descriptor)
            os.rename(temporary, self.file)
        fsync_directory(self.directory)
        read, problem = self.current()
        if not read or read[1] != digest:
            raise Refused("SWITCH_HOST_READBACK_FAILED:" + (problem or "DIGEST"))
        return digest


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def next_document(layout, current, changes, args):
    floor, _ = layout.generation_floor()
    generation = max(floor, args.min_generation or 0) + 1
    # A damaged or missing file says nothing about the other storefront: it stays CLOSED.
    previous = current[0]["storefronts"] if current else {name: {"state": "CLOSED"} for name in STOREFRONTS}
    storefronts = {}
    for name in STOREFRONTS:
        wanted = changes.get(name)
        if wanted == "CLOSED":
            storefronts[name] = {"state": "CLOSED"}
        elif wanted == "OPEN":
            storefronts[name] = previous[name] if previous[name]["state"] == "OPEN" else {"state": "OPEN", "openSince": generation}
        else:
            storefronts[name] = previous[name]
    return {"schema": SCHEMA, "scope": layout.scope, "generation": generation, "changedAt": now(),
            "changedBy": args.by, "reason": args.reason.strip(), "evidenceIssue": args.evidence, "storefronts": storefronts}


def container_command(container, argv, runner):
    result = runner(["docker", "exec", "-i", container] + OWNER_CLI + argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if result.returncode != 0:
        raise Refused("CONTAINER_COMMAND_FAILED")
    return json.loads(result.stdout)


def runtime_readback(layout, container, generation, digest, runner):
    view = container_command(container, ["storefront-switch", "status"], runner)
    if view.get("state") != "READ" or view.get("generation") != generation or view.get("documentSha256") != digest \
            or view.get("scope") != layout.scope:
        raise Refused("SWITCH_RUNTIME_READBACK_MISMATCH")
    return view


def require_meta(args):
    if not args.by or not ACTOR.match(args.by) or not args.reason or not 3 <= len(args.reason.strip()) <= 500 \
            or not args.evidence or not ISSUE.match(args.evidence):
        raise Refused("SWITCH_CHANGE_EVIDENCE_REQUIRED")


def command_install(layout, args, runner):
    require_meta(args)
    with layout.locked():
        if os.path.lexists(layout.directory) or os.path.lexists(layout.journal_directory):
            raise Refused("SWITCH_ALREADY_INSTALLED")
        layout.ensure_layout()
        document = next_document(layout, None, {name: "CLOSED" for name in STOREFRONTS}, args)
        digest = layout.write(document)
    return {"result": "INSTALLED", "generation": document["generation"], "sha256": digest, "storefronts": document["storefronts"],
            "mounts": ["%s:%s:ro" % (layout.directory, MOUNT_TARGET), "%s:%s:ro" % (layout.journal_directory, JOURNAL_MOUNT_TARGET)]}


def command_close(layout, args, runner):
    require_meta(args)
    targets = STOREFRONTS if args.storefront == "ALL" else (args.storefront,)
    with layout.locked():
        # Nothing below depends on the journal parsing: damaged lines are skipped and reported,
        # a torn tail is closed off, and the new record is appended whole.
        current, problem = layout.current()
        _, journal_problems = layout.generation_floor()
        layout.ensure_layout()
        document = next_document(layout, current, {name: "CLOSED" for name in targets}, args)
        digest = layout.write(document)
    result = {"result": "CLOSED", "generation": document["generation"], "sha256": digest, "storefronts": document["storefronts"],
              "previousFile": problem or "VALID", "journalProblems": journal_problems}
    # The stop already holds; the runtime read-back is evidence, never a condition of the stop.
    if args.container:
        try:
            result["runtime"] = runtime_readback(layout, args.container, document["generation"], digest, runner)
        except (Refused, ValueError, OSError, subprocess.SubprocessError) as error:
            result["runtime"] = {"readback": "UNAVAILABLE", "code": str(error) or type(error).__name__}
    return result


def command_open(layout, args, runner):
    require_meta(args)
    if args.storefront not in STOREFRONTS:
        raise Refused("SWITCH_STOREFRONT_INVALID")
    with layout.locked():
        current, problem = layout.current()
        if not current:
            raise Refused("SWITCH_CURRENT_FILE_REQUIRED:" + problem)
        if current[0]["storefronts"][args.storefront]["state"] == "OPEN":
            raise Refused("SWITCH_ALREADY_OPEN")
        preflight = container_command(args.container, ["storefront-switch", "preflight", args.storefront], runner)
        if preflight.get("storefront") != args.storefront or preflight.get("ready") is not True:
            raise Refused("SWITCH_PREFLIGHT_REFUSED:" + ",".join(preflight.get("failures") or ["UNKNOWN"]))
        document = next_document(layout, current, {args.storefront: "OPEN"}, args)
        digest = layout.write(document)
    try:
        view = runtime_readback(layout, args.container, document["generation"], digest, runner)
    except (Refused, ValueError, OSError, subprocess.SubprocessError):
        # An opening the runtime cannot be shown to hold is closed again at once.
        with layout.locked():
            current, _ = layout.current()
            layout.write(next_document(layout, current, {args.storefront: "CLOSED"}, argparse.Namespace(
                by=args.by, reason="Automatic close: runtime read-back of an opening failed", evidence=args.evidence, min_generation=None)))
        raise Refused("SWITCH_OPEN_ROLLED_BACK")
    return {"result": "OPEN", "generation": document["generation"], "sha256": digest, "storefronts": document["storefronts"],
            "preflight": preflight, "runtime": view}


def command_status(layout, args, runner):
    current, problem = layout.current()
    floor, journal_problems = layout.generation_floor()
    result = {"scope": layout.scope, "file": problem or "VALID", "highestGeneration": floor, "journalProblems": journal_problems,
              "storefronts": current[0]["storefronts"] if current else {name: {"state": "CLOSED"} for name in STOREFRONTS}}
    if current:
        result.update(generation=current[0]["generation"], sha256=current[1], changedAt=current[0]["changedAt"],
                      changedBy=current[0]["changedBy"], evidenceIssue=current[0]["evidenceIssue"])
    if args.container:
        result["runtime"] = container_command(args.container, ["storefront-switch", "status"], runner)
    return result


VERIFY_SCRIPT = r"""
const fs = require("node:fs"), path = require("node:path");
const result = { uid: process.getuid() };
for (const [dir, file] of [[process.argv[1], "switch.json"], [process.argv[2], "journal.jsonl"]]) {
  const target = path.join(dir, file), tag = file.split(".")[0];
  const attempts = {
    overwrite: () => fs.writeFileSync(target, "{}"),
    append: () => fs.appendFileSync(target, "{}\n"),
    create: () => fs.writeFileSync(path.join(dir, ".runtime-write"), "{}"),
    remove: () => fs.unlinkSync(target),
    rename: () => fs.renameSync(target, path.join(dir, "old")),
    chmod: () => fs.chmodSync(target, 0o666),
  };
  for (const [name, run] of Object.entries(attempts)) {
    try { run(); result[tag + "." + name] = "WRITTEN"; } catch (error) { result[tag + "." + name] = error.code || "ERROR"; }
  }
}
console.log(JSON.stringify(result));
"""


def command_verify(layout, args, runner):
    inspected = runner(["docker", "inspect", args.container], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if inspected.returncode != 0:
        raise Refused("CONTAINER_INSPECT_FAILED")
    for source, target in [(layout.directory, MOUNT_TARGET), (layout.journal_directory, JOURNAL_MOUNT_TARGET)]:
        mounts = [m for m in json.loads(inspected.stdout)[0]["Mounts"] if m.get("Destination") == target]
        if len(mounts) != 1 or mounts[0].get("Type") != "bind" or mounts[0].get("Source") != source or mounts[0].get("RW") is not False:
            raise Refused("SWITCH_MOUNT_NOT_READ_ONLY")
    attempt = runner(["docker", "exec", args.container, "node", "-e", VERIFY_SCRIPT, MOUNT_TARGET, JOURNAL_MOUNT_TARGET],
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if attempt.returncode != 0:
        raise Refused("RUNTIME_WRITE_PROBE_FAILED")
    probe = json.loads(attempt.stdout)
    if probe.get("uid") == 0 or any(value == "WRITTEN" for key, value in probe.items() if key != "uid"):
        raise Refused("SWITCH_WRITABLE_FROM_RUNTIME")
    current, problem = layout.current()
    if not current:
        raise Refused("SWITCH_CURRENT_FILE_REQUIRED:" + problem)
    view = runtime_readback(layout, args.container, current[0]["generation"], current[1], runner)
    return {"result": "VERIFIED", "mounts": [{"source": layout.directory, "target": MOUNT_TARGET, "readOnly": True},
                                             {"source": layout.journal_directory, "target": JOURNAL_MOUNT_TARGET, "readOnly": True}],
            "runtimeWriteAttempts": probe, "generation": current[0]["generation"], "sha256": current[1], "runtime": view}


COMMANDS = {"install": command_install, "close": command_close, "open": command_open, "status": command_status, "verify": command_verify}


def parse(argv):
    parser = argparse.ArgumentParser(prog="storefront-switch")
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument("--scope", required=True, choices=["canary", "production"])
    parser.add_argument("--root")
    parser.add_argument("--storefront", choices=list(STOREFRONTS) + ["ALL"])
    parser.add_argument("--by")
    parser.add_argument("--reason")
    parser.add_argument("--evidence")
    parser.add_argument("--container")
    parser.add_argument("--min-generation", type=int)
    args = parser.parse_args(argv)
    if args.command in ("open", "close") and not args.storefront:
        parser.error("--storefront is required")
    if args.command in ("open", "verify") and not args.container:
        parser.error("--container is required")
    return args


def main(argv=None, runner=subprocess.run, owner_uid=0):
    args = parse(sys.argv[1:] if argv is None else argv)
    layout = Layout(args.root or default_root(args.scope), args.scope, owner_uid)
    try:
        result = COMMANDS[args.command](layout, args, runner)
    except Refused as error:
        print(json.dumps({"result": "REFUSED", "code": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    if os.geteuid() != 0:
        print(json.dumps({"result": "REFUSED", "code": "ROOT_REQUIRED"}), file=sys.stderr)
        sys.exit(1)
    os.umask(0o077)
    sys.exit(main())
