import seed from "./topics.json" with { type: "json" };

export interface TopicSeed {
  id: string;
  label: string;
  question: string;
  version?: string;
  timeline_visibility?: "public" | "owner" | "hidden";
  search_visibility?: "public" | "owner" | "hidden";
  public_hide_threshold?: number | null;
}

export interface TopicSeedConfig {
  description: string;
  version: string;
  display_threshold: number;
  search_threshold: number;
  topics: TopicSeed[];
}

export const TOPIC_SEED = seed as TopicSeedConfig;
