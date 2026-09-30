// Single quoting matches Compose's env_file syntax and prevents $ interpolation.
export function serializeEnv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => key + "='" + value.replaceAll("'", "\\'") + "'").join("\n") + "\n";
}
export function readEnvFile(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of source.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)='((?:\\'|[^'])*)'\r?$/gm)) {
    values[match[1]] = match[2].replaceAll("\\'", "'");
  }
  return values;
}
