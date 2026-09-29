export interface TweetCursor {
  created_at: string;
  id: string;
}

export function encodeCursor(cursor: TweetCursor): string {
  return btoa(JSON.stringify([cursor.created_at, cursor.id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor(value: string): TweetCursor {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const decoded = JSON.parse(atob(padded)) as unknown;
  if (!Array.isArray(decoded) || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") {
    throw new Error("Invalid cursor.");
  }
  return { created_at: decoded[0], id: decoded[1] };
}
