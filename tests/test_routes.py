"""The server over raw HTTP, on a sandboxed data directory.

The gym sends what the app sends. tools/fuzz.py sends what the app never
would, and that is where the join-code back door lived. These tests are the
fuzz tool's findings turned into a gate: every one of them is a request a
hand-crafted client can make, and every one must get an honest answer rather
than a dropped connection, a 500, or a 200 it did not deserve.
"""
from __future__ import annotations

import json
import unittest

from tests._harness import LiveServer, serve, table


class Health(LiveServer):
    def test_health_names_the_sandbox(self):
        res = self.get("/api/health")
        self.assertEqual(res.status, 200)
        self.assertTrue(res.body["ok"])
        self.assertEqual(res.body["dataDir"], str(self.sandbox.data))
        self.assertEqual(res.body["version"], serve.VERSION)


class BodyShapes(LiveServer):
    """API-1: a JSON body that is not an object must be refused, not dropped.

    The fuzz sweep found sixty-nine silent connection drops across eleven
    routes: a list, string, number or bool where an object belongs raised
    inside the handler thread and the caller got nothing at all.
    """

    HOSTILE = (b"[]", b"[1, 2]", b'"a string"', b"42", b"true", b"[[]]", b"null")

    def assert_refused(self, res, where):
        self.assertFalse(res.dropped, f"{where}: the connection was dropped")
        self.assertEqual(res.status, 400, f"{where}: {res.status} {res.raw[:80]!r}")

    def test_put_on_every_kind(self):
        for kind in sorted(serve.KINDS):
            for raw in self.HOSTILE:
                res = self.put(f"/api/{kind}/probe", raw=raw)
                self.assert_refused(res, f"PUT {kind} {raw!r}")

    def test_post_routes(self):
        for path in ("/api/appgym", "/api/sim", "/api/pdf", "/api/variant",
                     "/api/vectors", "/api/table/open", "/api/table/join",
                     "/api/shelf/refile", "/api/shelf/remove", "/api/llm"):
            for raw in self.HOSTILE:
                res = self.post(path, raw=raw)
                self.assertFalse(res.dropped, f"POST {path} {raw!r}: dropped")
                self.assertLess(res.status, 500, f"POST {path} {raw!r}: {res.status}")

    def test_events_accept_a_list_of_objects_and_nothing_else(self):
        ok = self.post("/api/events", [{"type": "roll", "payload": {"total": 9}}])
        self.assertEqual(ok.status, 200)
        self.assertEqual(ok.body["written"], 1)
        one = self.post("/api/events", {"type": "roll"})
        self.assertEqual(one.status, 200)
        for raw in (b"[1, 2]", b'["x"]', b"[[]]", b'"a string"', b"42", b"[{}, 3]"):
            res = self.post("/api/events", raw=raw)
            self.assert_refused(res, f"POST /api/events {raw!r}")

    def test_malformed_json_is_a_400(self):
        for raw in (b"{", b"", b"\xff\xfe", b"{'single': 1}"):
            res = self.put("/api/characters/probe", raw=raw)
            self.assert_refused(res, repr(raw))

    def test_a_bad_content_length_is_a_400(self):
        res = self.put("/api/characters/probe", raw=b"{}",
                       headers={"Content-Length": "lots"})
        self.assertFalse(res.dropped)
        self.assertEqual(res.status, 400)

    def test_the_socket_survives_a_refusal(self):
        # Every route drains the body before judging; a refusal must not
        # poison the next request on the same server.
        self.put("/api/characters/probe", raw=b"[]")
        res = self.get("/api/health")
        self.assertEqual(res.status, 200)


