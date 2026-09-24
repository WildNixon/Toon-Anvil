"""The PDF splitter's own quality gate, run without a server in the way.

split_pdf.selftest() already exists and the gym fetches it over HTTP. That
put the Python pipeline behind the same door as the app - but only when a
browser was open. Here it runs on its own, so a change to the splitter fails
the same way a change to the server does.
"""
from __future__ import annotations

import unittest

from tests._harness import ROOT   # noqa: F401  (puts tools/ on the path)
import split_pdf


class SplitSelfTest(unittest.TestCase):
    def test_every_case_holds(self):
        result = split_pdf.selftest()
        failed = [c for c in result.get("cases", []) if not c["ok"]]
        self.assertTrue(result.get("ok"),
                        "\n".join(f"{c['name']}: {c.get('note', '')}" for c in failed))
        # A self-test that asserts nothing is the oldest way to report green.
        self.assertGreaterEqual(len(result["cases"]), 20)


class Classify(unittest.TestCase):
    """The signatures the splitter routes by, one block each."""

    def block(self, title, body):
        return {"title": title, "body": body, "text": f"{title}\n{body}"}

    def test_a_spell_is_a_spell(self):
        kind, conf, _ = split_pdf.classify(self.block(
            "Fire Bolt",
            "Evocation cantrip\nCasting Time: 1 action\nRange: 120 feet\n"
            "Components: V, S\nDuration: Instantaneous\nYou hurl a mote of fire."))
        self.assertEqual(kind, "spell")
        self.assertGreater(conf, 0.5)

    def test_a_feat_is_a_feat(self):
        kind, _, _ = split_pdf.classify(self.block(
            "Alert", "Prerequisite: None\nAlways on the lookout for danger, you gain "
                     "the following benefits."))
        self.assertEqual(kind, "feat")

    def test_a_magic_item_is_a_magic_item(self):
        kind, _, _ = split_pdf.classify(self.block(
            "Ring of Protection",
            "Ring, rare (requires attunement)\nYou gain a +1 bonus to AC and saving "
            "throws while wearing this ring."))
        self.assertEqual(kind, "magic_item")

    def test_prose_is_not_content(self):
        kind, conf, _ = split_pdf.classify(self.block(
            "Introduction", "Welcome to the campaign setting. This book describes "
                            "the lands beyond the sea and the people who live there."))
        self.assertNotIn(kind, ("spell", "feat", "magic_item", "monster", "species"))


if __name__ == "__main__":
    unittest.main()
