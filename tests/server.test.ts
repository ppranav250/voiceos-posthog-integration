// Offline tests: runs the real server over MCP against tests/mock-composio.ts. No keys or network needed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOCK = join(ROOT, "tests", "mock-composio.ts");
const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));
const source = readFileSync(join(ROOT, "server.ts"), "utf8");
const WRITE_TOOLS = ["capture_event", "create_feature_flag"];
const APPROVED_SLUGS = [
  "POSTHOG_CAPTURE_EVENT",
  "POSTHOG_CREATE_FEATURE_FLAG",
  "POSTHOG_CREATE_PROJECT_RETENTION_INSIGHT",
  "POSTHOG_CREATE_QUERY_IN_PROJECT_BY_ID",
  "POSTHOG_GET_EVENT_DEFINITIONS",
  "POSTHOG_GET_FEATURE_FLAG_DETAILS",
  "POSTHOG_LIST_ALL_PROJECTS_ACROSS_ORGANIZATIONS",
  "POSTHOG_LIST_AND_MANAGE_PROJECT_FEATURE_FLAGS",
  "POSTHOG_LIST_OR_DELETE_PERSONS_WITH_OPTIONAL_FILTERS",
  "POSTHOG_LIST_PROJECT_ACTIONS",
  "POSTHOG_LIST_PROJECT_DASHBOARDS",
  "POSTHOG_LIST_PROJECT_SESSION_RECORDINGS",
  "POSTHOG_RETRIEVE_PERSON_DETAILS_BY_ID",
  "POSTHOG_RETRIEVE_PROJECT_ACTION_DETAILS_BY_ID",
  "POSTHOG_RETRIEVE_PROJECT_COHORTS_WITH_PAGINATION",
  "POSTHOG_RETRIEVE_PROJECT_COHORT_DETAILS",
  "POSTHOG_RETRIEVE_PROJECT_INSIGHTS_WITH_PAGINATION",
  "POSTHOG_RETRIEVE_PROJECT_INSIGHT_DETAILS",
  "POSTHOG_RETRIEVE_SESSION_RECORDING_DETAILS",
  "POSTHOG_RETRIEVE_SPECIFIC_PROJECT_DASHBOARD_DETAILS",
];

async function startServer(serverPath: string) {
  const log: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--preload", MOCK, serverPath],
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", COMPOSIO_API_KEY: "test", POSTHOG_API_KEY: "test", POSTHOG_PROJECT_ID: "1" },
  });
  transport.stderr?.on("data", (chunk: Buffer) => log.push(...String(chunk).split("\n").filter(Boolean)));
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, log };
}

let client: Client;
let log: string[];

const calls = () => log.filter((line) => line.startsWith("MOCKCALL ")).map((line) => JSON.parse(line.slice(9)));
const lastArguments = (slug: string) => calls().filter((c) => c.path.endsWith(slug)).at(-1)?.arguments;

async function run(name: string, args: Record<string, unknown>) {
  const result: any = await client.callTool({ name, arguments: args });
  const text: string = result.content[0].text;
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  return { isError: Boolean(result.isError), text, body, html: String(body._voiceos_glance?.blocks?.[0]?.html ?? "") };
}

const cardRows = (html: string) => html.match(/class="ph-rw"/g)?.length ?? 0;

beforeAll(async () => {
  ({ client, log } = await startServer(join(ROOT, "server.ts")));
});

afterAll(async () => {
  await client.close();
});

