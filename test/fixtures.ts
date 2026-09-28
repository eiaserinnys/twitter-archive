import { strToU8, zipSync } from "fflate";
import { writeFile } from "node:fs/promises";
import { normalizeArchive } from "../src/archive/normalize.js";
import { writeJsonl } from "../src/shared/jsonl.js";

export function syntheticArchiveFiles(): Map<string, Uint8Array> {
  const tweetRecords = [
    {
      tweet: {
        id_str: "101",
        created_at: "Wed Oct 10 15:19:24 +0000 2018",
        full_text: "A &lt; B &amp; C https://t.co/normal https://t.co/photo",
        lang: "en",
        entities: {
          urls: [
            { url: "https://t.co/normal", expanded_url: "https://example.test/full" },
          ],
          media: [{ url: "https://t.co/photo" }],
        },
        extended_entities: {
          media: [
            {
              type: "photo",
              url: "https://t.co/photo",
              media_url_https: "https://pbs.twimg.com/media/photo.jpg",
              sizes: { large: { w: 640, h: 480 } },
              ext_alt_text: "Synthetic photo",
            },
          ],
        },
      },
    },
    {
      tweet: {
        id_str: "102",
        created_at: "Thu Oct 11 02:00:00 +0000 2018",
        full_text: "A reply",
        lang: "ko",
        in_reply_to_status_id_str: "900",
        in_reply_to_user_id_str: "2",
        in_reply_to_screen_name: "friend",
      },
    },
    {
      tweet: {
        id_str: "103",
        created_at: "Thu Oct 11 02:01:00 +0000 2018",
        full_text: "A self reply",
        lang: "ko",
        in_reply_to_status_id_str: "101",
        in_reply_to_user_id_str: "1",
        in_reply_to_screen_name: "archive-owner",
      },
    },
    {
      tweet: {
        id_str: "104",
        created_at: "Thu Oct 11 02:02:00 +0000 2018",
        full_text: "Quote https://t.co/first https://t.co/last",
        lang: "ko",
        entities: {
          urls: [
            { url: "https://t.co/first", expanded_url: "https://twitter.com/friend/status/700" },
            { url: "https://t.co/last", expanded_url: "https://x.com/friend/status/800" },
          ],
        },
      },
    },
    {
      tweet: {
        id_str: "105",
        created_at: "Thu Oct 11 02:03:00 +0000 2018",
        full_text: "RT @friend: copied text",
        lang: "ko",
      },
    },
    {
      tweet: {
        id_str: "106",
        created_at: "Thu Oct 11 02:04:00 +0000 2018",
        full_text: "Truncated preview",
        note_tweet: { note_tweet_id: "note-106" },
      },
    },
    {
      tweet: {
        id_str: "107",
        created_at: "Thu Oct 11 02:05:00 +0000 2018",
        full_text: "Photo attached",
        extended_entities: {
          media: [
            {
              type: "photo",
              url: "https://t.co/photo107",
              media_url_https: "https://pbs.twimg.com/media/photo107.jpg",
              sizes: { large: { w: 320, h: 240 } },
            },
          ],
        },
      },
    },
    {
      tweet: {
        id_str: "108",
        created_at: "Thu Oct 11 02:06:00 +0000 2018",
        full_text: "Video attached",
        extended_entities: {
          media: [
            {
              type: "video",
              url: "https://t.co/video108",
              media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/video108.jpg",
              video_info: { variants: [{ content_type: "video/mp4", url: "https://video.test/108.mp4" }] },
            },
          ],
        },
      },
    },
  ];

  const encode = (value: unknown) => strToU8(`window.YTD.tweets.part0 = ${JSON.stringify(value)};`);
  return new Map([
    ["data/account.js", strToU8(`window.YTD.account.part0 = ${JSON.stringify([{ account: { accountId: "1" } }])};`)],
    ["data/tweets.js", encode(tweetRecords)],
    ["data/note-tweet.js", strToU8(`window.YTD.note_tweet.part0 = ${JSON.stringify([{ noteTweet: { noteTweetId: "note-106", noteTweetContents: { text: "Long body &lt;expanded&gt;" } } }])};`)],
    ["data/direct-messages.js", strToU8("Synthetic unrelated archive data; not loaded.")],
    ["data/tweets_media/101-photo.jpg", strToU8("synthetic-photo-1")],
    ["data/tweets_media/107-photo107.jpg", strToU8("synthetic-photo-2")],
    ["data/tweets_media/108-video108.jpg", strToU8("synthetic-video-thumbnail")],
  ]);
}

export async function writeSyntheticArchive(zipPath: string): Promise<void> {
  const files = Object.fromEntries(syntheticArchiveFiles());
  await writeFile(zipPath, zipSync(files));
}

export async function writeSingleMediaFixture(dataDir: string): Promise<void> {
  const rows = normalizeArchive(syntheticArchiveFiles());
  const tweet = rows.find((row) => row.id === "101");
  if (!tweet) throw new Error("Synthetic media tweet is missing.");
  await writeJsonl(`${dataDir}/tweets.jsonl`, [{ ...tweet, media: [tweet.media[0]] }]);
}
