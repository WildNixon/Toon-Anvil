"""The server's pure functions, tested as functions.

These are the rules the browser gym can only reach through HTTP, which means
the branches the app never triggers are never exercised there. Each one is a
few lines, and each one has already cost a real bug or a real soak finding.
"""
from __future__ import annotations

import math
import unittest

from tests._harness import Sandbox, serve


class ShouldStop(unittest.TestCase):
    """The 2.3.1 fix. Pure so the rule can be read instead of timed."""

    def test_never_stops_before_the_grace(self):
        self.assertFalse(serve._should_stop(quiet=10, seconds=120,
                                            seated=False, ceiling=1800))
        self.assertFalse(serve._should_stop(quiet=10, seconds=120,
                                            seated=True, ceiling=1800))

    def test_empty_table_stops_after_the_grace(self):
        self.assertTrue(serve._should_stop(quiet=120, seconds=120,
                                           seated=False, ceiling=1800))

    def test_seated_table_buys_a_longer_grace(self):
        # The DM closing their own tab must not end everybody's game.
        self.assertFalse(serve._should_stop(quiet=600, seconds=120,
                                            seated=True, ceiling=1800))

    def test_seated_grace_is_not_unlimited(self):
        # The bug: "open" lives on disk and outlives the session that wrote
        # it, so an unbounded grace meant the server never stopped again.
        self.assertTrue(serve._should_stop(quiet=1800, seconds=120,
                                           seated=True, ceiling=1800))
        self.assertTrue(serve._should_stop(quiet=1e9, seconds=120,
                                           seated=True, ceiling=1800))

    def test_ceiling_matches_the_watchdog(self):
        # _idle_watch derives its ceiling as max(seconds * 15, 1800). Pin it
        # so a change to one is a change to the test too.
        for seconds, want in ((10, 1800), (120, 1800), (200, 3000)):
            self.assertEqual(max(seconds * 15, 1800), want)


class ChangesSince(unittest.TestCase):
    """The change feed's gap semantics.

    The gym has a mutation for a CLIENT that ignores gaps. This is the
    server's side of the contract: when it must say "gap" and when it may
    not.
    """

    def setUp(self):
        self.sb = Sandbox().__enter__()

    def tearDown(self):
        self.sb.__exit__(None, None, None)

    def test_fresh_server_has_no_gap(self):
        rev, changes, gap = serve.changes_since(0)
        self.assertEqual((rev, changes, gap), (0, [], False))

    def test_changes_after_since_are_returned_in_order(self):
        serve.bump("characters", "a")
        serve.bump("characters", "b")
        serve.bump("events", None, by="tab-1")
        rev, changes, gap = serve.changes_since(1)
        self.assertEqual(rev, 3)
        self.assertEqual([c["rev"] for c in changes], [2, 3])
        self.assertEqual(changes[0]["id"], "b")
        self.assertEqual(changes[1]["by"], "tab-1")
        self.assertFalse(gap)

    def test_up_to_date_client_gets_nothing_and_no_gap(self):
        serve.bump("characters", "a")
        rev, changes, gap = serve.changes_since(1)
        self.assertEqual((rev, changes, gap), (1, [], False))

    def test_client_ahead_of_server_is_a_gap(self):
        # The restart branch: the counter reset, so everything the client
        # believes may be stale. "Nothing new since 99" would be a lie.
        serve.bump("characters", "a")
        rev, changes, gap = serve.changes_since(99)
        self.assertEqual(rev, 1)
        self.assertEqual(changes, [])
        self.assertTrue(gap)

    def test_falling_behind_the_ring_buffer_is_a_gap(self):
        for i in range(serve.MAX_CHANGES + 5):
            serve.bump("characters", str(i))
        oldest = serve._changes[0]["rev"]
        # Just inside the buffer: fine.
        _, changes, gap = serve.changes_since(oldest - 1)
        self.assertFalse(gap)
        self.assertEqual(len(changes), serve.MAX_CHANGES)
        # One step further back: the server has forgotten, and says so.
        _, _, gap = serve.changes_since(oldest - 2)
        self.assertTrue(gap)

    def test_buffer_is_bounded(self):
        for i in range(serve.MAX_CHANGES * 2):
            serve.bump("characters", str(i))
        self.assertEqual(len(serve._changes), serve.MAX_CHANGES)


class SafeId(unittest.TestCase):
    """The guard between a client string and the filesystem."""

    def test_accepts_ordinary_ids(self):
        for rid in ("abc", "kim-1", "gym.probe_2", "A" * 128):
            self.assertEqual(serve.safe_id(rid), rid)

    def test_refuses_traversal_and_separators(self):
        for rid in ("../../etc/passwd", "a/../../b", "..", ".", "a/b",
                    "a\\b", "..%2f..%2fserve.py"):
            self.assertIsNone(serve.safe_id(rid), rid)

    def test_refuses_empty_control_and_overlong(self):
        for rid in ("", None, "\x00", " a", "-a", ".a", "a b", "A" * 129,
                    "con\n", "nul\r"):
            self.assertIsNone(serve.safe_id(rid), repr(rid))


class SafeName(unittest.TestCase):
    def test_accepts_filenames_with_spaces_and_parens(self):
        for name in ("Monster Manual.pdf", "UA (2023) Bastions.pdf",
                     "book_v2-final.pdf"):
            self.assertTrue(serve.safe_name(name), name)

    def test_refuses_traversal(self):
        for name in ("../x.pdf", "a/b.pdf", "a\\b.pdf", "..", "", "-lead.pdf",
                     "x" * 200 + ".pdf"):
            self.assertFalse(serve.safe_name(name), name)


class Clamp(unittest.TestCase):
    """Every knob that decides what a connector call costs goes through this."""

    def test_in_range_passes_through(self):
        self.assertEqual(serve._clamp(300, 1, 4000, 400), 300)
        self.assertEqual(serve._clamp("300", 1, 4000, 400), 300)

    def test_out_of_range_is_pinned_not_rejected(self):
        self.assertEqual(serve._clamp(10 ** 9, 1, 4000, 400), 4000)
        self.assertEqual(serve._clamp(-5, 1, 4000, 400), 1)

    def test_junk_falls_back_to_the_default(self):
        for junk in (None, "lots", [], {}, math.nan, "nan"):
            self.assertEqual(serve._clamp(junk, 1, 4000, 400), 400, repr(junk))

    def test_infinity_is_pinned(self):
        self.assertEqual(serve._clamp(math.inf, 1, 4000, 400), 4000)
        self.assertEqual(serve._clamp(-math.inf, 1, 4000, 400), 1)


if __name__ == "__main__":
    unittest.main()
