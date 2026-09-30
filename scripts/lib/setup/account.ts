import { readArchiveMember } from "../../../src/archive/archive-reader.js";
import { parseAccountId } from "./config.js";

export async function resolveXUserId(vars: Record<string, string>, archive: string | undefined, env: NodeJS.ProcessEnv, dryRun: boolean): Promise<void> {
  if (vars.X_USER_ID) return;
  if (archive) {
    const account = await readArchiveMember(archive, "data/account.js");
    if (!account) throw new Error("Archive is missing data/account.js.");
    vars.X_USER_ID = parseAccountId(account);
  } else if (env.X_BEARER_TOKEN && vars.ACCOUNT_HANDLE) {
    if (dryRun) console.log("Plan: resolve X_USER_ID via GET /2/users/by/username/" + vars.ACCOUNT_HANDLE.replace(/^@/, ""));
    else {
      const response = await fetch("https://api.x.com/2/users/by/username/" + encodeURIComponent(vars.ACCOUNT_HANDLE.replace(/^@/, "")), {
        headers: { authorization: "Bearer " + env.X_BEARER_TOKEN },
      });
      if (!response.ok) throw new Error("X user lookup failed (HTTP " + response.status + ").");
      const result = await response.json() as { data?: { id?: string } };
      if (!result.data?.id) throw new Error("X user lookup returned no user ID.");
      vars.X_USER_ID = result.data.id;
    }
  } else console.warn("Warning: X_USER_ID unresolved; automatic collection is disabled. Provide an archive or X_BEARER_TOKEN.");
}
