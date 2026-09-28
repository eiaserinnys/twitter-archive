import seed from "./topics.json" with { type: "json" };

export interface TopicSeed {
  id: string;
  label: string;
  question: string;
  version?: string;
}

export interface TopicSeedConfig {
  description: string;
  version: string;
  display_threshold: number;
  search_threshold: number;
  topics: TopicSeed[];
}

export const TOPIC_SEED = seed as TopicSeedConfig;
