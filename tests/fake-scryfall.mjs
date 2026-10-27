// A fake Scryfall for the specs: answers the three endpoints scryfallImages uses, offline.
//
// `searches` maps a card's oracle id to the printings (oldest first) a search for it returns; a missing id or an
// empty list behaves like Scryfall's 404 (it throws). Printings may carry `set` and `promo`, which the fake
// honors the way the real search filters would.

export const card = (name, oracle, img) => ({ name, oracle_id: oracle, image_uris: { normal: img } });

export const twoFaced = (name, oracle, frontImg) => ({
  name, oracle_id: oracle, card_faces: [{ image_uris: { normal: frontImg } }, { image_uris: { normal: "back.jpg" } }],
});

export function fakeScryfall(collection, searches, named = {}) {
  const calls = [];
  const get = async (url, body) => {
    calls.push(url);
    if (url.endsWith("/cards/collection")) {
      const wanted = new Set(body.identifiers.map(i => i.name));
      return { data: collection.filter(c => wanted.has(c.name) || wanted.has(c.name.split(" // ")[0])) };
    }
    if (url.includes("/cards/named?fuzzy=")) {
      const name = new URL(url).searchParams.get("fuzzy");
      if (!(name in named)) throw new Error("404");
      return named[name];
    }
    if (url.includes("/cards/search?")) {
      const q = new URL(url).searchParams.get("q");
      const tokens = q.split(/\s+/);
      const oracle = tokens[0].split(":")[1];
      let printings = searches[oracle] ?? [];
      const wanted = tokens.filter(t => t.startsWith("set:")).map(t => t.slice(4));
      if (wanted.length) printings = printings.filter(p => p.set === wanted[0]); // a pinned-set query returns only that set
      const excluded = new Set(tokens.filter(t => t.startsWith("-set:")).map(t => t.slice(5)));
      printings = printings.filter(p => !excluded.has(p.set));
      if (q.includes("-is:promo")) printings = printings.filter(p => !p.promo); // the filters keep only normal printings
      if (!printings.length) throw new Error("404");
      return { data: printings };
    }
    throw new Error("unexpected request " + url);
  };
  return { get, calls, searchesMade: () => calls.filter(c => c.includes("/cards/search?")) };
}
