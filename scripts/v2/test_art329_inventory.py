import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from art329_inventory import GROUPS, PENDING_STATES, inventory, snapshot  # noqa: E402


class InventoryTest(unittest.TestCase):
    def test_customer_without_orders_never_proves_zero_and_redacts_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "commerce.sqlite"
            with sqlite3.connect(path) as db:
                for table in sorted(set().union(*GROUPS["commerce"].values())):
                    columns = "lineage TEXT" if table == "schema_identity" else "id TEXT"
                    pending = PENDING_STATES["commerce"].get(table)
                    if pending:
                        columns += f", \"{pending[0]}\" TEXT"
                    if table == "customers":
                        columns += ", email TEXT, secret TEXT"
                    db.execute(f'CREATE TABLE "{table}" ({columns})')
                db.execute("INSERT INTO schema_identity VALUES (?)", ("flexperiment-v2",))
                db.commit()
                empty = inventory(path, "commerce")
                self.assertEqual(empty["decision"], "OWNER_REVIEW_PENDING")
                self.assertEqual(empty["nonempty_owner_review_tables"], 0)
                self.assertEqual(empty["missing_expected_tables"], [])
                self.assertEqual(empty["schema_gaps"], [])
                db.execute(
                    "INSERT INTO customers (email, secret) VALUES (?, ?)",
                    ("private@example.test", "top-secret-value"),
                )
                db.commit()
            result = inventory(path, "commerce")
            self.assertEqual(result["decision"], "STOP_REVIEW_REQUIRED")
            self.assertEqual(result["nonempty_owner_review_tables"], 1)
            self.assertEqual(result["missing_expected_tables"], [])
            self.assertEqual(result["schema_gaps"], [])
            self.assertEqual(next(x for x in result["tables"] if x["table"] == "orders")["count"], 0)
            self.assertEqual(next(x for x in result["tables"] if x["table"] == "customers")["count"], 1)
            rendered = json.dumps(result)
            self.assertNotIn("private@example.test", rendered)
            self.assertNotIn("top-secret-value", rendered)

    def test_snapshot_is_consistent_with_wal_and_keeps_source_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.sqlite"
            target = Path(directory) / "snapshot.sqlite"
            db = sqlite3.connect(source)
            try:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE schema_identity (lineage TEXT)")
                db.execute("INSERT INTO schema_identity VALUES (?)", ("flexperiment-v2",))
                db.execute("CREATE TABLE customers (email TEXT)")
                db.execute("INSERT INTO customers VALUES (?)", ("private@example.test",))
                db.commit()
                metadata = snapshot(source, target)
                self.assertEqual(metadata["integrity_check"], "ok")
                self.assertEqual(metadata["source_before"], metadata["source_after"])
                self.assertEqual(inventory(target, "commerce")["decision"], "STOP_REVIEW_REQUIRED")
                self.assertEqual(target.stat().st_mode & 0o777, 0o400)
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
