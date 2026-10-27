"""Specs for choosing each card's oldest printing (tools/draft_replay.py scryfall_images).

A fake Scryfall replaces the network, so these run offline. They pin down which request picks the art:
one search per card, printings sorted oldest first, promos and other oddities filtered out.
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tools"))
import draft_replay as dr  # noqa: E402


def card(name, oracle, img):
    return {"name": name, "oracle_id": oracle, "image_uris": {"normal": img}}


def two_faced(name, oracle, front_img):
    return {"name": name, "oracle_id": oracle, "card_faces": [{"image_uris": {"normal": front_img}}, {"image_uris": {"normal": "back.jpg"}}]}


class FakeScryfall:
    """Answers the three endpoints scryfall_images uses. `searches` maps a card's oracle id to the printings
    (oldest first) a search for it returns; a missing id or an empty list behaves like Scryfall's 404."""

    def __init__(self, collection, searches, named=None):
        self.collection, self.searches, self.named = collection, searches, named or {}
        self.calls = []

    def __call__(self, url, body=None):
        self.calls.append(url)
        if url.endswith("/cards/collection"):
            wanted = {i["name"] for i in body["identifiers"]}
            return {"data": [c for c in self.collection if c["name"] in wanted or c["name"].split(" // ")[0] in wanted]}
        if "/cards/named?fuzzy=" in url:
            name = parse_qs(urlparse(url).query)["fuzzy"][0]
            if name not in self.named:
                raise RuntimeError("404")
            return self.named[name]
        if "/cards/search?" in url:
            q = parse_qs(urlparse(url).query)["q"][0]
            oracle = q.split()[0].split(":")[1]
            printings = self.searches.get(oracle, [])
            tokens = q.split()
            wanted = [t[4:] for t in tokens if t.startswith("set:")]
            if wanted:  # a pinned-set query returns only that set's printings
                printings = [p for p in printings if p.get("set") == wanted[0]]
            excluded = {t[5:] for t in tokens if t.startswith("-set:")}
            printings = [p for p in printings if p.get("set") not in excluded]
            # a query with the oddity filters returns only the printings flagged as normal
            if "-is:promo" in q:
                printings = [p for p in printings if not p.get("promo")]
            if not printings:
                raise RuntimeError("404")
            return {"data": printings}
        raise AssertionError("unexpected request " + url)

    def searches_made(self):
        return [c for c in self.calls if "/cards/search?" in c]