class RecordIds(LiveServer):
    """GOOD-1 from the soak, pinned: hostile ids never reach the filesystem."""

    HOSTILE = ("../../etc/passwd", "a/../../b", "..%2f..%2fserve.py",
               "%00", ".", "..", "a%20b", "x" * 300, "con%0a", "-lead")

    def test_put_refuses_them(self):
        for rid in self.HOSTILE:
            res = self.put(f"/api/characters/{rid}", {"name": "x"})
            self.assertFalse(res.dropped, rid)
            self.assertIn(res.status, (400, 404), f"{rid}: {res.status}")
        written = list((self.sandbox.data / "characters").glob("*")) \
            if (self.sandbox.data / "characters").exists() else []
        self.assertEqual(written, [])

    def test_a_trailing_newline_is_not_an_id(self):
        # The regex ended in `$`, which matches BEFORE a final newline, so
        # "con\n" was a valid id and a file with a newline in its name.
        self.assertIsNone(serve.safe_id("con\n"))
        res = self.put("/api/characters/con%0A", {"name": "x"})
        self.assertEqual(res.status, 400)

    def test_get_and_delete_refuse_them_too(self):
        for rid in self.HOSTILE:
            self.assertIn(self.get(f"/api/characters/{rid}").status, (400, 404), rid)
            self.assertIn(self.delete(f"/api/characters/{rid}").status, (400, 404), rid)


class Records(LiveServer):
    def test_round_trip_and_change_feed(self):
        res = self.put("/api/characters/kim-1", {"name": "Kim"},
                       headers={"X-Toon-Client": "tab-1"})
        self.assertEqual(res.status, 200)
        self.assertEqual(res.body["rev"], 1)
        got = self.get("/api/characters/kim-1")
        self.assertEqual(got.body["name"], "Kim")
        self.assertIn("updatedAt", got.body)
        feed = self.get("/api/changes?since=0").body
        self.assertEqual(feed["rev"], 1)
        self.assertEqual(feed["changes"][0]["by"], "tab-1")
        self.assertFalse(feed["gap"])

    def test_a_client_from_the_future_is_told_there_is_a_gap(self):
        self.assertTrue(self.get("/api/changes?since=999").body["gap"])

    def test_delete_removes_the_file(self):
        self.put("/api/characters/kim-1", {"name": "Kim"})
        self.assertEqual(self.delete("/api/characters/kim-1").status, 200)
        self.assertEqual(self.get("/api/characters/kim-1").status, 404)

    def test_unknown_kind_is_404(self):
        self.assertEqual(self.put("/api/secrets/x", {}).status, 404)
        self.assertEqual(self.get("/api/secrets/x").status, 404)


class TableOverHttp(LiveServer):
    """Every rule that the permission model enforces, seen from the wire."""

    def seat(self):
        dm = self.open_table("DM")
        kim = self.join(dm["code"], "Kim")
        return dm, kim

    def test_a_stranger_gets_401_and_needs_join(self):
        self.seat()
        res = self.put("/api/characters/x", {"name": "x"})
        self.assertEqual(res.status, 401)
        self.assertTrue(res.body["needsJoin"])

    def test_a_player_cannot_write_shared_kinds(self):
        _, kim = self.seat()
        for kind in sorted(table.SHARED_KINDS):
            res = self.put(f"/api/{kind}/x", {"name": "x"}, token=kim["token"])
            self.assertEqual(res.status, 403, kind)

    def test_ownership_is_read_from_disk(self):
        dm, kim = self.seat()
        bob = self.join(dm["code"], "Bob")
        self.sandbox.write_record("characters", "hero", {"id": "hero", "ownerId": kim["profile"]["id"]})
        res = self.put("/api/characters/hero", {"id": "hero", "ownerId": bob["profile"]["id"]},
                       token=bob["token"])
        self.assertEqual(res.status, 403)
        on_disk = json.loads((self.sandbox.data / "characters" / "hero.json").read_text())
        self.assertEqual(on_disk["ownerId"], kim["profile"]["id"])

    def test_the_unseated_get_least_privilege_not_most(self):
        # An open table plus no token used to read as "solo play" and hand
        # over everything the DM decided not to show.
        self.seat()
        self.sandbox.write_record("campaigns", "camp", {
            "id": "camp", "lore": "SECRET",
            "factions": [{"id": "f", "name": "Hidden", "public": False, "agenda": "SECRET"}],
            "clocks": [{"id": "k", "label": "SECRET", "public": False}]})
        res = self.get("/api/campaigns/camp")
        self.assertEqual(res.status, 200)
        self.assertNotIn("SECRET", res.raw.decode("utf-8"))

    def test_solo_play_has_no_login(self):
        self.sandbox.write_record("campaigns", "camp", {"id": "camp", "lore": "mine"})
        self.assertEqual(self.get("/api/campaigns/camp").body["lore"], "mine")
        self.assertEqual(self.put("/api/characters/x", {"name": "x"}).status, 200)

    def test_players_cannot_forge_the_world(self):
        _, kim = self.seat()
        for kind in sorted(table.WORLD_TYPES):
            res = self.post("/api/events", [{"type": kind, "payload": {}}], token=kim["token"])
            self.assertEqual(res.status, 403, kind)
            self.assertEqual(res.body["refused"], [kind])
        ok = self.post("/api/events", [{"type": "roll", "payload": {}}], token=kim["token"])
        self.assertEqual(ok.status, 200)

    def test_the_dm_authors_the_world(self):
        dm, _ = self.seat()
        res = self.post("/api/events", [{"type": "day_advanced", "payload": {}}], token=dm["token"])
        self.assertEqual(res.status, 200)

    def test_the_log_is_redacted_on_the_way_out(self):
        dm, kim = self.seat()
        self.sandbox.write_record("campaigns", "camp", {
            "id": "camp", "clocks": [{"id": "k2", "label": "SECRET", "public": False}]})
        self.post("/api/events", [
            {"type": "clock_advanced", "campaignId": "camp",
             "payload": {"clockId": "k2", "clock": "SECRET"}, "summary": "SECRET struck"},
            {"type": "roll", "payload": {"total": 3}}], token=dm["token"])
        mine = self.get("/api/events", token=kim["token"])
        self.assertEqual(mine.status, 200)
        self.assertNotIn("SECRET", mine.raw.decode("utf-8"))
        self.assertEqual([e["type"] for e in mine.body], ["roll"])
        theirs = self.get("/api/events", token=dm["token"])
        self.assertEqual(len(theirs.body), 2)


