import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function parseCliArgs<T extends Record<string, { type: "string" | "boolean" }>>(
  args: string[],
  options: T,
): Record<keyof T, string | boolean | undefined> {
  return parseArgs({ args, options, strict: true, allowPositionals: false }).values as unknown as Record<keyof T, string | boolean | undefined>;
}

export function isDirectExecution(importMetaUrl: string): boolean {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === importMetaUrl;
}

export function reportCliError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export function requiredString(value: string | boolean | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required.`);
  return value;
}

export function selectedMode(local: boolean | undefined, remote: boolean | undefined): "local" | "remote" {
  if (Boolean(local) === Boolean(remote)) throw new Error("Choose exactly one of --local or --remote.");
  return local ? "local" : "remote";
}