describe("manifest", () => {
  test("follows VoiceOS's limits", () => {
    expect(manifest.summary.length).toBeLessThanOrEqual(140);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.tools).toHaveLength(14);
    for (const tool of manifest.tools) expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test("allows only the Composio domain", () => {
    expect(manifest.permissions).toEqual([{ kind: "network", domains: ["backend.composio.dev"] }]);
  });

  test("declares confirmation cards on write tools only", () => {
    const confirmed = manifest.tools.filter((t: any) => t.confirmation).map((t: any) => t.name).sort();
    expect(confirmed).toEqual(WRITE_TOOLS);
    for (const name of WRITE_TOOLS) {
      const tool = manifest.tools.find((t: any) => t.name === name);
      const roles = tool.confirmation.root.footer[0].items.map((item: any) => item.role).sort();
      expect(roles).toEqual(["cancel", "confirm"]);
      for (const [, arg] of JSON.stringify(tool.confirmation).matchAll(/\{\{(\w+)\}\}/g)) {
        expect(tool.inputSchema.properties).toHaveProperty(arg!);
      }
    }
  });
});

describe("server", () => {
  test("matches the manifest tool for tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(manifest.tools.map((t: any) => t.name).sort());
    for (const expected of manifest.tools) {
      const actual: any = tools.find((t) => t.name === expected.name);
      expect(actual.description).toBe(expected.description);
      expect(Object.keys(actual.inputSchema.properties).sort()).toEqual(Object.keys(expected.inputSchema.properties).sort());
      expect([...(actual.inputSchema.required ?? [])].sort()).toEqual([...(expected.inputSchema.required ?? [])].sort());
    }
  });

  test("references only approved Composio slugs", () => {
    const used = [...new Set(source.match(/"POSTHOG_[A-Z_]+"/g)!.map((slug) => slug.slice(1, -1)))]
      .filter((slug) => !["POSTHOG_API_KEY", "POSTHOG_REGION", "POSTHOG_PROJECT_ID"].includes(slug))
      .sort();
    expect(used).toEqual(APPROVED_SLUGS);
  });

  test("hides write tools when the manifest has no confirmation cards", async () => {
    const dir = mkdtempSync(join(ROOT, ".interlock-"));
    try {
      copyFileSync(join(ROOT, "server.ts"), join(dir, "server.ts"));
      copyFileSync(join(ROOT, "widgetKit.ts"), join(dir, "widgetKit.ts"));
      symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
      const stale = { ...manifest, tools: manifest.tools.map(({ confirmation, ...tool }: any) => tool) };
      writeFileSync(join(dir, "voiceos.integration.json"), JSON.stringify(stale));
      const started = await startServer(join(dir, "server.ts"));
      const names = (await started.client.listTools()).tools.map((t) => t.name);
      await started.client.close();
      expect(names).toHaveLength(12);
      for (const name of WRITE_TOOLS) expect(names).not.toContain(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("create_feature_flag", () => {
  test("requires active and rollout_percentage", async () => {
    const before = calls().length;
    const result = await run("create_feature_flag", { key: "missing-fields" });
    expect(result.isError).toBe(true);
    expect(calls()).toHaveLength(before);
  });

  test("treats a blank rollout as 0%", async () => {
    const result = await run("create_feature_flag", { key: "blank-rollout", active: false, rollout_percentage: "" });
    const sent = lastArguments("POSTHOG_CREATE_FEATURE_FLAG");
    expect(sent.active).toBe(false);
    expect(sent.filters.groups[0].rollout_percentage).toBe(0);
    expect(result.body.flag).toMatchObject({ active: false, rollout_percentage: 0 });
  });

  test("sends explicit values unchanged", async () => {
    await run("create_feature_flag", { key: "explicit", active: "true", rollout_percentage: "25%" });
    const sent = lastArguments("POSTHOG_CREATE_FEATURE_FLAG");
    expect(sent.active).toBe(true);
    expect(sent.filters.groups[0].rollout_percentage).toBe(25);
  });

  test.each([
    ["key", { key: "bad key!", active: false, rollout_percentage: "0" }],
    ["rollout", { key: "bad-rollout", active: false, rollout_percentage: "150" }],
    ["active", { key: "bad-active", active: "maybe", rollout_percentage: "0" }],
  ])("rejects an invalid %s before calling Composio", async (_field, args) => {
    const before = calls().length;
    const result = await run("create_feature_flag", args);
    expect(result.isError).toBe(true);
    expect(calls()).toHaveLength(before);
  });

  test("shows Composio's full error", async () => {
    const { isError, body } = await run("create_feature_flag", { key: "composio-rejects", active: false, rollout_percentage: "0" });
    expect(isError).toBe(true);
    expect(body.error).toContain("field is invalid");
    expect(body.error).toContain("req_1");
    expect(body.created).toBeUndefined();
  });

  test("never reports success when PostHog refuses a 200 response", async () => {
    const { isError, body } = await run("create_feature_flag", { key: "posthog-rejects", active: false, rollout_percentage: "0" });
    expect(isError).toBe(true);
    expect(body.error).toBe("PostHog error (status 400): Flag key already exists.");
    expect(body.created).toBeUndefined();
  });
});

describe("capture_event", () => {
  test("rejects a blank distinct ID and invalid properties", async () => {
    const before = calls().length;
    expect((await run("capture_event", { event: "signup", distinct_id: "  " })).isError).toBe(true);
    expect((await run("capture_event", { event: "signup", distinct_id: "user", properties: "not json" })).isError).toBe(true);
    expect(calls()).toHaveLength(before);
  });

  test("sends the inputs without exposing the project token", async () => {
    const result = await run("capture_event", { event: "signup", distinct_id: "user", properties: '{"plan":"pro"}' });
    const sent = lastArguments("POSTHOG_CAPTURE_EVENT");
    expect(sent).toMatchObject({ event: "signup", distinct_id: "user", properties: { plan: "pro" }, ingest_host: "https://us.i.posthog.com" });
    expect(result.body.captured).toBe(true);
    expect(result.text).not.toMatch(/ph[cs]_fake/);
    expect(log.filter((line) => !line.startsWith("MOCKCALL")).join("\n")).not.toMatch(/ph[cs]_fake/);
  });
});

describe("read-only guards", () => {
  test("get_persons forwards no delete-like arguments", async () => {
    await client.callTool({ name: "get_persons", arguments: { limit: 3, method: "DELETE", delete: true, id: "x" } });
    expect(lastArguments("POSTHOG_LIST_OR_DELETE_PERSONS_WITH_OPTIONAL_FILTERS")).toEqual({ limit: 3, project_id: "1" });
  });

  test.each([
    ["DELETE FROM events"],
    ["SELECT 1; DROP TABLE events"],
    [""],
  ])("run_query rejects %j", async (sql) => {
    const before = calls().length;
    expect((await run("run_query", { sql })).isError).toBe(true);
    expect(calls()).toHaveLength(before);
  });

  test("run_query wraps the query and caps results at 50 rows", async () => {
    const { body } = await run("run_query", { sql: "SELECT number FROM numbers(500) LIMIT 400;" });
    expect(lastArguments("POSTHOG_CREATE_QUERY_IN_PROJECT_BY_ID").query.query).toBe("SELECT * FROM (\nSELECT number FROM numbers(500) LIMIT 400\n) LIMIT 51");
    expect(body.row_count).toBe(50);
    expect(body.truncated_at_50_rows).toBe(true);
  });

  test("get_funnel needs at least 2 steps", async () => {
    const before = calls().length;
    expect((await run("get_funnel", { steps: ["only-one"] })).isError).toBe(true);
    expect(calls()).toHaveLength(before);
  });
});

describe("glance cards", () => {
  test.each([
    ["list_feature_flags", { limit: 10 }, "+3 more"],
    ["get_insights", {}, "+3 more"],
    ["get_dashboard", {}, "+2 more"],
    ["get_event_definitions", { limit: 15 }, "+35 more"],
  ])("%s shows 5 rows and the remainder", async (name, args, more) => {
    const { html } = await run(name, args);
    expect(cardRows(html)).toBe(5);
    expect(html).toContain(more);
  });

  test("keeps the full list in the data", async () => {
    const { body } = await run("get_event_definitions", { limit: 15 });
    expect(body.events).toHaveLength(15);
  });

  test("renders an empty state", async () => {
    const { isError, html } = await run("get_actions", {});
    expect(isError).toBe(false);
    expect(html).toContain("No actions in this project");
  });
});