class LocalOnly(LiveServer):
    """Routes that must answer only the machine the server runs on.

    Every test here connects over loopback, so it can only check the OPEN
    side of each gate. The refusal side is a pure function of the client
    address, pinned below without binding a LAN socket.
    """

    def test_is_local_is_a_function_of_the_client_address(self):
        class Fake:
            def __init__(self, host):
                self.client_address = (host, 1)
        for host, want in (("127.0.0.1", True), ("::1", True), ("localhost", True),
                           ("192.168.1.20", False), ("10.0.0.5", False), ("", False)):
            self.assertEqual(serve.Handler._is_local(Fake(host)), want, host)

    def test_quit_is_not_a_get(self):
        self.assertGreaterEqual(self.get("/api/quit").status, 400)
        self.assertEqual(self.get("/api/health").status, 200)


class PdfExport(LiveServer):
    """API-2: a long name must not turn the sheet export into a 500."""

    SHEET = {"name": "Kim", "level": 3, "class": "Fighter", "ruleset": "2024",
             "abilities": {}, "proficiencyBonus": 2, "ac": 16, "hp": {"max": 28},
             "speed": 30, "initiative": 2, "skills": [], "saves": {}, "attacks": [],
             "features": [], "inventory": [], "spells": []}

    def test_a_sheet_renders(self):
        res = self.post("/api/pdf", {"sheet": self.SHEET})
        self.assertEqual(res.status, 200, res.raw[:200])
        self.assertTrue(res.raw.startswith(b"%PDF-"))
        self.assertIn("Kim", res.headers.get("Content-Disposition", ""))

    def test_a_long_name_does_not_500(self):
        res = self.post("/api/pdf", {"sheet": dict(self.SHEET, name="A" * 20000)})
        self.assertFalse(res.dropped)
        self.assertLess(res.status, 500, res.raw[:200])

    def test_a_hostile_name_cannot_choose_the_path(self):
        res = self.post("/api/pdf", {"sheet": dict(self.SHEET, name="../../escape")})
        self.assertLess(res.status, 500)
        sheets = self.sandbox.data / "sheets"
        for p in sheets.iterdir() if sheets.exists() else []:
            self.assertEqual(p.parent, sheets)
            self.assertNotIn("..", p.name)


if __name__ == "__main__":
    unittest.main()
