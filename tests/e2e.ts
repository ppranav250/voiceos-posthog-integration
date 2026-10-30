// End-to-end test: starts the server through run.sh, as VoiceOS does, and calls every tool over MCP
// against a real PostHog project. Read-only unless RUN_WRITE_TESTS=1 is set.
//
//   COMPOSIO_API_KEY=... POSTHOG_API_KEY=... bun tests/e2e.ts
//
// Optional env vars: POSTHOG_REGION (default us), POSTHOG_PROJECT_ID, RUN_WRITE_TESTS.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPECTED_TOOLS = 14;
const WRITE_TOOLS = ["capture_event", "create_feature_flag"];
const QUERY_ROW_CAP = 50;
const UNKNOWN_ID = "999999999";
const UNKNOWN_UUID = "00000000-0000-0000-0000-000000000000";
const INGESTION_TIMEOUT_MS = 90_000;
const INGESTION_POLL_MS = 5_000;

const { COMPOSIO_API_KEY, POSTHOG_API_KEY } = process.env;
if (!COMPOSIO_API_KEY || !POSTHOG_API_KEY) {
  console.error("Set COMPOSIO_API_KEY and POSTHOG_API_KEY in the environment.");
  process.exit(2);
}
const runWrites = process.env.RUN_WRITE_TESTS === "1";

type ToolResult = { isError: boolean; body: any };
type Outcome = boolean | string;
type Row = { tool: string; check: string; pass: boolean; detail: string };

const rows: Row[] = [];
const transcript: string[] = [];

function redact(text: string): string {
  return text
    .replaceAll(COMPOSIO_API_KEY!, "[redacted]")
    .replaceAll(POSTHOG_API_KEY!, "[redacted]")
    .replace(/\b(?:ak|ck|ph[xcs])_[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["run.sh"],
  cwd: REPO_ROOT,
  stderr: "pipe",
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // VoiceOS passes its bundled runtime here.
    VOICEOS_BUN: process.env.VOICEOS_BUN || process.execPath,
    COMPOSIO_API_KEY,
    POSTHOG_API_KEY,
    POSTHOG_REGION: process.env.POSTHOG_REGION || "us",
    ...(process.env.POSTHOG_PROJECT_ID ? { POSTHOG_PROJECT_ID: process.env.POSTHOG_PROJECT_ID } : {}),
  },
});
transport.stderr?.on("data", (chunk: Buffer) => transcript.push(String(chunk)));

const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

async function invoke(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const result: any = await client.callTool({ name: tool, arguments: args });
    const text: string = result.content?.[0]?.text ?? "";
    transcript.push(text);
    try {
      const { _voiceos_glance, ...body } = JSON.parse(text);
      return { isError: Boolean(result.isError), body };
    } catch {
      return { isError: true, body: { error: text } };
    }
  } catch (err: any) {
    return { isError: true, body: { error: err.message ?? String(err) } };
  }
}

function record(tool: string, check: string, result: ToolResult, outcome: Outcome) {
  const pass = outcome === true || (typeof outcome === "string" && outcome.length > 0);
  const detail = typeof outcome === "string" ? outcome : pass ? "" : String(result.body?.error ?? "unexpected result");
  rows.push({ tool, check, pass, detail: redact(detail).slice(0, 100) });
}

async function check(tool: string, name: string, args: Record<string, unknown>, verify: (r: ToolResult) => Outcome) {
  const result = await invoke(tool, args);
  record(tool, name, result, verify(result));
  return result;
}

const rejected = (r: ToolResult) => r.isError && "rejected";
const notFound = (r: ToolResult) => r.isError && /404|not found/i.test(String(r.body?.error)) && "not found error shown";

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
rows.push({ tool: "(server)", check: "tools/list", pass: names.length === EXPECTED_TOOLS, detail: `${names.length} tools` });
for (const name of WRITE_TOOLS) {
  rows.push({ tool: "(server)", check: `${name} registered`, pass: names.includes(name), detail: "" });
}