class OldestPrinting(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = os.path.join(self.tmp.name, "cache.json")
        mock.patch.object(dr, "SCRYFALL_CACHE", self.cache).start()
        self.addCleanup(mock.patch.stopall)
        self.addCleanup(self.tmp.cleanup)

    def run_with(self, fake, names):
        with mock.patch.object(dr, "_scryfall_get", fake):
            return dr.scryfall_images(names)

    def test_uses_the_oldest_printing_not_scryfalls_default(self):
        fake = FakeScryfall([card("Bolt", "O1", "default-newest.jpg")],
                            {"O1": [card("Bolt", "O1", "1993.jpg"), card("Bolt", "O1", "2020.jpg")]})
        self.assertEqual(self.run_with(fake, ["Bolt"]), {"Bolt": "1993.jpg"})

    def test_the_search_asks_for_printings_sorted_oldest_first_without_promos(self):
        fake = FakeScryfall([card("Bolt", "O1", "d.jpg")], {"O1": [card("Bolt", "O1", "old.jpg")]})
        self.run_with(fake, ["Bolt"])
        q = parse_qs(urlparse(fake.searches_made()[0]).query)
        self.assertEqual((q["unique"], q["order"], q["dir"]), (["prints"], ["released"], ["asc"]))
        for part in ("oracleid:O1", "-is:promo", "-border:gold", "-set_type:memorabilia", "-is:oversized", "lang:en",
                     "-set:lea", "-set:leb"):
            self.assertIn(part, q["q"][0])

    def test_a_promo_that_predates_the_first_set_is_skipped(self):
        promo = dict(card("Push", "O2", "promo-fnm.jpg"), promo=True)
        fake = FakeScryfall([card("Push", "O2", "d.jpg")], {"O2": [promo, card("Push", "O2", "first-set.jpg")]})
        self.assertEqual(self.run_with(fake, ["Push"]), {"Push": "first-set.jpg"})

    def test_retries_without_filters_when_they_exclude_every_printing(self):
        only_promo = dict(card("Rare", "O3", "promo-only.jpg"), promo=True)
        fake = FakeScryfall([card("Rare", "O3", "d.jpg")], {"O3": [only_promo]})
        self.assertEqual(self.run_with(fake, ["Rare"]), {"Rare": "promo-only.jpg"})
        self.assertEqual(len(fake.searches_made()), 2)

    def test_falls_back_to_the_default_printing_when_no_search_works(self):
        fake = FakeScryfall([card("Odd", "O4", "default.jpg")], {})
        self.assertEqual(self.run_with(fake, ["Odd"]), {"Odd": "default.jpg"})

    def test_a_card_first_printed_in_alpha_shows_its_unlimited_printing(self):
        prints = [dict(card("Tutor", "OT", f"{code}.jpg"), set=code) for code in ("lea", "leb", "2ed", "m10")]
        fake = FakeScryfall([card("Tutor", "OT", "default.jpg")], {"OT": prints})
        self.assertEqual(self.run_with(fake, ["Tutor"]), {"Tutor": "2ed.jpg"})

    def test_a_card_printed_only_in_alpha_or_beta_still_gets_an_image(self):
        prints = [dict(card("Ante", "OA", "lea.jpg"), set="lea"), dict(card("Ante", "OA", "leb.jpg"), set="leb")]
        fake = FakeScryfall([card("Ante", "OA", "default.jpg")], {"OA": prints})
        self.assertEqual(self.run_with(fake, ["Ante"]), {"Ante": "lea.jpg"})

    def test_a_cache_built_under_a_different_rule_is_discarded(self):
        json.dump({"_v": dr.CACHE_VERSION, "filters": "lang:en", "images": {"Bolt": "alpha.jpg"}}, open(self.cache, "w"))
        fake = FakeScryfall([card("Bolt", "O1", "d.jpg")], {"O1": [dict(card("Bolt", "O1", "2ed.jpg"), set="2ed")]})
        self.assertEqual(self.run_with(fake, ["Bolt"]), {"Bolt": "2ed.jpg"})

    def test_double_faced_cards_use_the_front_face(self):
        fake = FakeScryfall([two_faced("Jace // Jace2", "O5", "d-front.jpg")],
                            {"O5": [two_faced("Jace // Jace2", "O5", "old-front.jpg")]})
        self.assertEqual(self.run_with(fake, ["Jace"]), {"Jace": "old-front.jpg"})

    def test_arena_names_without_accents_are_found_by_fuzzy_match(self):
        accented = card("Troll of Khazad-dûm", "O6", "d.jpg")
        fake = FakeScryfall([], {"O6": [card("Troll of Khazad-dûm", "O6", "ltr.jpg")]},
                            named={"Troll of Khazad-dum": accented})
        self.assertEqual(self.run_with(fake, ["Troll of Khazad-dum"]), {"Troll of Khazad-dum": "ltr.jpg"})

    def test_a_card_scryfall_cannot_find_is_skipped_without_breaking_the_rest(self):
        fake = FakeScryfall([card("Bolt", "O1", "d.jpg")], {"O1": [card("Bolt", "O1", "old.jpg")]})
        self.assertEqual(self.run_with(fake, ["Bolt", "Nonexistent Card"]), {"Bolt": "old.jpg"})

    def test_one_search_per_card(self):
        fake = FakeScryfall([card("A", "OA", "a.jpg"), card("B", "OB", "b.jpg")],
                            {"OA": [card("A", "OA", "a-old.jpg")], "OB": [card("B", "OB", "b-old.jpg")]})
        self.run_with(fake, ["A", "B", "A"])
        self.assertEqual(len(fake.searches_made()), 2)

    def test_results_are_cached_so_a_second_run_makes_no_requests(self):
        fake = FakeScryfall([card("Bolt", "O1", "d.jpg")], {"O1": [card("Bolt", "O1", "old.jpg")]})
        self.run_with(fake, ["Bolt"])
        again = FakeScryfall([], {})
        self.assertEqual(self.run_with(again, ["Bolt"]), {"Bolt": "old.jpg"})
        self.assertEqual(again.calls, [])

    def test_an_old_format_cache_of_newest_printings_is_discarded(self):
        json.dump({"Bolt": "stale-newest.jpg"}, open(self.cache, "w"))  # the pre-version cache shape
        fake = FakeScryfall([card("Bolt", "O1", "d.jpg")], {"O1": [card("Bolt", "O1", "old.jpg")]})
        self.assertEqual(self.run_with(fake, ["Bolt"]), {"Bolt": "old.jpg"})
        self.assertEqual(json.load(open(self.cache))["_v"], dr.CACHE_VERSION)

    def test_basic_lands_are_pinned_to_the_unhinged_printing(self):
        alpha, unhinged = dict(card("Swamp", "OS", "alpha.jpg"), set="lea"), dict(card("Swamp", "OS", "unhinged.jpg"), set="unh")
        fake = FakeScryfall([card("Swamp", "OS", "default.jpg")], {"OS": [alpha, unhinged]})
        self.assertEqual(self.run_with(fake, ["Swamp"]), {"Swamp": "unhinged.jpg"})
        self.assertIn("set:unh", parse_qs(urlparse(fake.searches_made()[0]).query)["q"][0])

    def test_pinning_does_not_touch_other_cards(self):
        fake = FakeScryfall([card("Bolt", "O1", "d.jpg")], {"O1": [dict(card("Bolt", "O1", "oldest.jpg"), set="lea")]})
        self.assertEqual(self.run_with(fake, ["Bolt"]), {"Bolt": "oldest.jpg"})
        self.assertFalse([c for c in fake.searches_made() if "set%3Aunh" in c or "set:unh" in c])

    def test_a_pinned_card_falls_back_to_its_oldest_printing_when_the_set_has_none(self):
        fake = FakeScryfall([card("Forest", "OF", "default.jpg")], {"OF": [dict(card("Forest", "OF", "alpha.jpg"), set="lea")]})
        self.assertEqual(self.run_with(fake, ["Forest"]), {"Forest": "alpha.jpg"})

    def test_a_cached_basic_chosen_before_the_pin_existed_is_looked_up_again(self):
        json.dump({"_v": dr.CACHE_VERSION, "filters": dr.OLDEST_FILTERS,
                   "images": {"Swamp": "old-alpha.jpg", "Bolt": "kept.jpg"}}, open(self.cache, "w"))
        unhinged = dict(card("Swamp", "OS", "unhinged.jpg"), set="unh")
        fake = FakeScryfall([card("Swamp", "OS", "d.jpg")], {"OS": [unhinged]})
        got = self.run_with(fake, ["Swamp", "Bolt"])
        self.assertEqual(got, {"Swamp": "unhinged.jpg", "Bolt": "kept.jpg"})  # Bolt came from the cache
        again = FakeScryfall([], {})
        self.assertEqual(self.run_with(again, ["Swamp"]), {"Swamp": "unhinged.jpg"})
        self.assertEqual(again.calls, [])  # the pin is now recorded, so no repeat lookups

    def test_offline_returns_nothing_instead_of_crashing(self):
        def offline(url, body=None):
            raise OSError("network down")
        self.assertEqual(self.run_with(offline, ["Bolt"]), {})


if __name__ == "__main__":
    unittest.main()
