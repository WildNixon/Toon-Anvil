"""The shelf's book detector. Pure and deterministic, per its own docstring."""
from __future__ import annotations

import unittest

from tests._harness import ROOT   # noqa: F401  (puts tools/ on the path)
import shelf


def pages(*texts, start=1):
    return [(start + i, t) for i, t in enumerate(texts)]


class FilenameRules(unittest.TestCase):
    def test_first_stage_is_the_filename(self):
        for name, want in (("DDAL07-01 A City on the Edge.pdf", "adventures"),
                           ("Plane_Shift_Zendikar.pdf", "settings"),
                           ("Monster Manual.pdf", "bestiaries"),
                           ("Tome of Beasts 2.pdf", "bestiaries"),
                           ("UA_Waterborne.pdf", "options"),
                           ("Unearthed Arcana Bastions.pdf", "options"),
                           ("Players Companion.pdf", "options")):
            cat, conf, why = shelf.detect_book(name, "")
            self.assertEqual(cat, want, name)
            self.assertGreaterEqual(conf, 0.85)
            self.assertTrue(why and "filename" in why[0])

    def test_filename_rule_beats_the_text(self):
        text = "gazetteer the world of the pantheon geography " * 3
        cat, _, _ = shelf.detect_book("Monster Manual.pdf", text)
        self.assertEqual(cat, "bestiaries")


class ContentScoring(unittest.TestCase):
    def test_a_setting_reads_as_a_setting(self):
        text = ("Gazetteer. The world of Ur is old. The pantheon has nine deities. "
                "Its people and their cultures span three nations. Geography.")
        cat, conf, why = shelf.detect_book("book.pdf", text)
        self.assertEqual(cat, "settings")
        self.assertGreater(conf, 0.4)
        self.assertTrue(any("gazetteer" in w for w in why))

    def test_an_adventure_reads_as_an_adventure(self):
        text = ("An adventure for characters of 3rd to 5th level. Read aloud the "
                "boxed text. A one-shot with three encounters. Adventurers League.")
        cat, _, _ = shelf.detect_book("book.pdf", text)
        self.assertEqual(cat, "adventures")

    def test_tabs_for_spaces_do_not_hide_a_phrase(self):
        # Some PDFs encode every space as a tab.
        text = "A\tRat\tQueens\tadventure\tfor\t3rd-level\tcharacters.\tread\taloud\tboxed\ttext"
        cat, _, _ = shelf.detect_book("book.pdf", text)
        self.assertEqual(cat, "adventures")

    def test_honest_unsorted_beats_a_confident_guess(self):
        cat, conf, why = shelf.detect_book("book.pdf", "Some notes about a game.")
        self.assertEqual(cat, "unsorted")
        self.assertEqual(conf, 0.0)
        self.assertTrue(why and "needs >=" in why[0])

    def test_a_tie_is_unsorted(self):
        text = "gazetteer pantheon read-aloud adventure for"
        cat, _, _ = shelf.detect_book("book.pdf", text)
        self.assertEqual(cat, "unsorted")

    def test_signal_counts_saturate(self):
        # A keyword counts at most five times, so a book that says "feats"
        # two hundred times scores exactly like one that says it five times.
        five = shelf.detect_book("book.pdf", "feats " * 5)
        stuffed = shelf.detect_book("book.pdf", "feats " * 200)
        self.assertEqual(five, stuffed)
        self.assertTrue(any("x5" in w for w in stuffed[2]), stuffed[2])


class BestiaryGate(unittest.TestCase):
    STATBLOCK = "Armor Class 12 Hit Points 22 Challenge 1 (200 XP)"

    def test_statblock_density_is_a_bestiary(self):
        cover = pages("Cover", "Contents", "Intro", "Intro", "Intro", "Intro")
        body = pages(*([self.STATBLOCK] * 4), start=7)
        cat, conf, why = shelf.detect_book("book.pdf", cover + body)
        self.assertEqual(cat, "bestiaries")
        self.assertEqual(conf, 0.80)
        self.assertIn("statblock density", why[0])

    def test_cover_matter_does_not_count_as_a_mid_page(self):
        # Four statblock pages, but all before page 7.
        cat, _, _ = shelf.detect_book("book.pdf", pages(*([self.STATBLOCK] * 4)))
        self.assertNotEqual(cat, "bestiaries")

    def test_a_module_with_a_monster_appendix_stays_an_adventure(self):
        adventure = ("An adventure for characters of 1st level. Read aloud. "
                     "Boxed text. Adventurers League. one-shot")
        body = pages(adventure, adventure, "x", "x", "x", "x")
        body += pages(*([self.STATBLOCK] * 4), start=7)
        cat, _, _ = shelf.detect_book("book.pdf", body)
        self.assertEqual(cat, "adventures")


class PageShapes(unittest.TestCase):
    def test_accepts_a_string_a_list_or_pairs(self):
        self.assertEqual(shelf._norm_pages("a"), [(1, "a")])
        self.assertEqual(shelf._norm_pages(["a", "b"]), [(1, "a"), (2, "b")])
        self.assertEqual(shelf._norm_pages([(9, "a"), [10, "b"]]), [(9, "a"), (10, "b")])


if __name__ == "__main__":
    unittest.main()