// Feature flags
const flags = await check("list_feature_flags", "list", { limit: 10 }, (r) => !r.isError && `${r.body.total_flags} flags`);
await check("list_feature_flags", "bad: limit 0", { limit: 0 }, rejected);
const firstFlag = flags.body.flags?.[0];
if (firstFlag) {
  await check("get_feature_flag", "detail by key", { key: firstFlag.key }, (r) => !r.isError && r.body.flag?.key === firstFlag.key);
}
await check("get_feature_flag", "unknown key", { key: "e2e-no-such-flag" }, (r) => r.isError && "not found error shown");
await check("get_feature_flag", "bad: non-numeric id", { flag_id: "abc" }, rejected);

// Insights
const insights = await check("get_insights", "list", {}, (r) => !r.isError && `${r.body.total_insights} insights`);
const firstInsight = insights.body.insights?.[0];
if (firstInsight) {
  await check("get_insights", "detail by short_id", { insight_id: firstInsight.short_id }, (r) => !r.isError && r.body.insight?.id === firstInsight.id);
}
await check("get_insights", "unknown id", { insight_id: UNKNOWN_ID }, notFound);

// Dashboards
const dashboards = await check("get_dashboard", "list", {}, (r) => !r.isError && `${r.body.total_dashboards} dashboards`);
const firstDashboard = dashboards.body.dashboards?.[0];
if (firstDashboard) {
  await check("get_dashboard", "detail by id", { dashboard_id: String(firstDashboard.id) }, (r) => !r.isError && `${r.body.dashboard?.tile_count} tiles`);
}
await check("get_dashboard", "bad: non-numeric id", { dashboard_id: "abc" }, rejected);

// Event definitions
const events = await check("get_event_definitions", "list", { limit: 15 }, (r) => !r.isError && `${r.body.total_events} events`);
const eventNames: string[] = (events.body.events ?? []).map((e: any) => e.name);
const [firstEvent = "$pageview", secondEvent = "$autocapture"] = eventNames;

// Funnel
await check("get_funnel", "2-step funnel", { steps: [firstEvent, secondEvent] }, (r) => !r.isError && r.body.steps?.length === 2 && "2 steps returned");
await check("get_funnel", "bad: 1 step", { steps: [firstEvent] }, (r) => r.isError && /at least 2/.test(String(r.body.error)) && "rejected");

// Retention
await check("get_retention", "real event", { target_event: firstEvent, period: "Day", intervals: 7 }, (r) => !r.isError && `${r.body.cohorts?.length} cohorts`);
await check("get_retention", "empty: unused event", { target_event: "e2e-no-such-event" }, (r) => !r.isError && r.body.total_users === 0 && "0 users");

// Query
await check("run_query", "events by count", { sql: "SELECT event, count() AS n FROM events GROUP BY event ORDER BY n DESC" }, (r) => !r.isError && `${r.body.row_count} rows`);
await check("run_query", "row cap", { sql: "SELECT number FROM numbers(500)" }, (r) => !r.isError && r.body.row_count === QUERY_ROW_CAP && r.body.truncated_at_50_rows === true && `capped at ${QUERY_ROW_CAP}`);
await check("run_query", "bad: DELETE", { sql: "DELETE FROM events WHERE 1" }, rejected);
await check("run_query", "bad: two statements", { sql: "SELECT 1; SELECT 2" }, rejected);
await check("run_query", "bad: unknown table", { sql: "SELECT x FROM e2e_no_such_table" }, (r) => r.isError && "query error shown");

// Persons
const persons = await check("get_persons", "list", { limit: 5 }, (r) => !r.isError && `${r.body.count} persons`);
const firstPerson = persons.body.persons?.[0];
if (firstPerson) {
  await check("get_persons", "detail by UUID", { person_id: firstPerson.id }, (r) => !r.isError && r.body.person?.id === firstPerson.id);
}
await check("get_persons", "empty: no match", { search: "e2e-no-such-person" }, (r) => !r.isError && r.body.count === 0 && "0 persons");
await check("get_persons", "delete-like args ignored", { limit: 1, method: "DELETE", delete: true }, (r) => !r.isError && Array.isArray(r.body.persons) && "still a list");
await check("get_persons", "bad: id not a UUID", { person_id: "abc" }, rejected);

