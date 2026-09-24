"""The README's figures about the harness, checked against the harness.

Every number the README quoted about the gym was stale by a factor of two or
more when the coverage audit counted. A figure nobody enforces is a figure
that drifts, so the ones the README keeps are the ones a test can count from
the sources: suites, UI journeys, mutations, invariants. Scenario and check
counts change with every loop unrolled inside a scenario and are reported by
the gym itself on every run rather than written down.
"""
from __future__ import annotations

import re
import unittest

from tests._harness import ROOT

README = ROOT / "README.md"
APPGYM = ROOT / "app" / "sim" / "appgym.js"
UIFLOWS = ROOT / "app" / "sim" / "uiflows.js"
INVARIANTS = ROOT / "app" / "sim" / "invariants.js"

ENTRY = re.compile(r"^  \{\n    id: '", re.M)


def between(text: str, start: str, end: str) -> str:
    a = text.index(start)
    b = text.index(end, a)
    return text[a:b]


def counts() -> dict:
    gym = APPGYM.read_text(encoding="utf-8")
    ui = UIFLOWS.read_text(encoding="utf-8")
    inv = INVARIANTS.read_text(encoding="utf-8")
    suites = between(gym, "export const SUITES = [", "export async function runLogic")
    mutations = between(gym, "export const MUTATIONS = [", "export async function runMutations")
    flows = between(ui, "export const FLOWS = [", "export async function runFlows")
    standalone = len(re.findall(r"results\.push\(await run", ui))
    return {
        "suites": len(ENTRY.findall(suites)),
        "mutations": len(ENTRY.findall(mutations)),
        "journeys": len(ENTRY.findall(flows)) + standalone,
        "invariants": len(re.findall(r"^\s+id: '", inv, re.M)),
    }


class ReadmeFigures(unittest.TestCase):
    def setUp(self):
        self.readme = README.read_text(encoding="utf-8")
        self.counts = counts()

    def quoted(self, label: str) -> int:
        """The number the README puts directly before `label`."""
        m = re.search(rf"\b(\d+) {label}\b", self.readme)
        self.assertIsNotNone(m, f"the README no longer says how many {label} there are")
        return int(m.group(1))

    def test_the_counts_are_sane(self):
        for k, v in self.counts.items():
            self.assertGreater(v, 5, f"{k}: {v} - the counter's anchors have moved")

    def test_suites(self):
        self.assertEqual(self.quoted("suites"), self.counts["suites"])

    def test_journeys(self):
        self.assertEqual(self.quoted("journeys"), self.counts["journeys"])

    def test_mutations(self):
        self.assertEqual(self.quoted("mutations"), self.counts["mutations"])

    def test_invariants(self):
        self.assertEqual(self.quoted("invariants"), self.counts["invariants"])

    def test_readme_names_the_runners(self):
        for cmd in ("python tools/gym.py", "python -m unittest discover -s tests -t ."):
            self.assertIn(cmd, self.readme, f"the README should say to run `{cmd}`")


if __name__ == "__main__":
    unittest.main()
