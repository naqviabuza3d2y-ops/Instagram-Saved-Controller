import assert from "node:assert/strict";
import test from "node:test";
import { mediaId, parseExport } from "../export.mjs";

const formats = [
  ["URL label href", href => ({ label_values: [{ label: "URL", href }] })],
  ["URL label value", value => ({ label_values: [{ label: "URL", value }] })],
  ["string-list href", href => ({ string_list_data: [{ href }] })]
];

for (const [container, wrap] of [
  ["top-level array", rows => rows],
  ["saved_saved_media object", rows => ({ saved_saved_media: rows })]
]) {
  for (const [format, row] of formats) {
    test(`Parser supports ${format} in a ${container}`, () => {
      const rows = ["p", "reel", "reels", "tv"].map((type, index) =>
        row(`https://${index % 2 ? "instagram.com" : "www.instagram.com"}/${type}/item_${index}-id${index % 2 ? "" : "/"}?source=export#saved`));
      assert.deepEqual(parseExport(wrap(rows)), {
        ids: ["item_0-id", "item_1-id", "item_2-id", "item_3-id"],
        types: { "item_0-id": "p", "item_1-id": "reel", "item_2-id": "reel", "item_3-id": "tv" },
        excluded: 0
      });
    });
  }
}

test("Parser falls back from invalid label href to value, then to string-list href", () => {
  assert.deepEqual(parseExport([
    { label_values: [{ label: "URL", href: "invalid", value: "https://www.instagram.com/p/a/" }] },
    { label_values: [{ label: "URL", href: "invalid", value: "invalid" }],
      string_list_data: [{ href: "https://www.instagram.com/tv/b/" }] }
  ]), { ids: ["a", "b"], types: { a: "p", b: "tv" }, excluded: 0 });
});

test("Parser deduplicates by media ID while preserving first occurrence order and type", () => {
  assert.deepEqual(parseExport([
    formats[0][1]("https://www.instagram.com/p/a/"),
    formats[1][1]("https://instagram.com/reel/b/"),
    formats[2][1]("https://www.instagram.com/reels/a/?duplicate=1"),
    formats[0][1]("https://www.instagram.com/tv/c/")
  ]), { ids: ["a", "b", "c"], types: { a: "p", b: "reel", c: "tv" }, excluded: 1 });
});

test("Parser omits malformed and unsupported rows without discarding valid entries", () => {
  const malformed = [
    null, undefined, false, 17, "not a row", {},
    { label_values: {} }, { label_values: "not an array" },
    { label_values: [null, {}, { label: "Other", href: "https://www.instagram.com/p/ignored/" }] },
    { string_list_data: null }, { string_list_data: [] }, { string_list_data: [null] },
    { label_values: [{ label: "URL", href: {} }] },
    ...[
      "not a URL", "http://www.instagram.com/p/a/", "https://example.com/p/a/",
      "https://www.instagram.com.evil.example/p/a/", "https://www.instagram.com/profile/",
      "https://www.instagram.com/stories/a/", "https://www.instagram.com/p/",
      "https://www.instagram.com/p/a/extra/", "https://www.instagram.com/p/bad.id/"
    ].map(href => ({ string_list_data: [{ href }] }))
  ];
  for (const wrap of [rows => rows, rows => ({ saved_saved_media: rows })]) {
    assert.deepEqual(parseExport(wrap([
      ...malformed, { string_list_data: [{ href: "https://www.instagram.com/reel/valid/" }] }
    ])), { ids: ["valid"], types: { valid: "reel" }, excluded: malformed.length });
  }
});

test("Parser rejects malformed export containers with its actionable format error", () => {
  for (const input of [undefined, null, false, 7, "{broken JSON", {},
    { saved_saved_media: null }, { saved_saved_media: {} }, { saved_saved_media: "wrong" }]) {
    assert.throws(() => parseExport(input), { message: "Choose an Instagram saved_posts.json export." });
  }
});

test("Parser rejects empty exports and exports with no supported links", () => {
  for (const input of [[], { saved_saved_media: [] }, [null, {}, { label_values: [] }]]) {
    assert.throws(() => parseExport(input), { message: "No Instagram saved media links were found in this export." });
  }
});

test("Parser and mediaId preserve prototype-named media IDs safely", () => {
  const ids = ["__proto__", "constructor", "toString"];
  const result = parseExport(ids.map(id => ({ string_list_data: [{ href: `https://www.instagram.com/p/${id}/` }] })));
  assert.deepEqual(result.ids, ids);
  for (const id of ids) {
    assert.equal(Object.hasOwn(result.types, id), true);
    assert.equal(result.types[id], "p");
    assert.equal(mediaId(`https://www.instagram.com/p/${id}/`), id);
  }
  assert.equal(Object.getPrototypeOf(result.types), Object.prototype);
  assert.equal(mediaId("https://example.com/p/a/"), null);
  assert.equal(mediaId("invalid"), null);
});
