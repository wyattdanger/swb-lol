"""Specs for the log -> data pipeline (tools/draft_replay.py and tools/games.py).

Run with: python3 -m unittest discover -s tests   (or tests/run.sh for everything)
They use a synthetic log (tests/fixture.py), so they need no Arena install, network, or personal data.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import fixture  # noqa: E402
import games  # noqa: E402

SCRIPT = os.path.join(ROOT, "tools", "draft_replay.py")


class FixtureCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.log, cls.db = fixture.build_all(cls.tmp.name)
        cls.env = dict(os.environ, ARENA_CARD_DB=cls.db,
                       DRAFTS_MANIFEST=os.path.join(cls.tmp.name, "drafts.json"))
        cls._saved = os.environ.get("ARENA_CARD_DB")
        os.environ["ARENA_CARD_DB"] = cls.db  # for in-process calls into games.py

    @classmethod
    def tearDownClass(cls):
        if cls._saved is None:
            os.environ.pop("ARENA_CARD_DB", None)
        else:
            os.environ["ARENA_CARD_DB"] = cls._saved
        cls.tmp.cleanup()

    def cli(self, *args, env=None):
        return subprocess.run([sys.executable, SCRIPT, *args, self.log], env=env or self.env,
                              capture_output=True, text=True, check=True)

    def data(self, draft="D1"):
        return json.loads(self.cli("--json", "--no-images", "--draft-id", draft).stdout)


class DraftParsing(FixtureCase):
    def test_picks_with_pack_contents(self):
        got = [(p["pack"], p["pick"], p["picked"], len(p["cards"])) for p in self.data()["picks"]]
        self.assertEqual(got, [(1, 1, "Alpha Land", 4), (1, 2, "Beta Bear", 3), (1, 3, "Gamma Bolt", 2),
                               (2, 1, "Eta Charm", 3), (2, 2, "Epsilon Land", 2)])

    def test_arena_logging_each_notify_twice_does_not_duplicate_picks(self):
        self.assertEqual(len(self.data()["picks"]), 5)

    def test_defaults_to_latest_draft_and_lists_others(self):
        r = self.cli("--json", "--no-images")
        self.assertEqual(json.loads(r.stdout)["draftId"], "D2")
        self.assertIn("2 drafts found", r.stderr)

    def test_submitted_deck_is_captured(self):
        deck = self.data()["deck"]
        self.assertEqual(sum(c["qty"] for c in deck["main"]), 5)
        self.assertEqual([c["name"] for c in deck["side"]], ["Eta Charm"])

    def test_draft_without_deck_has_no_deck_key(self):
        self.assertNotIn("deck", self.data("D2"))

    def test_card_metadata_from_the_card_database(self):
        bear = next(c for c in self.data()["picks"][0]["cards"] if c["name"] == "Beta Bear")
        self.assertEqual((bear["colors"], bear["types"], bear["cost"]), ("G", ["Creature"], "{1}{G}"))

    def test_plain_text_output_marks_the_pick(self):
        out = self.cli("--draft-id", "D1").stdout
        self.assertIn("PACK 1", out)
        self.assertRegex(out, r"->\s+Alpha Land")


class GameNarration(FixtureCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.matches = games.parse_games([cls.log], fixture.EVENT)
        cls.g1, cls.g2 = cls.matches[0]["games"]

    def test_only_matches_for_the_requested_event(self):
        self.assertEqual(len(self.matches), 1)
        self.assertEqual(games.parse_games([self.log], "SomeOtherEvent"), [])
        self.assertEqual((self.matches[0]["match"], self.matches[0]["result"]), (1, "won"))

    def test_connect_resp_line_still_yields_the_first_game_state(self):
        """Regression: ConnectResp shares a log line with the game's first state. Skipping the whole
        line once cost a game its opening hand, mulligan count and on-the-play info."""
        self.assertEqual(self.g1["onPlay"], "You")
        self.assertEqual(self.g1["mulligans"], 1)
        self.assertEqual(len(self.g1["opening"]), 3)

    def test_opening_hand_is_the_kept_hand_not_the_dealt_one(self):
        self.assertEqual(self.g1["opening"], ["Alpha Land", "Beta Bear", "Gamma Bolt"])  # Delta Sorcery was bottomed

    def test_mulligan_bottoming_is_not_narrated(self):
        events = [e for t in self.g1["turns"] for e in t["events"]]
        self.assertFalse([e for e in events if "library" in e], events)

    def test_turn_by_turn_events(self):
        self.assertEqual([(t["turn"], t["who"]) for t in self.g1["turns"]], [(1, "You"), (2, "Opp"), (3, "You")])
        self.assertEqual(self.g1["turns"][0]["events"], ["You play {{Alpha Land}}", "You cast {{Beta Bear}}"])
        self.assertEqual(self.g1["turns"][1]["events"], ["Opp plays {{Epsilon Land}}"])
        self.assertEqual(self.g1["turns"][2]["events"],
                         ["{{Beta Bear}} deals 2 damage to Opp", "Opp loses 2 life (20 → 18)",
                          "You attack with {{Beta Bear}}"])

    def test_resolves_lines_are_omitted(self):
        events = [e for m in self.matches for g in m["games"] for t in g["turns"] for e in t["events"]]
        self.assertFalse([e for e in events if e.endswith("resolves")])

    def test_game_results(self):
        self.assertEqual(self.g1["result"], {"winner": "You", "reason": "Game"})
        self.assertEqual(self.g2["result"], {"winner": "You", "reason": "Concede"})

    def test_second_game_has_opp_on_the_play_and_a_kept_hand(self):
        self.assertEqual((self.g2["onPlay"], self.g2["mulligans"], self.g2["opening"]), ("Opp", 0, ["Alpha Land"]))

    def test_no_sideboard_box_for_game_one(self):
        self.assertIsNone(self.g1["sideboard"])

    def test_sideboard_diff_uses_the_deck_registered_after_the_room_opens(self):
        """Regression: ConnectResp (the match's starting deck) is logged after the room-open event, so the
        match used to start with no deck and the diff silently vanished."""
        self.assertEqual(self.g2["sideboard"], {"in": [{"n": "Eta Charm", "q": 1}], "out": [{"n": "Delta Sorcery", "q": 1}]})

    def test_opponent_cards_seen(self):
        self.assertEqual(self.g1["opponentCards"], ["Epsilon Land"])

    def test_usernames_never_appear_in_any_output(self):
        blob = json.dumps(self.matches) + self.cli("--json", "--no-images", "--draft-id", "D1").stdout
        self.assertNotIn(fixture.ME_NAME, blob)
        self.assertNotIn(fixture.OPP_NAME, blob)


class Publish(FixtureCase):
    def publish(self, site, manifest, draft):
        env = dict(self.env, DRAFTS_MANIFEST=manifest)
        return self.cli("--publish", site, "--no-images", "--draft-id", draft, env=env)

    def page_data(self, path):
        html = open(path).read()
        return html, json.loads(re.search(r"const D = (\{.*?\});\nconst \$", html, re.S).group(1))

    def test_writes_a_self_contained_numbered_page(self):
        with tempfile.TemporaryDirectory() as d:
            self.publish(d, os.path.join(d, "m.json"), "D1")
            html, data = self.page_data(os.path.join(d, "drafts", "1", "index.html"))
            self.assertNotIn("__DATA__", html)
            self.assertIn('<meta name="robots" content="noindex">', html)
            self.assertEqual(html.count("</script>"), 1, "data must not be able to close the script tag")
            self.assertEqual(data["picks"], self.data()["picks"])
            self.assertEqual(data["games"], self.data()["games"])
            self.assertNotIn(fixture.ME_NAME, html)
            self.assertNotIn(fixture.OPP_NAME, html)

    def test_numbers_are_stable_per_draft_and_increment_for_new_ones(self):
        with tempfile.TemporaryDirectory() as d:
            m = os.path.join(d, "m.json")
            self.publish(d, m, "D1")
            self.publish(d, m, "D2")
            self.publish(d, m, "D1")  # republishing keeps its number
            self.assertEqual(sorted(os.listdir(os.path.join(d, "drafts"))), ["1", "2"])
            self.assertEqual(json.load(open(m)), {"D1": 1, "D2": 2})


@unittest.skipUnless(os.path.exists(os.path.expanduser(
    "~/Library/Logs/Wizards Of The Coast/MTGA/Player.log")), "no real Arena log on this machine")
class RealLogRegression(unittest.TestCase):
    """The Oct 26 cube draft, as parsed from the author's real logs. Skipped once Arena has rotated it
    out or on any other machine. These numbers were verified against the log by hand."""
    LOGS = [os.path.expanduser("~/Library/Logs/Wizards Of The Coast/MTGA/" + n) for n in ("Player-prev.log", "Player.log")]
    EVENT = "CubeDraft_PoweredTraditional_20261020"
    # (match, game): (turns, mulligans, opening size, on play, sideboarded?)
    EXPECTED = {(1, 1): (15, 0, 7, "You", False), (1, 2): (5, 2, 5, "Opp", True),
                (2, 1): (15, 0, 7, "You", False), (2, 2): (11, 0, 7, "Opp", True),
                (3, 1): (8, 1, 6, "You", False), (3, 2): (6, 0, 7, "Opp", True)}

    def test_every_game_matches_the_hand_verified_values(self):
        logs = [p for p in self.LOGS if os.path.exists(p)]
        if not any(self.EVENT in open(p, errors="replace").read() for p in logs):
            self.skipTest("that draft has been rotated out of the logs")
        got = {}
        for m in games.parse_games(logs, self.EVENT):
            for g in m["games"]:
                got[(m["match"], g["game"])] = (len(g["turns"]), g["mulligans"], len(g["opening"]), g["onPlay"], bool(g["sideboard"]))
        self.assertEqual(got, self.EXPECTED)


if __name__ == "__main__":
    unittest.main()
