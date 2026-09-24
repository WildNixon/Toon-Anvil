"""The permission model, tested as functions.

tools/table.py is the whole security of the shared table. The gym reaches it
only through HTTP, one scenario per rule the app happens to exercise. These
pin the rules themselves, including the ones nothing in app/ ever sends.
"""
from __future__ import annotations

import json
import unittest

from tests._harness import Sandbox, table


DM = {"id": "p-dm", "role": "dm", "characterIds": []}
KIM = {"id": "p-kim", "role": "player", "characterIds": ["kim-1"]}
BOB = {"id": "p-bob", "role": "player", "characterIds": []}


class WithTable(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox().__enter__()

    def tearDown(self):
        self.sb.__exit__(None, None, None)

    def open(self, forge=True):
        out = table.open_table("DM")
        if not forge:
            table.set_forge(False)
        return out


class Codes(unittest.TestCase):
    def test_normalise_accepts_how_people_retype_a_code(self):
        for raw in ("anvil 4471", "ANVIL-4471", "4471", " anvil-4471 ", "Anvil_4471"):
            self.assertEqual(table.normalise_code(raw), "ANVIL-4471", raw)

    def test_new_codes_avoid_confusable_glyphs(self):
        for _ in range(50):
            code = table.new_code()
            suffix = code.split("-", 1)[1]
            self.assertEqual(len(suffix), 4)
            for ch in suffix:
                self.assertIn(ch, table.CODE_ALPHABET)
                self.assertNotIn(ch, "0O1IBSZ258")


class HpBand(unittest.TestCase):
    def test_bands(self):
        self.assertEqual(table.hp_band(0, 10), "down")
        self.assertEqual(table.hp_band(-3, 10), "down")
        self.assertEqual(table.hp_band(5, 10), "bloodied")
        self.assertEqual(table.hp_band(6, 10), "hurt")
        self.assertEqual(table.hp_band(10, 10), "unhurt")

    def test_zero_max_does_not_divide(self):
        self.assertEqual(table.hp_band(3, 0), "unhurt")


class Join(WithTable):
    def test_needs_an_open_table(self):
        out = table.join("ANVIL-XXXX", "Kim")
        self.assertFalse(out["ok"])

    def test_wrong_code_is_refused_vaguely(self):
        self.open()
        out = table.join("ANVIL-ZZZZ", "Kim")
        self.assertFalse(out["ok"])
        self.assertNotIn("ANVIL", out["error"])

    def test_join_only_ever_seats_a_player(self):
        # SEC-1: the code used to buy the DM's own seat via profile_id.
        code = self.open()["code"]
        out = table.join(code, "Mallory")
        self.assertTrue(out["ok"])
        self.assertEqual(out["profile"]["role"], "player")
        self.assertNotEqual(out["profile"]["id"], "p-dm")
        self.assertEqual(table.whoami(out["token"])["role"], "player")

    def test_join_does_not_take_a_profile_id_at_all(self):
        import inspect
        params = inspect.signature(table.join).parameters
        self.assertNotIn("profile_id", params)

    def test_duplicate_names_get_distinct_ids(self):
        code = self.open()["code"]
        a = table.join(code, "Kim")["profile"]["id"]
        b = table.join(code, "Kim")["profile"]["id"]
        self.assertNotEqual(a, b)

    def test_close_revokes_every_token(self):
        code = self.open()["code"]
        tok = table.join(code, "Kim")["token"]
        self.assertIsNotNone(table.whoami(tok))
        table.close_table()
        self.assertIsNone(table.whoami(tok))


class SetOwner(WithTable):
    def test_first_claim_wins(self):
        code = self.open()["code"]
        kim = table.join(code, "Kim")["profile"]
        bob = table.join(code, "Bob")["profile"]
        self.assertTrue(table.set_owner(kim["id"], "hero")["ok"])
        # SEC-3: a second player could once take it over.
        out = table.set_owner(bob["id"], "hero")
        self.assertFalse(out["ok"])
        self.assertIn("already", out["error"])

    def test_dm_force_hands_a_character_over(self):
        code = self.open()["code"]
        kim = table.join(code, "Kim")["profile"]
        bob = table.join(code, "Bob")["profile"]
        table.set_owner(kim["id"], "hero")
        out = table.set_owner(bob["id"], "hero", force=True)
        self.assertTrue(out["ok"])
        prof = table.read()["profiles"]
        self.assertNotIn("hero", prof[kim["id"]]["characterIds"])
        self.assertIn("hero", prof[bob["id"]]["characterIds"])


class MayWrite(WithTable):
    """Ownership comes from DISK, never from the request body."""

    def test_no_seat_no_write(self):
        ok, why = table.may_write(None, "characters", "x")
        self.assertFalse(ok)
        self.assertIn("join code", why)

    def test_dm_writes_anything(self):
        for kind in ("characters", "campaigns", "encounters", "profiles", "maps"):
            self.assertTrue(table.may_write(DM, kind, "x", {}, True, {})[0], kind)

    def test_players_never_write_shared_kinds(self):
        self.open()
        for kind in sorted(table.SHARED_KINDS):
            ok, why = table.may_write(KIM, kind, "x", {}, True, {})
            self.assertFalse(ok, kind)
            self.assertIn("DM", why)

    def test_create_needs_the_forge(self):
        self.open(forge=True)
        self.assertTrue(table.may_write(KIM, "characters", "new", None, False, {})[0])
        table.set_forge(False)
        ok, why = table.may_write(KIM, "characters", "new", None, False, {})
        self.assertFalse(ok)
        self.assertIn("forge", why)

    def test_somebody_elses_character_is_refused(self):
        self.open()
        stored = {"id": "hero", "ownerId": "p-kim"}
        ok, why = table.may_write(BOB, "characters", "hero", stored, True, stored)
        self.assertFalse(ok)
        self.assertIn("somebody else", why)

    def test_omitting_owner_in_the_body_changes_nothing(self):
        # The original hole: ownerId used to be read from the request.
        self.open()
        stored = {"id": "hero", "ownerId": "p-kim"}
        incoming = {"id": "hero", "hp": {"current": 1}}   # no ownerId at all
        ok, _ = table.may_write(BOB, "characters", "hero", stored, True, incoming)
        self.assertFalse(ok)
        incoming = {"id": "hero", "ownerId": "p-bob"}      # a lie about ownership
        ok, _ = table.may_write(BOB, "characters", "hero", stored, True, incoming)
        self.assertFalse(ok)

    def test_unowned_preexisting_character_waits_for_the_dm(self):
        self.open()
        stored = {"id": "old"}
        ok, why = table.may_write(BOB, "characters", "old", stored, True, stored)
        self.assertFalse(ok)
        self.assertIn("no owner", why)

    def test_play_state_never_needs_permission(self):
        self.open(forge=False)
        stored = {"id": "kim-1", "ownerId": "p-kim", "name": "Kim",
                  "classes": [{"classId": "fighter", "level": 3}],
                  "hp": {"current": 20}, "gold": 10, "conditions": []}
        incoming = dict(stored, hp={"current": 4}, gold=2, conditions=["poisoned"])
        self.assertTrue(table.may_write(KIM, "characters", "kim-1", stored, True, incoming)[0])

    def test_frozen_fields_need_the_forge(self):
        self.open(forge=False)
        stored = {"id": "kim-1", "ownerId": "p-kim", "name": "Kim",
                  "species": "human", "classes": [{"classId": "fighter", "level": 3}]}
        for field, value in (("name", "Kimberly"), ("species", "elf"),
                             ("abilities", {"str": 18}), ("feats", ["alert"])):
            incoming = dict(stored, **{field: value})
            ok, why = table.may_write(KIM, "characters", "kim-1", stored, True, incoming)
            self.assertFalse(ok, field)
            self.assertIn(field, why)

    def test_field_order_is_not_a_change(self):
        self.open(forge=False)
        stored = {"id": "kim-1", "ownerId": "p-kim",
                  "abilities": {"str": 10, "dex": 12}, "skills": ["a", "b"]}
        incoming = dict(stored, abilities={"dex": 12, "str": 10})
        self.assertTrue(table.may_write(KIM, "characters", "kim-1", stored, True, incoming)[0])

    def test_omitted_frozen_field_is_not_a_change(self):
        self.open(forge=False)
        stored = {"id": "kim-1", "ownerId": "p-kim", "feats": None}
        incoming = {"id": "kim-1", "ownerId": "p-kim"}
        self.assertTrue(table.may_write(KIM, "characters", "kim-1", stored, True, incoming)[0])

    def test_levelling_needs_a_grant(self):
        self.open(forge=False)
        stored = {"id": "kim-1", "ownerId": "p-kim",
                  "classes": [{"classId": "fighter", "level": 3}]}
        up = dict(stored, classes=[{"classId": "fighter", "level": 4}])
        ok, why = table.may_write(KIM, "characters", "kim-1", stored, True, up)
        self.assertFalse(ok)
        self.assertIn("grant", why)
        table.set_grant("kim-1", 4)
        self.assertTrue(table.may_write(KIM, "characters", "kim-1", stored, True, up)[0])
        # The grant is a ceiling, not a licence.
        too_far = dict(stored, classes=[{"classId": "fighter", "level": 6}])
        self.assertFalse(table.may_write(KIM, "characters", "kim-1", stored, True, too_far)[0])

    def test_grant_is_consumed_once_reached(self):
        self.open(forge=False)
        table.set_grant("kim-1", 4)
        reached = {"classes": [{"classId": "fighter", "level": 4}]}
        self.assertTrue(table.consume_grant("kim-1", reached))
        self.assertNotIn("kim-1", table.read()["grants"])
        self.assertFalse(table.consume_grant("kim-1", reached))

    def test_delete_is_a_forge_act(self):
        self.open(forge=False)
        stored = {"id": "kim-1", "ownerId": "p-kim"}
        ok, why = table.may_write(KIM, "characters", "kim-1", stored, True, None)
        self.assertFalse(ok)
        self.assertIn("forge", why)
        table.set_forge(True)
        self.assertTrue(table.may_write(KIM, "characters", "kim-1", stored, True, None)[0])

    def test_only_your_own_profile(self):
        self.open()
        self.assertTrue(table.may_write(KIM, "profiles", "p-kim", {}, True, {})[0])
        self.assertFalse(table.may_write(KIM, "profiles", "p-bob", {}, True, {})[0])


class MayRead(unittest.TestCase):
    def test_reads_are_open_to_the_seated(self):
        self.assertTrue(table.may_read(KIM, "campaigns")[0])
        self.assertTrue(table.may_read(DM, "campaigns")[0])
        self.assertFalse(table.may_read(None, "campaigns")[0])


class Redactors(WithTable):
    ENCOUNTER = {"id": "e", "combatants": [
        {"id": "c1", "kind": "pc", "name": "Kim", "hp": 4, "hpMax": 20},
        {"id": "c2", "kind": "monster", "name": "Ogre", "hp": 29, "hpMax": 59, "temp": 5},
    ]}
    CAMPAIGN = {"id": "camp", "day": 3, "seed": 7, "lore": "SECRET",
                "regions": [{"id": "r1"}],
                "factions": [{"id": "f1", "name": "Wardens", "public": True, "agenda": "SECRET"},
                             {"id": "f2", "name": "Veiled Hand", "public": False}],
                "encounterTemplates": [{"id": "t1", "name": "SECRET"}],
                "clocks": [{"id": "k1", "label": "Harvest", "public": True},
                           {"id": "k2", "label": "The ritual completes", "public": False}],
                "timbres": {"monster:orc": {"pitch": -2}}}
    MAP = {"id": "m", "image": "x.png",
           "pins": [{"id": "p1", "label": "Inn", "revealed": True, "note": "SECRET"},
                    {"id": "p2", "label": "Ambush", "revealed": False}]}

    def test_dm_and_solo_see_everything(self):
        for viewer in (DM, None):
            self.assertEqual(table.redact_encounter(self.ENCOUNTER, viewer), self.ENCOUNTER)
            self.assertEqual(table.redact_campaign(self.CAMPAIGN, viewer), self.CAMPAIGN)
            self.assertEqual(table.redact_map(self.MAP, viewer), self.MAP)

    def test_player_gets_a_band_not_a_number(self):
        out = table.redact_encounter(self.ENCOUNTER, KIM)
        pc, ogre = out["combatants"]
        self.assertEqual(pc["hp"], 4)
        for key in ("hp", "hpMax", "temp"):
            self.assertNotIn(key, ogre)
        self.assertEqual(ogre["band"], "bloodied")
        self.assertTrue(ogre["hpHidden"])
        # The input is not mutated.
        self.assertIn("hp", self.ENCOUNTER["combatants"][1])

    def test_dm_can_choose_to_show_monster_hp(self):
        out = table.redact_encounter(dict(self.ENCOUNTER, showMonsterHp=True), KIM)
        self.assertEqual(out["combatants"][1]["hp"], 29)

    def test_campaign_secrets_never_leave_for_a_player(self):
        out = table.redact_campaign(self.CAMPAIGN, KIM)
        text = json.dumps(out)
        self.assertNotIn("SECRET", text)
        self.assertNotIn("ritual", text)
        self.assertNotIn("timbres", out)
        self.assertNotIn("encounterTemplates", out)
        self.assertEqual([f["name"] for f in out["factions"]], ["Wardens"])
        self.assertEqual([c["id"] for c in out["clocks"]], ["k1"])
        # The sky is an in-world fact; the seed predicts nothing else.
        self.assertEqual((out["day"], out["seed"], out["regions"]), (3, 7, [{"id": "r1"}]))

    def test_map_pins_are_revealed_or_absent(self):
        out = table.redact_map(self.MAP, KIM)
        self.assertEqual([p["id"] for p in out["pins"]], ["p1"])
        self.assertNotIn("note", out["pins"][0])

    def test_non_dict_records_pass_through(self):
        for r in (None, [], "x"):
            self.assertEqual(table.redact_campaign(r, KIM), r)
            self.assertEqual(table.redact_map(r, KIM), r)
            self.assertEqual(table.redact_encounter(r, KIM), r)


class RedactEvents(WithTable):
    def setUp(self):
        super().setUp()
        self.sb.write_record("campaigns", "camp", Redactors.CAMPAIGN)

    def test_dm_sees_the_whole_log(self):
        evs = [{"type": "section_filed", "campaignId": "camp"}]
        self.assertEqual(table.redact_events(evs, DM), evs)

    def test_world_only_events_are_absent_for_players(self):
        evs = [{"type": "section_filed", "campaignId": "camp"},
               {"type": "roll", "payload": {"total": 17}}]
        out = table.redact_events(evs, KIM)
        self.assertEqual([e["type"] for e in out], ["roll"])

    def test_secret_clock_striking_is_absent_not_blanked(self):
        evs = [{"type": "clock_advanced", "campaignId": "camp",
                "payload": {"clockId": "k2", "clock": "The ritual completes"},
                "summary": "The ritual completes struck"},
               {"type": "clock_advanced", "campaignId": "camp",
                "payload": {"clockId": "k1", "clock": "Harvest"}}]
        out = table.redact_events(evs, KIM)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["payload"]["clockId"], "k1")
        self.assertNotIn("ritual", json.dumps(out))

    def test_older_label_only_events_are_judged_by_label(self):
        evs = [{"type": "faction_standing", "campaignId": "camp",
                "payload": {"name": "Veiled Hand", "standing": -3}},
               {"type": "faction_standing", "campaignId": "camp",
                "payload": {"name": "Wardens", "standing": 2}}]
        out = table.redact_events(evs, KIM)
        self.assertEqual([e["payload"]["name"] for e in out], ["Wardens"])

    def test_unresolvable_events_fail_closed(self):
        evs = [{"type": "clock_advanced", "payload": {"clockId": "k1"}},           # no campaign
               {"type": "clock_advanced", "campaignId": "gone", "payload": {"clockId": "k1"}},
               {"type": "clock_advanced", "campaignId": "camp", "payload": {"clockId": "nope"}},
               {"type": "clock_advanced", "campaignId": "camp", "payload": "junk"}]
        self.assertEqual(table.redact_events(evs, KIM), [])

    def test_solo_encounter_names_become_a_count(self):
        evs = [{"type": "encounter_start", "summary": "Ambush at the mill",
                "payload": {"name": "Ambush at the mill",
                            "combatants": ["Lich", "Goblin"], "round": 1}}]
        out = table.redact_events(evs, KIM)
        self.assertEqual(out[0]["payload"], {"combatants": 2, "round": 1})
        self.assertNotIn("summary", out[0])
        self.assertNotIn("Ambush", json.dumps(out))
        # The input is not mutated.
        self.assertEqual(evs[0]["payload"]["name"], "Ambush at the mill")

    def test_players_own_play_is_untouched(self):
        evs = [{"type": "roll", "payload": {"total": 17}},
               {"type": "purchase", "payload": {"item": "rope"}}, "junk", 3]
        self.assertEqual(table.redact_events(evs, KIM), evs)

    def test_world_types_is_the_dms_alone(self):
        # serve.py refuses these from a player. Pin the set so a new world
        # event cannot land without being added here on purpose.
        self.assertEqual(table.WORLD_TYPES, {
            "day_advanced", "clock_advanced", "faction_standing", "region_moved",
            "campaign_founded", "section_filed", "price_changed"})


if __name__ == "__main__":
    unittest.main()