// Cohorts
const cohorts = await check("get_cohorts", "list", {}, (r) => !r.isError && `${r.body.total_cohorts} cohorts`);
const firstCohort = cohorts.body.cohorts?.[0];
if (firstCohort) {
  await check("get_cohorts", "detail by id", { cohort_id: String(firstCohort.id) }, (r) => !r.isError && r.body.cohort?.id === firstCohort.id);
}
await check("get_cohorts", "bad: non-numeric id", { cohort_id: "abc" }, rejected);

// Actions
const actions = await check("get_actions", "list", {}, (r) => !r.isError && `${r.body.total_actions} actions`);
const firstAction = actions.body.actions?.[0];
if (firstAction) {
  await check("get_actions", "detail by id", { action_id: String(firstAction.id) }, (r) => !r.isError && r.body.action?.id === firstAction.id);
}
await check("get_actions", "unknown id", { action_id: UNKNOWN_ID }, notFound);

// Session recordings
const recordings = await check("get_session_recordings", "list", {}, (r) => !r.isError && `${r.body.count} recordings`);
const firstRecording = recordings.body.recordings?.[0];
if (firstRecording) {
  await check("get_session_recordings", "detail by id", { recording_id: firstRecording.id }, (r) => !r.isError && r.body.recording?.id === firstRecording.id);
}
await check("get_session_recordings", "unknown id", { recording_id: UNKNOWN_UUID }, notFound);

// Writes create one flag and one event. MCP calls skip VoiceOS's confirmation cards.
if (runWrites) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const flagKey = `voiceos-e2e-${stamp}`;
  const eventName = `voiceos-e2e-${stamp}`;

  await check("create_feature_flag", "bad: invalid key", { key: "bad key!", active: false, rollout_percentage: "0" }, rejected);
  const created = await check("create_feature_flag", "create (off, 0%)", { key: flagKey, name: flagKey, active: false, rollout_percentage: "0" }, (r) =>
    !r.isError && r.body.created === true && r.body.flag?.active === false && r.body.flag?.rollout_percentage === 0 && "created off at 0%");
  await check("get_feature_flag", "new flag stored", { flag_id: String(created.body.flag?.id) }, (r) =>
    !r.isError && r.body.flag?.key === flagKey && r.body.flag?.active === false && r.body.flag?.release_conditions?.[0]?.rollout_percentage === 0 && "off at 0%");

  await check("capture_event", "bad: properties not JSON", { event: eventName, distinct_id: "voiceos-e2e", properties: "not json" }, rejected);
  await check("capture_event", "capture", { event: eventName, distinct_id: "voiceos-e2e", properties: '{"source":"e2e"}' }, (r) => !r.isError && r.body.captured === true && "accepted");

  const deadline = Date.now() + INGESTION_TIMEOUT_MS;
  let found: ToolResult;
  do {
    found = await invoke("run_query", { sql: `SELECT count() FROM events WHERE event = '${eventName}'` });
    if (Number(found.body.rows?.[0]?.[0]) > 0) break;
    await Bun.sleep(INGESTION_POLL_MS);
  } while (Date.now() < deadline);
  record("capture_event", "event ingested", found, Number(found.body.rows?.[0]?.[0]) > 0 && "found in PostHog");
} else {
  console.log("Write checks skipped. Set RUN_WRITE_TESTS=1 to create one flag and one event.\n");
}

await client.close();

const secretPattern = /\b(?:ak|ck|ph[xcs])_[A-Za-z0-9_-]{8,}/;
const output = transcript.join("\n");
const leaked = output.includes(COMPOSIO_API_KEY) || output.includes(POSTHOG_API_KEY) || secretPattern.test(output);
rows.push({ tool: "(privacy)", check: "no keys in results or logs", pass: !leaked, detail: "" });

for (const row of rows) {
  console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.tool} | ${row.check}${row.detail ? ` | ${row.detail}` : ""}`);
}
const failed = rows.filter((row) => !row.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} checks passed`);
process.exit(failed ? 1 : 0);
