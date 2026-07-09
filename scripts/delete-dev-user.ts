/**
 * One-off DEV cleanup (ADR-0006 "no user migration" consequence / plan task T9): delete the
 * single dev user from the wanthat-dev CUSTOMER pool together with their DynamoDB
 * recommendations (byOwner GSI sweep + exact counter decrement via
 * `RecommendationRepo.deleteByOwner`), then `AdminDeleteUser`.
 *
 * Run:   pnpm tsx scripts/delete-dev-user.ts [--profile <aws-profile>] [--region <region>]
 *        (region defaults to il-central-1)
 *
 * Safety rails:
 * - targets ONLY the pool named exactly "wanthat-dev" (never *-employees, never *-prod);
 * - refuses to run when the pool holds more than 2 users;
 * - targets ONLY the wanthat-dev-data recommendation table;
 * - prints exactly what it deleted.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { getDocClient, RecommendationRepo } from "../packages/dynamo/src/index";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string", default: "il-central-1" },
  },
});
const region = args.region as string;
if (args.profile) process.env.AWS_PROFILE = args.profile; // SDK + CLI both honour it

function awsCli<T>(...cliArgs: string[]): T {
  const out = execFileSync("aws", [...cliArgs, "--region", region, "--output", "json"], {
    encoding: "utf8",
  });
  return (out.trim() === "" ? undefined : JSON.parse(out)) as T; // some calls return no body
}

async function main(): Promise<void> {
  // --- discover the DEV customer pool (exact name match; employees/prod structurally excluded) ---
  const pools = awsCli<{ UserPools: Array<{ Id: string; Name: string }> }>(
    "cognito-idp",
    "list-user-pools",
    "--max-results",
    "20",
  ).UserPools;
  const devCustomerPools = pools.filter((p) => p.Name === "wanthat-dev");
  if (devCustomerPools.length !== 1) {
    throw new Error(
      `expected exactly one pool named "wanthat-dev", found ${devCustomerPools.length} ` +
        `(all pools: ${pools.map((p) => `${p.Name}=${p.Id}`).join(", ")})`,
    );
  }
  const pool = devCustomerPools[0] as { Id: string; Name: string };
  console.log(`dev customer pool: ${pool.Name} (${pool.Id})`);

  // --- discover the DEV recommendation table ---
  const tables = awsCli<{ TableNames: string[] }>("dynamodb", "list-tables").TableNames.filter(
    (t) => t.startsWith("wanthat-dev-data-Recommendation"),
  );
  if (tables.length !== 1) {
    throw new Error(`expected exactly one wanthat-dev-data-Recommendation* table, found ${tables}`);
  }
  const tableName = tables[0] as string;
  console.log(`dev recommendation table: ${tableName}`);

  // --- list users; refuse on anything that does not look like the single-dev-user pool ---
  interface PoolUser {
    Username: string;
    Attributes?: Array<{ Name: string; Value: string }>;
  }
  const users = awsCli<{ Users: PoolUser[] }>(
    "cognito-idp",
    "list-users",
    "--user-pool-id",
    pool.Id,
  ).Users;
  if (users.length > 2) {
    throw new Error(
      `SAFETY STOP: pool has ${users.length} users (max 2 allowed) — not touching it`,
    );
  }
  if (users.length === 0) {
    console.log("pool is empty — nothing to delete");
    return;
  }

  const repo = new RecommendationRepo(getDocClient(region), tableName);
  console.log(`recommendation counter before: ${await repo.count()}`);

  for (const user of users) {
    const attr = (name: string) => user.Attributes?.find((a) => a.Name === name)?.Value;
    const sub = attr("sub") ?? user.Username;
    const phone = attr("phone_number") ?? "(no phone attribute)";

    // count first (so the plan is printed before any mutation), then delete
    let recCount = 0;
    let key: Record<string, unknown> | undefined;
    do {
      const page = await repo.listByOwner(sub, 100, key);
      recCount += page.items.length;
      key = page.lastKey;
    } while (key);
    console.log(
      `user: username=${user.Username} sub=${sub} phone=${phone} recommendations=${recCount}`,
    );

    const deleted = await repo.deleteByOwner(sub);
    console.log(
      `  deleted ${deleted} recommendation(s) for sub=${sub} (counter decremented by ${deleted})`,
    );

    awsCli(
      "cognito-idp",
      "admin-delete-user",
      "--user-pool-id",
      pool.Id,
      "--username",
      user.Username,
    );
    console.log(`  AdminDeleteUser done: username=${user.Username} sub=${sub} phone=${phone}`);
  }

  console.log(`recommendation counter after: ${await repo.count()}`);
  console.log("cleanup complete");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
