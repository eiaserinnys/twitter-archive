import { describe, expect, it } from "vitest";
import { normalizeArchive } from "../src/archive/normalize.js";
import { syntheticArchiveFiles } from "./fixtures.js";

describe("archive normalization", () => {
  const rows = normalizeArchive(syntheticArchiveFiles());

  it("keeps only authored posts and classifies replies, self replies, and quotes", () => {
    expect(rows.map((row) => [row.id, row.kind])).toEqual([
      ["101", "original"],
      ["102", "reply"],
      ["103", "self_reply"],
      ["104", "quote"],
      ["106", "original"],
      ["107", "original"],
      ["108", "original"],
    ]);
    expect(rows.find((row) => row.id === "102")?.parent).toEqual({ id: "900", text: "", author: "friend" });
    expect(rows.find((row) => row.id === "103")?.parent).toEqual({ id: "101", text: "A < B & C https://example.test/full", author: "archive-owner" });
    expect(rows.find((row) => row.id === "104")?.quoted).toEqual({ id: "800", text: "" });
  });

  it("uses note-tweet text, expands ordinary links, removes media links, and converts KST dates", () => {
    const original = rows.find((row) => row.id === "101");
    expect(original?.text).toBe("A < B & C https://example.test/full");
    expect(original?.created_at_utc).toBe("2018-10-10T15:19:24.000Z");
    expect(original?.date_kst).toBe("2018-10-11");
    expect(original?.year).toBe(2018);
    expect(original?.month).toBe(10);
    expect(rows.find((row) => row.id === "106")?.text).toBe("Long body <expanded>");
  });

  it("records synthetic photo and video metadata with archive paths", () => {
    expect(rows.find((row) => row.id === "101")?.media[0]).toMatchObject({
      type: "photo",
      archive_path: "data/tweets_media/101-photo.jpg",
      width: 640,
      height: 480,
      alt: "Synthetic photo",
    });
    expect(rows.find((row) => row.id === "108")?.media[0]).toMatchObject({
      type: "video",
      archive_path: "data/tweets_media/108-video108.jpg",
    });
  });
});
