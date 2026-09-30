import { spawn } from "node:child_process";

export interface CommandOptions {
  input?: string;
  quiet?: boolean;
  mutate?: boolean;
}

// Commands use argument arrays. Secrets are only supplied over stdin; output is
// suppressed for those commands so Wrangler errors cannot echo secret values.
export class SetupRuntime {
  constructor(
    readonly repoRoot: string,
    readonly dryRun: boolean,
    readonly env: NodeJS.ProcessEnv,
  ) {}

  async command(args: string[], options: CommandOptions = {}): Promise<string> {
    console.log("$ " + args.join(" "));
    if (this.dryRun && options.mutate) return "";
    return new Promise((resolvePromise, reject) => {
      const child = spawn(args[0], args.slice(1), {
        cwd: this.repoRoot,
        env: { ...this.env, CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_SANITIZE: "true" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (options.input === undefined) {
          output += chunk.toString();
          if (!options.quiet) process.stdout.write(chunk);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (options.input === undefined && !options.quiet) process.stderr.write(chunk);
      });
      child.on("error", () => reject(new Error("Could not start " + args[0])));
      child.on("close", (code) => code === 0
        ? resolvePromise(output)
        : reject(new Error(args.slice(0, 4).join(" ") + " failed (exit " + code + ").")));
      child.stdin.on("error", () => { /* exit handling reports failed commands */ });
      child.stdin.end(options.input ?? "");
    });
  }

  async wrangler(args: string[], options: CommandOptions = {}): Promise<string> {
    return this.command(["npx", "wrangler", ...args], options);
  }

  async api<T>(path: string, method = "GET", body?: unknown): Promise<T | undefined> {
    console.log(method + " Cloudflare " + path);
    if (this.dryRun && method !== "GET") return undefined;
    const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
      method,
      headers: { authorization: "Bearer " + this.env.CLOUDFLARE_API_TOKEN, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Only a genuinely absent Zero Trust organization is optional; auth errors
    // must remain visible rather than becoming a misleading successful skip.
    if (response.status === 404 && path.endsWith("/access/organizations")) return undefined;
    const payload = await response.json() as { success: boolean; result?: T };
    if (!response.ok || !payload.success) throw new Error("Cloudflare " + method + " " + path + " failed (HTTP " + response.status + ").");
    return payload.result;
  }
}
