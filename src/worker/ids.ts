export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const suffix = [...bytes].map((byte) => (byte % 36).toString(36)).join("");
  return `${prefix}${suffix}`;
}
