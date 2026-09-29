import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TOPIC_SEED, type TopicSeedConfig } from "../../src/shared/topics.js";

export async function readTopicSeed(path?: string): Promise<TopicSeedConfig> {
  if (!path) return TOPIC_SEED;
  return JSON.parse(await readFile(resolve(path), "utf8")) as TopicSeedConfig;
}
