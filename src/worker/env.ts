export interface D1Result<T> {
  results: T[];
  success: boolean;
  meta: { changes: number; [key: string]: unknown };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result<Record<string, unknown>>[]>;
}

export interface R2ObjectBody {
  body: ReadableStream<Uint8Array> | null;
  httpMetadata?: { contentType?: string };
  writeHttpMetadata(headers: Headers): void;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: { fetch(request: Request): Promise<Response> };
  SITE_TITLE: string;
  SEARCH_DAILY_LIMIT: string;
  TYPESAFE_BASE_URL: string;
  TYPESAFE_API_KEY: string;
  ACCOUNT_HANDLE: string;
  OWNER_EMAILS: string;
  OWNER_SERVICE_TOKEN_IDS: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  SCORE_BATCH: string;
  X_USER_ID: string;
  JEV_MONTHLY_USD_CAP: string;
  SOURCE_URL: string;
  ROBOTS_NOINDEX: string;
  CF_VERSION_METADATA?: { id: string };
  X_BEARER_TOKEN: string;
  DEV_OWNER?: string;
}

export interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
