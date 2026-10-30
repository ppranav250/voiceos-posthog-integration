import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderCustom, renderWidget, vHeader, vList, vStats, vKeyValue, vNote, vEmpty, markHtml, esc, clip } from "./widgetKit.ts";
import type { Block, RowItem } from "./widgetKit.ts";

const server = new McpServer({ name: "posthog", version: "1.1.0" });
const ACCENT = "#f54e00"; // PostHog brand electric orange

// --- Config ---
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3.1";
let memoryProjectId: string | null = null;

function getEnvConfig() {
  const composioKey = process.env.COMPOSIO_API_KEY?.trim() || "";
  const posthogKey = process.env.POSTHOG_API_KEY?.trim() || "";
  const region = (process.env.POSTHOG_REGION?.trim() || "us").toLowerCase() === "eu" ? "eu" : "us";
  const configuredProjectId = process.env.POSTHOG_PROJECT_ID?.trim() || "";
  return { composioKey, posthogKey, region, configuredProjectId };
}

// --- Composio Fetch Wrapper: Reads response body exactly once ---
interface ComposioResponse {
  ok: boolean;
  status: number;
  rawText: string;
  json: any | null;
}

async function composioFetch(
  method: "GET" | "POST",
  pathAndQuery: string,
  composioKey: string,
  body?: unknown,
  timeoutMs = 15000
): Promise<ComposioResponse> {
  try {
    const res = await fetch(`${COMPOSIO_BASE}${pathAndQuery}`, {
      method,
      headers: { "x-api-key": composioKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rawText = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(rawText);
    } catch {}
    return { ok: res.ok, status: res.status, rawText, json };
  } catch (err: any) {
    const message =
      err?.name === "TimeoutError" ? `Request timed out after ${timeoutMs}ms` : err?.message || String(err);
    return { ok: false, status: 0, rawText: message, json: null };
  }
}

// Composio HTTP errors look like { error: { message, errors: [...], suggested_fix, request_id } }.
function composioHttpError(resp: ComposioResponse): string {
  const e = resp.json?.error;
  if (e && typeof e === "object") {
    const parts = [e.message, ...(Array.isArray(e.errors) ? e.errors : []), e.suggested_fix].filter(
      (p) => typeof p === "string" && p.trim()
    );
    const msg = parts.join(" — ") || resp.rawText;
    return `Composio error (status ${resp.status}): ${msg}${e.request_id ? ` [Request ID: ${e.request_id}]` : ""}`;
  }
  if (typeof e === "string" && e.trim()) return `Composio error (status ${resp.status}): ${e.trim()}`;
  if (resp.status === 0) return `Could not reach Composio: ${resp.rawText}`;
  return `Composio error (status ${resp.status}): ${resp.rawText.trim() || "empty response"}`;
}

// PostHog keys and tokens (personal phx_, project phc_, secret phs_) never reach logs or the user.
function redactSecrets(text: string): string {
  return text.replace(/ph[cxs]_[A-Za-z0-9]+/g, "[redacted]");
}

// A tool that ran but failed upstream returns 200 with { successful: false, error, data: { status_code, message } }.
function toolFailureMessage(json: any): string {
  const status = json?.data?.status_code;
  const raw = json?.data?.message ?? json?.error;
  let detail = typeof raw === "string" ? raw.trim() : raw ? JSON.stringify(raw) : "";
  try {
    const parsed = JSON.parse(detail);
    if (typeof parsed?.detail === "string") detail = parsed.detail;
  } catch {}
  return `PostHog error${status ? ` (status ${status})` : ""}: ${detail || "tool execution failed"}`;
}

function extractArray(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.projects)) return data.projects;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

// PostHog list endpoints report the full total in `count`; fall back to the page length.
function totalCount(data: any): number {
  return typeof data?.count === "number" ? data.count : extractArray(data).length;
}

// --- Composio auth: one API_KEY auth config + one connected account per PostHog key/region ---
interface ConnectedAccount {
  userId: string;
  connectedAccountId: string;
}
let accountPromise: { userId: string; promise: Promise<ConnectedAccount> } | null = null;

// Stable, non-reversible user_id: a new key or region gets its own connected account.
function composioUserId(posthogKey: string, region: string): string {
  return `voiceos-posthog-${createHash("sha256").update(`${region}:${posthogKey}`).digest("hex").slice(0, 16)}`;
}

async function findOrCreateConnectedAccount(
  composioKey: string,
  posthogKey: string,
  region: string,
  userId: string
): Promise<ConnectedAccount> {
  const existing = await composioFetch(
    "GET",
    `/connected_accounts?toolkit_slugs=posthog&user_ids=${encodeURIComponent(userId)}&statuses=ACTIVE`,
    composioKey
  );
  if (!existing.ok) throw new Error(composioHttpError(existing));
  const found = existing.json?.items?.[0]?.id;
  if (found) return { userId, connectedAccountId: String(found) };

  const configs = await composioFetch("GET", "/auth_configs?toolkit_slug=posthog", composioKey);
  if (!configs.ok) throw new Error(composioHttpError(configs));
  let authConfigId: string | undefined = configs.json?.items?.find(
    (c: any) => c.auth_scheme === "API_KEY" && c.status !== "DISABLED"
  )?.id;

  if (!authConfigId) {
    const created = await composioFetch("POST", "/auth_configs", composioKey, {
      toolkit: { slug: "posthog" },
      auth_config: { type: "use_custom_auth", authScheme: "API_KEY", credentials: {} },
    });
    if (!created.ok) throw new Error(composioHttpError(created));
    authConfigId = created.json?.auth_config?.id;
    if (!authConfigId) throw new Error("Composio created a PostHog auth config but returned no ID.");
  }

  // Field names come from GET /toolkits/posthog → auth_config_details[API_KEY].
  const connected = await composioFetch("POST", "/connected_accounts", composioKey, {
    auth_config: { id: authConfigId },
    connection: {
      user_id: userId,
      state: { authScheme: "API_KEY", val: { status: "ACTIVE", generic_api_key: posthogKey, subdomain: region } },
    },
  });
  if (!connected.ok) throw new Error(composioHttpError(connected));
  if (!connected.json?.id) throw new Error("Composio created a PostHog connection but returned no ID.");
  return { userId, connectedAccountId: String(connected.json.id) };
}

function getConnectedAccount(composioKey: string, posthogKey: string, region: string): Promise<ConnectedAccount> {
  const userId = composioUserId(posthogKey, region);
  if (accountPromise?.userId !== userId) {
    // Shared promise so concurrent tool calls don't create duplicate connections.
    const promise = findOrCreateConnectedAccount(composioKey, posthogKey, region, userId);
    accountPromise = { userId, promise };
    promise.catch(() => {
      if (accountPromise?.promise === promise) accountPromise = null;
    });
  }
  return accountPromise.promise;
}

async function executeComposioAction(
  actionName: string,
  params: Record<string, any>,
  composioKey: string,
  posthogKey: string,
  region: string
): Promise<{ ok: boolean; data?: any; error?: string }> {
  let account: ConnectedAccount;
  try {
    account = await getConnectedAccount(composioKey, posthogKey, region);
  } catch (err: any) {
    const error = redactSecrets(err.message);
    console.error(`[Composio] Connection setup failed: ${error}`);
    return { ok: false, error };
  }

  const resp = await composioFetch("POST", `/tools/execute/${actionName}`, composioKey, {
    connected_account_id: account.connectedAccountId,
    user_id: account.userId,
    arguments: params,
  });

  if (!resp.ok) {
    // The connection may have been removed in Composio; re-resolve it on the next call.
    accountPromise = null;
    const error = redactSecrets(composioHttpError(resp));
    console.error(`[Composio] ${actionName}: ${error}`);
    return { ok: false, error };
  }
  if (resp.json?.successful !== true) {
    const error = redactSecrets(toolFailureMessage(resp.json));
    console.error(`[Composio] ${actionName}: ${error}`);
    return { ok: false, error };
  }
  return { ok: true, data: resp.json.data };
}

// --- Project resolution: setting → explicit arg → auto-detect ---
async function resolveProjectId(
  composioKey: string,
  posthogKey: string,
  region: string,
  argProjectId?: string
): Promise<{ projectId: string; error?: string }> {
  if (argProjectId?.trim()) return { projectId: argProjectId.trim() };

  const { configuredProjectId } = getEnvConfig();
  if (configuredProjectId) return { projectId: configuredProjectId };
  if (memoryProjectId) return { projectId: memoryProjectId };

  const res = await executeComposioAction(
    "POSTHOG_LIST_ALL_PROJECTS_ACROSS_ORGANIZATIONS",
    {},
    composioKey,
    posthogKey,
    region
  );
  if (!res.ok) return { projectId: "", error: res.error || "Failed to list PostHog projects." };

  const projects = extractArray(res.data);
  if (projects.length === 0) {
    return {
      projectId: "",
      error: "No PostHog projects found in your account. Please create a project in PostHog first.",
    };
  }
  if (projects.length === 1) {
    memoryProjectId = String(projects[0].id);
    return { projectId: memoryProjectId };
  }

  const list = projects.map((p: any) => `"${p.name || "Untitled"}" (ID: ${p.id})`).join(", ");
  return {
    projectId: "",
    error: `Multiple PostHog projects found: ${list}. Please specify your preferred Project ID in integration settings (POSTHOG_PROJECT_ID) or pass project_id.`,
  };
}

// --- Error result: full message in both the data and the card ---
function errorResult(css: string, eyebrow: string, err: string) {
  // ~52 chars per line at 12px in the notch card; grow the card instead of clipping the message.
  const lines = Math.max(1, Math.ceil(err.length / 52));
  const card = renderCustom({
    accent: ACCENT,
    css,
    body: `<div class="ph"><div class="ph-hd">${markHtml()}<span class="ph-eyebrow">${esc(eyebrow)}</span></div><div class="ph-err">${esc(err)}</div></div>`,
    height: Math.min(420, 86 + lines * 17),
  });
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: err, _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] } }) }],
  };
}

// --- Formatting Helpers ---
// Glance cards show at most this many rows; the data returned to the model is not capped by it.
const CARD_ROW_CAP = 5;
const CARD_MORE_HEIGHT = 20;

function moreRow(hidden: number): string {
  return hidden > 0 ? `<div class="ph-more">+${hidden} more</div>` : "";
}
function formatVolume(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) return "—";
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (val >= 1_000) return (val / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(val);
}

function parseRollout(flag: any): string {
  if (!flag.active) return "Inactive";
  const groups = flag.filters?.groups;
  if (Array.isArray(groups) && groups.length > 0) {
    const pct = groups[0].rollout_percentage;
    if (pct !== undefined && pct !== null) {
      return `${pct}% of users`;
    }
    return "Filtered rollout";
  }
  return "100% of users";
}

// --- PostHog shape helpers ---
// Insights carry their type in query.source.kind (e.g. "TrendsQuery"); legacy ones in filters.insight.
function insightKind(i: any): string {
  const kind = i?.query?.source?.kind || i?.query?.kind || i?.filters?.insight || "";
  return String(kind).replace(/Query$/, "").replace(/Node$/, "").toLowerCase() || "insight";
}

// Compact, model-friendly view of an insight: metadata plus per-series results.
function summarizeInsight(i: any) {
  const result = Array.isArray(i?.result) ? i.result : [];
  const series = result.slice(0, 10).map((r: any) => {
    if (Array.isArray(r)) {
      // Breakdown funnels: one array of steps per breakdown value.
      return { steps: r.map((st: any) => ({ name: st.custom_name || st.name, count: st.count })) };
    }
    return {
      label: r.label ?? r.custom_name ?? r.name ?? r.action?.custom_name,
      count: r.count,
      aggregated_value: r.aggregated_value,
      ...(Array.isArray(r.data) ? { data: r.data.slice(-31), labels: (r.labels ?? r.days ?? []).slice(-31) } : {}),
    };
  });
  return {
    id: i?.id,
    short_id: i?.short_id,
    name: i?.name || i?.derived_name,
    description: i?.description || "",
    type: insightKind(i),
    last_refresh: i?.last_refresh,
    series,
  };
}

function summarizeTile(t: any): { type: "insight" | "text"; title: string; insight_id?: number; short_id?: string } {
  if (t?.insight) {
    return { type: "insight", title: t.insight.name || t.insight.derived_name || "Untitled insight", insight_id: t.insight.id, short_id: t.insight.short_id };
  }
  // Text tiles are markdown; keep the first meaningful line.
  const firstLine = String(t?.text?.body || "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean);
  return { type: "text", title: firstLine || "Text card" };
}

// --- Shared SVGs ---
const PIN_ICON = `<svg width="12" height="12" viewBox="0 0 16 16" fill="var(--accent)" stroke="currentColor" stroke-width="0.5"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.986-1.414.791-.195-.195.596-1.219.791-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/></svg>`;
const LAYOUT_ICON = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6.5h12M7 6.5v7.5"/></svg>`;

// ============================================================================
// Tool 1: list_feature_flags
// ============================================================================
server.registerTool(
  "list_feature_flags",
  {
    title: "List feature flags",
    description: "List the feature flags in your PostHog project with their on/off status and rollout. Use when the user asks which flags exist or for an overview of flags. For one specific flag's full details use get_feature_flag.",
    inputSchema: {
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
      limit: z.number().min(1).max(10).optional().describe("Number of flags to list (1-10, default 5)."),
    } as any,
  },
  async (args: any) => {
    const { composioKey, posthogKey, region } = getEnvConfig();
    const CSS = `
.ph{font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;padding:12px 14px 10px}
.ph-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.ph-eyebrow{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-4)}
.ph-badge{margin-left:auto;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);font-variant-numeric:tabular-nums}
.ph-rw{display:flex;align-items:center;height:38px;border-top:1px solid var(--line)}
.ph-rw:first-of-type{border-top:0}
.ph-flag-info{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
.ph-flag-key{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12.5px;font-weight:600;color:var(--ink-1);max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-flag-sub{font-size:11px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.ph-pill{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 7px;border-radius:999px;font-variant-numeric:tabular-nums;background:var(--fill-1);color:var(--ink-3)}
.ph-pill.on{background:color-mix(in srgb,var(--good) 15%,transparent);color:var(--good)}
.ph-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.3);flex:none}
.ph-pill.on .ph-dot{background:var(--good)}
.ph-filter-tag{display:inline-block;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent);margin-top:4px}
.ph-empty{padding:18px 0;text-align:center;font-size:12px;color:var(--ink-3)}
.ph-err{padding:10px 12px;border-radius:6px;border:1px solid color-mix(in srgb,var(--bad) 30%,transparent);background:color-mix(in srgb,var(--bad) 8%,transparent);color:var(--ink-1);font-size:12px;line-height:1.4}
.ph-more{padding:6px 0 0;font-size:11px;color:var(--ink-3)}
`;

    if (!composioKey) {
      const err = "Missing Composio API key. Please configure COMPOSIO_API_KEY in settings.";
      return errorResult(CSS, "FEATURE FLAGS", err);
    }
    if (!posthogKey) {
      const err = "Missing PostHog Personal API Key. Please configure POSTHOG_API_KEY in settings.";
      return errorResult(CSS, "FEATURE FLAGS", err);
    }

    const { projectId, error: projErr } = await resolveProjectId(composioKey, posthogKey, region, args.project_id);
    if (projErr || !projectId) {
      const err = projErr || "Could not resolve PostHog project ID.";
      return errorResult(CSS, "FEATURE FLAGS", err);
    }

    const limit = Math.min(Math.max(args.limit || 5, 1), 10);
    const res = await executeComposioAction(
      "POSTHOG_LIST_AND_MANAGE_PROJECT_FEATURE_FLAGS",
      { project_id: projectId, limit },
      composioKey,
      posthogKey,
      region
    );

    if (!res.ok) {
      const err = res.error || "Failed to fetch feature flags.";
      return errorResult(CSS, "FEATURE FLAGS", err);
    }

    const totalFlags = totalCount(res.data);
    const flags = extractArray(res.data).slice(0, limit);

    let contentHtml = "";
    if (flags.length === 0) {
      contentHtml = `<div class="ph-empty">No feature flags in project</div>`;
    } else if (flags.length === 1) {
      const f = flags[0];
      const rollout = parseRollout(f);
      contentHtml = `
        <div class="ph-rw" style="height:auto;padding:6px 0">
          <div class="ph-flag-info">
            <span class="ph-flag-key">${esc(clip(f.key || "unnamed", 36))}</span>
            <span class="ph-flag-sub">${esc(clip(f.name || rollout, 44))}</span>
            <div><span class="ph-filter-tag">${esc(rollout)}</span></div>
          </div>
          <div class="ph-pill${f.active ? " on" : ""}">
            <span class="ph-dot"></span>${f.active ? "ON" : "OFF"}
          </div>
        </div>`;
    } else {
      contentHtml = flags.slice(0, CARD_ROW_CAP).map((f: any) => {
        const rollout = parseRollout(f);
        return `
          <div class="ph-rw">
            <div class="ph-flag-info">
              <span class="ph-flag-key">${esc(clip(f.key || "unnamed", 30))}</span>
              <span class="ph-flag-sub">${esc(clip(f.name || rollout, 36))}</span>
            </div>
            <div class="ph-pill${f.active ? " on" : ""}">
              <span class="ph-dot"></span>${f.active ? "ON" : "OFF"}
            </div>
          </div>`;
      }).join("") + moreRow(totalFlags - Math.min(flags.length, CARD_ROW_CAP));
    }

    const flagRows = Math.min(flags.length, CARD_ROW_CAP);
    const flagsHidden = flags.length > 1 && totalFlags > flagRows;
    const estimatedHeight =
      flags.length === 0 ? 100 : flags.length === 1 ? 116 : 46 + flagRows * 38 + (flagsHidden ? CARD_MORE_HEIGHT : 0);
    const card = renderCustom({
      accent: ACCENT,
      css: CSS,
      body: `<div class="ph">
        <div class="ph-hd">
          ${markHtml()}
          <span class="ph-eyebrow">FEATURE FLAGS</span>
          <span class="ph-badge">${esc(String(totalFlags))} total</span>
        </div>
        ${contentHtml}
      </div>`,
      height: estimatedHeight,
    });

    const payload = {
      project_id: projectId,
      total_flags: totalFlags,
      flags: flags.map((f: any) => ({
        key: f.key,
        name: f.name,
        active: Boolean(f.active),
        rollout: parseRollout(f),
      })),
      _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
  }
);

// ============================================================================
// Tool 2: get_insights
// ============================================================================
server.registerTool(
  "get_insights",
  {
    title: "Get insights",
    description: "List the project's saved insights, or get the latest results of one saved insight by ID or short ID. Use when the user asks about saved insights or charts they already have in PostHog. For an ad-hoc funnel between events use get_funnel, for retention use get_retention, and for a custom question use run_query.",
    inputSchema: {
      insight_id: z.string().optional().describe("Optional insight ID or short_id to get detailed metrics."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const { composioKey, posthogKey, region } = getEnvConfig();
    const CSS = `
.ph{font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;padding:12px 14px 10px}
.ph-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.ph-eyebrow{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-4)}
.ph-badge{margin-left:auto;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);font-variant-numeric:tabular-nums}
.ph-rw{display:flex;align-items:center;gap:8px;height:42px;border-top:1px solid var(--line)}
.ph-rw:first-of-type{border-top:0}
.ph-ins-m{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
.ph-ins-top{display:flex;align-items:center;gap:6px}
.ph-ins-id{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:10px;color:var(--ink-4)}
.ph-ins-title{font-size:13px;font-weight:500;color:var(--ink-1);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-pill{flex:none;font-size:10px;font-weight:600;letter-spacing:.02em;padding:2px 6px;border-radius:4px;background:var(--fill-2);color:var(--ink-2);text-transform:capitalize}
.ph-hero{padding:4px 0 6px}
.ph-hero-name{font-size:13px;font-weight:500;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-hero-val{font-size:32px;font-weight:700;letter-spacing:-.02em;color:var(--ink-1);font-variant-numeric:tabular-nums;line-height:1.2;margin:2px 0 6px}
.ph-spk{width:100%;height:26px;display:block}
.ph-delta{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 6px;border-radius:4px;background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent);margin-bottom:4px}
.ph-empty{padding:18px 0;text-align:center;font-size:12px;color:var(--ink-3)}
.ph-err{padding:10px 12px;border-radius:6px;border:1px solid color-mix(in srgb,var(--bad) 30%,transparent);background:color-mix(in srgb,var(--bad) 8%,transparent);color:var(--ink-1);font-size:12px;line-height:1.4}
.ph-more{padding:6px 0 0;font-size:11px;color:var(--ink-3)}
`;

    if (!composioKey || !posthogKey) {
      const err = !composioKey
        ? "Missing Composio API key. Please configure COMPOSIO_API_KEY in settings."
        : "Missing PostHog Personal API Key. Please configure POSTHOG_API_KEY in settings.";
      return errorResult(CSS, "INSIGHTS", err);
    }

    const { projectId, error: projErr } = await resolveProjectId(composioKey, posthogKey, region, args.project_id);
    if (projErr || !projectId) {
      const err = projErr || "Could not resolve PostHog project ID.";
      return errorResult(CSS, "INSIGHTS", err);
    }

    // Detail mode vs List mode
    if (args.insight_id?.trim()) {
      const insightId = args.insight_id.trim();
      const res = await executeComposioAction(
        "POSTHOG_RETRIEVE_PROJECT_INSIGHT_DETAILS",
        // Numeric primary key or 8-char short_id; "blocking" computes results if the cache is empty.
        { project_id: projectId, id: /^\d+$/.test(insightId) ? Number(insightId) : insightId, refresh: "blocking" },
        composioKey,
        posthogKey,
        region
      );

      if (!res.ok) {
        const err = res.error || `Insight #${insightId} could not be retrieved.`;
        return errorResult(CSS, "INSIGHT DETAIL", err);
      }

      const item = res.data || {};
      const insightName = item.name || item.short_id || "Insight Metric";
      const resultData = item.result;

      let heroVal = "—";
      let sparkPoints = "";
      if (Array.isArray(resultData) && resultData.length > 0) {
        const series = resultData[0];
        const rawPoints = Array.isArray(series.data) ? series.data : [];
        if (rawPoints.length > 0) {
          const numbers = rawPoints.map((p: any) => typeof p === "number" ? p : Number(p?.value ?? p?.count ?? 0)).filter((n: number) => !isNaN(n));
          if (numbers.length > 0) {
            const lastVal = numbers[numbers.length - 1];
            heroVal = formatVolume(lastVal);
            const min = Math.min(...numbers);
            const max = Math.max(...numbers);
            const range = max - min || 1;
            sparkPoints = numbers.map((n: number, idx: number) => {
              const x = (idx / Math.max(numbers.length - 1, 1)) * 100;
              const y = 24 - ((n - min) / range) * 20;
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            }).join(" ");
          }
        } else if (series.count !== undefined) {
          heroVal = formatVolume(series.count);
        }
      }

      const typeLabel = insightKind(item);
      const sparkSvg = sparkPoints ? `
        <svg class="ph-spk" viewBox="0 0 100 26" preserveAspectRatio="none">
          <polyline points="${sparkPoints}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"/>
        </svg>` : "";

      const card = renderCustom({
        accent: ACCENT,
        css: CSS,
        body: `<div class="ph">
          <div class="ph-hd">
            ${markHtml()}
            <span class="ph-eyebrow">INSIGHT</span>
            <span class="ph-badge">${esc(typeLabel)}</span>
          </div>
          <div class="ph-hero">
            <div class="ph-hero-name">${esc(clip(insightName, 38))}</div>
            <div class="ph-hero-val">${esc(heroVal)}</div>
            ${sparkSvg}
          </div>
        </div>`,
        height: 154,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify({ insight: summarizeInsight(item), _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] } }) }] };
    }

    // List mode
    const res = await executeComposioAction(
      "POSTHOG_RETRIEVE_PROJECT_INSIGHTS_WITH_PAGINATION",
      { project_id: projectId, limit: 5 },
      composioKey,
      posthogKey,
      region
    );

    if (!res.ok) {
      const err = res.error || "Failed to retrieve project insights.";
      return errorResult(CSS, "INSIGHTS", err);
    }

    const totalInsights = totalCount(res.data);
    const insights = extractArray(res.data).slice(0, 5);

    let contentHtml = "";
    if (insights.length === 0) {
      contentHtml = `<div class="ph-empty">No insights found</div>`;
    } else {
      contentHtml = insights.slice(0, CARD_ROW_CAP).map((item: any) => {
        const sid = item.short_id || `#${item.id}`;
        const title = item.name || "Untitled Insight";
        const typePill = insightKind(item);
        return `
          <div class="ph-rw">
            <div class="ph-ins-m">
              <div class="ph-ins-top"><span class="ph-ins-id">${esc(sid)}</span></div>
              <span class="ph-ins-title">${esc(clip(title, 34))}</span>
            </div>
            <span class="ph-pill">${esc(typePill)}</span>
          </div>`;
      }).join("") + moreRow(totalInsights - Math.min(insights.length, CARD_ROW_CAP));
    }

    const insightRows = Math.min(insights.length, CARD_ROW_CAP);
    const estimatedHeight =
      insights.length === 0 ? 100 : 46 + insightRows * 42 + (totalInsights > insightRows ? CARD_MORE_HEIGHT : 0);
    const card = renderCustom({
      accent: ACCENT,
      css: CSS,
      body: `<div class="ph">
        <div class="ph-hd">
          ${markHtml()}
          <span class="ph-eyebrow">SAVED INSIGHTS</span>
          <span class="ph-badge">${esc(String(totalInsights))}</span>
        </div>
        ${contentHtml}
      </div>`,
      height: estimatedHeight,
    });

    const payload = {
      project_id: projectId,
      total_insights: totalInsights,
      insights: insights.map((i: any) => ({
        id: i.id,
        short_id: i.short_id,
        name: i.name,
        type: insightKind(i),
      })),
      _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
  }
);

// ============================================================================
// Tool 3: get_dashboard
// ============================================================================
server.registerTool(
  "get_dashboard",
  {
    title: "Get dashboard",
    description: "List project dashboards with pinned status and card counts, or view details for a specific dashboard. Use when the user asks for PostHog dashboards.",
    inputSchema: {
      dashboard_id: z.string().optional().describe("Optional dashboard ID to retrieve specific dashboard cards."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const { composioKey, posthogKey, region } = getEnvConfig();
    const CSS = `
.ph{font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;padding:12px 14px 10px}
.ph-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.ph-eyebrow{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-4)}
.ph-badge{margin-left:auto;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);font-variant-numeric:tabular-nums}
.ph-rw{display:flex;align-items:center;gap:8px;height:40px;margin-bottom:6px;padding:0 10px;border-radius:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06)}
.ph-db-m{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
.ph-db-top{display:flex;align-items:center;gap:5px}
.ph-pin{color:var(--accent);flex:none;display:inline-flex}
.ph-db-title{font-size:13px;font-weight:600;color:var(--ink-1);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-db-sub{font-size:11px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.ph-pill{flex:none;font-size:11px;font-weight:500;padding:2px 7px;border-radius:4px;background:var(--fill-1);color:var(--ink-3);font-variant-numeric:tabular-nums}
.ph-preview-item{display:flex;align-items:center;height:28px;padding:0 8px;border-top:1px solid var(--line);font-size:12px;color:var(--ink-2)}
.ph-preview-item:first-of-type{border-top:0}
.ph-empty{padding:18px 0;text-align:center;font-size:12px;color:var(--ink-3);display:flex;flex-direction:column;align-items:center;gap:6px}
.ph-empty svg{opacity:.4}
.ph-err{padding:10px 12px;border-radius:6px;border:1px solid color-mix(in srgb,var(--bad) 30%,transparent);background:color-mix(in srgb,var(--bad) 8%,transparent);color:var(--ink-1);font-size:12px;line-height:1.4}
.ph-more{padding:6px 0 0;font-size:11px;color:var(--ink-3)}
`;

    if (!composioKey || !posthogKey) {
      const err = !composioKey
        ? "Missing Composio API key. Please configure COMPOSIO_API_KEY in settings."
        : "Missing PostHog Personal API Key. Please configure POSTHOG_API_KEY in settings.";
      return errorResult(CSS, "DASHBOARDS", err);
    }

    const { projectId, error: projErr } = await resolveProjectId(composioKey, posthogKey, region, args.project_id);
    if (projErr || !projectId) {
      const err = projErr || "Could not resolve PostHog project ID.";
      return errorResult(CSS, "DASHBOARDS", err);
    }

    // Detail mode for a single dashboard ID
    if (args.dashboard_id?.trim()) {
      const dId = args.dashboard_id.trim();
      if (!/^\d+$/.test(dId)) {
        return errorResult(CSS, "DASHBOARD", `Dashboard ID must be numeric (got "${dId}"). List dashboards first to find the ID.`);
      }
      const res = await executeComposioAction(
        "POSTHOG_RETRIEVE_SPECIFIC_PROJECT_DASHBOARD_DETAILS",
        { project_id: projectId, id: Number(dId) },
        composioKey,
        posthogKey,
        region
      );

      if (!res.ok) {
        const err = res.error || `Dashboard #${dId} could not be retrieved.`;
        return errorResult(CSS, "DASHBOARD", err);
      }

      const d = res.data || {};
      const tiles = (Array.isArray(d.tiles) ? d.tiles : []).filter((t: any) => !t.deleted);
      const tileSummaries = tiles.map(summarizeTile);
      // Preview insight cards first; text tiles are usually section headings.
      const previewList = [...tileSummaries.filter((t) => t.type === "insight"), ...tileSummaries.filter((t) => t.type !== "insight")]
        .slice(0, 3)
        .map((t) => `<div class="ph-preview-item">• ${esc(clip(t.title, 40))}</div>`)
        .join("");

      const card = renderCustom({
        accent: ACCENT,
        css: CSS,
        body: `<div class="ph">
          <div class="ph-hd">
            ${markHtml()}
            <span class="ph-eyebrow">DASHBOARD DETAIL</span>
            <span class="ph-badge">${esc(String(tiles.length))} cards</span>
          </div>
          <div class="ph-rw" style="height:auto;padding:8px 10px;margin-bottom:8px">
            <div class="ph-db-m">
              <div class="ph-db-top">
                ${d.pinned ? `<span class="ph-pin">${PIN_ICON}</span>` : ""}
                <span class="ph-db-title">${esc(clip(d.name || "Untitled Board", 36))}</span>
              </div>
              <span class="ph-db-sub">${esc(clip(d.description || "Project dashboard", 48))}</span>
            </div>
          </div>
          ${previewList || `<div class="ph-empty">No cards on this board</div>`}
        </div>`,
        height: 178,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify({ dashboard: { id: d.id, name: d.name, description: d.description || "", pinned: Boolean(d.pinned), tile_count: tiles.length, tiles: tileSummaries }, _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] } }) }] };
    }

    // List mode
    const res = await executeComposioAction(
      "POSTHOG_LIST_PROJECT_DASHBOARDS",
      { project_id: projectId },
      composioKey,
      posthogKey,
      region
    );

    if (!res.ok) {
      const err = res.error || "Failed to list project dashboards.";
      return errorResult(CSS, "DASHBOARDS", err);
    }

    const totalDashboards = totalCount(res.data);
    const dashboards = extractArray(res.data).slice(0, 5);

    let contentHtml = "";
    if (dashboards.length === 0) {
      contentHtml = `<div class="ph-empty">${LAYOUT_ICON}<span>No dashboards found</span></div>`;
    } else {
      contentHtml = dashboards.slice(0, CARD_ROW_CAP).map((d: any) => {
        const count = d.tiles?.length ?? d.items?.length ?? 0;
        return `
          <div class="ph-rw">
            <div class="ph-db-m">
              <div class="ph-db-top">
                ${d.pinned ? `<span class="ph-pin">${PIN_ICON}</span>` : ""}
                <span class="ph-db-title">${esc(clip(d.name || "Untitled", 32))}</span>
              </div>
              <span class="ph-db-sub">${esc(clip(d.description || "Dashboard", 40))}</span>
            </div>
            <span class="ph-pill">${count ? `${count} cards` : "board"}</span>
          </div>`;
      }).join("") + moreRow(totalDashboards - Math.min(dashboards.length, CARD_ROW_CAP));
    }

    const dashboardRows = Math.min(dashboards.length, CARD_ROW_CAP);
    const estimatedHeight =
      dashboards.length === 0 ? 110 : 46 + dashboardRows * 46 + (totalDashboards > dashboardRows ? CARD_MORE_HEIGHT : 0);
    const card = renderCustom({
      accent: ACCENT,
      css: CSS,
      body: `<div class="ph">
        <div class="ph-hd">
          ${markHtml()}
          <span class="ph-eyebrow">DASHBOARDS</span>
          <span class="ph-badge">${esc(String(totalDashboards))}</span>
        </div>
        ${contentHtml}
      </div>`,
      height: estimatedHeight,
    });

    const payload = {
      project_id: projectId,
      total_dashboards: totalDashboards,
      dashboards: dashboards.map((d: any) => ({
        id: d.id,
        name: d.name,
        pinned: Boolean(d.pinned),
        description: d.description,
      })),
      _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
  }
);

// ============================================================================
// Tool 4: get_event_definitions
// ============================================================================
server.registerTool(
  "get_event_definitions",
  {
    title: "Get event definitions",
    description: "List tracked event definitions and schema with 30-day ingestion volume. Use when the user asks about tracked events, event schemas, or event volume in PostHog.",
    inputSchema: {
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
      limit: z.number().min(1).max(15).optional().describe("Number of event definitions to list (1-15, default 6)."),
    } as any,
  },
  async (args: any) => {
    const { composioKey, posthogKey, region } = getEnvConfig();
    const CSS = `
.ph{font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;padding:12px 14px 10px}
.ph-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ph-eyebrow{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-4)}
.ph-badge{margin-left:auto;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);font-variant-numeric:tabular-nums}
.ph-tbl-hd{display:flex;align-items:center;justify-content:space-between;padding:4px 0 3px;font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--ink-4);text-transform:uppercase;border-bottom:1px solid var(--line)}
.ph-rw{display:flex;align-items:center;justify-content:space-between;height:32px;border-top:1px solid rgba(255,255,255,0.05)}
.ph-rw:first-of-type{border-top:0}
.ph-ev-name{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12.5px;color:var(--ink-1);max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:3px}
.ph-ev-pfx{color:var(--ink-4);font-size:11px}
.ph-vol{flex:none;min-width:68px;text-align:right;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ink-2)}
.ph-vol.ph-vol-top{color:var(--accent)}
.ph-single-bar{height:4px;border-radius:2px;background:var(--track);overflow:hidden;margin-top:8px}
.ph-single-bar i{display:block;height:100%;border-radius:2px;background:var(--accent);width:85%}
.ph-empty{padding:18px 0;text-align:center;font-size:12px;color:var(--ink-3)}
.ph-err{padding:10px 12px;border-radius:6px;border:1px solid color-mix(in srgb,var(--bad) 30%,transparent);background:color-mix(in srgb,var(--bad) 8%,transparent);color:var(--ink-1);font-size:12px;line-height:1.4}
.ph-more{padding:6px 0 0;font-size:11px;color:var(--ink-3)}
`;

    if (!composioKey || !posthogKey) {
      const err = !composioKey
        ? "Missing Composio API key. Please configure COMPOSIO_API_KEY in settings."
        : "Missing PostHog Personal API Key. Please configure POSTHOG_API_KEY in settings.";
      return errorResult(CSS, "EVENT SCHEMA", err);
    }

    const { projectId, error: projErr } = await resolveProjectId(composioKey, posthogKey, region, args.project_id);
    if (projErr || !projectId) {
      const err = projErr || "Could not resolve PostHog project ID.";
      return errorResult(CSS, "EVENT SCHEMA", err);
    }

    const limit = Math.min(Math.max(args.limit || 6, 1), 15);
    const res = await executeComposioAction(
      "POSTHOG_GET_EVENT_DEFINITIONS",
      { project_id: projectId, limit },
      composioKey,
      posthogKey,
      region
    );

    if (!res.ok) {
      const err = res.error || "Failed to retrieve event definitions.";
      return errorResult(CSS, "EVENT SCHEMA", err);
    }

    const totalEvents = totalCount(res.data);
    const events = extractArray(res.data).slice(0, limit);

    let contentHtml = "";
    if (events.length === 0) {
      contentHtml = `<div class="ph-empty">No event definitions recorded</div>`;
    } else if (events.length === 1) {
      const ev = events[0];
      const isAuto = String(ev.name).startsWith("$");
      const cleanName = isAuto ? String(ev.name).slice(1) : String(ev.name);
      const volText = formatVolume(ev.volume_30_day);
      contentHtml = `
        <div class="ph-tbl-hd"><span>EVENT</span><span>30D VOLUME</span></div>
        <div class="ph-rw" style="height:36px">
          <div class="ph-ev-name"><span class="ph-ev-pfx">${isAuto ? "$" : "•"}</span><span>${esc(clip(cleanName, 32))}</span></div>
          <span class="ph-vol ph-vol-top">${esc(volText)}</span>
        </div>
        <div class="ph-single-bar"><i></i></div>`;
    } else {
      const rows = events.slice(0, CARD_ROW_CAP).map((ev: any, idx: number) => {
        const isAuto = String(ev.name).startsWith("$");
        const cleanName = isAuto ? String(ev.name).slice(1) : String(ev.name);
        const volText = formatVolume(ev.volume_30_day);
        const isTop = idx === 0;
        return `
          <div class="ph-rw">
            <div class="ph-ev-name">
              <span class="ph-ev-pfx">${isAuto ? "$" : "•"}</span>
              <span>${esc(clip(cleanName, 30))}</span>
            </div>
            <span class="ph-vol${isTop ? " ph-vol-top" : ""}">${esc(volText)}</span>
          </div>`;
      }).join("");

      contentHtml = `
        <div class="ph-tbl-hd"><span>EVENT</span><span>30D VOLUME</span></div>
        ${rows}${moreRow(totalEvents - Math.min(events.length, CARD_ROW_CAP))}`;
    }

    const eventRows = Math.min(events.length, CARD_ROW_CAP);
    const eventsHidden = events.length > 1 && totalEvents > eventRows;
    const estimatedHeight =
      events.length === 0 ? 100 : events.length === 1 ? 122 : 62 + eventRows * 32 + (eventsHidden ? CARD_MORE_HEIGHT : 0);
    const card = renderCustom({
      accent: ACCENT,
      css: CSS,
      body: `<div class="ph">
        <div class="ph-hd">
          ${markHtml()}
          <span class="ph-eyebrow">EVENT SCHEMA</span>
          <span class="ph-badge">${esc(String(totalEvents))} tracked</span>
        </div>
        ${contentHtml}
      </div>`,
      height: estimatedHeight,
    });

    const payload = {
      project_id: projectId,
      total_events: totalEvents,
      events: events.map((e: any) => ({
        name: e.name,
        volume_30_day: e.volume_30_day,
        formatted_volume: formatVolume(e.volume_30_day),
      })),
      _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
  }
);

// ============================================================================
// Shared plumbing for the tools below
// ============================================================================
const BASE_CSS = `
.ph{font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;padding:12px 14px 10px}
.ph-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.ph-eyebrow{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-4)}
.ph-err{padding:10px 12px;border-radius:6px;border:1px solid color-mix(in srgb,var(--bad) 30%,transparent);background:color-mix(in srgb,var(--bad) 8%,transparent);color:var(--ink-1);font-size:12px;line-height:1.4}
.ph-more{padding:6px 0 0;font-size:11px;color:var(--ink-3)}
`;

interface ToolCtx {
  composioKey: string;
  posthogKey: string;
  region: string;
  projectId: string;
}

// Keys + project, or a ready-made error result.
async function toolContext(
  eyebrow: string,
  argProjectId?: string
): Promise<{ ctx: ToolCtx; fail?: undefined } | { ctx?: undefined; fail: ReturnType<typeof errorResult> }> {
  const { composioKey, posthogKey, region } = getEnvConfig();
  if (!composioKey) {
    return { fail: errorResult(BASE_CSS, eyebrow, "Missing Composio API key. Please configure COMPOSIO_API_KEY in settings.") };
  }
  if (!posthogKey) {
    return { fail: errorResult(BASE_CSS, eyebrow, "Missing PostHog Personal API Key. Please configure POSTHOG_API_KEY in settings.") };
  }
  const { projectId, error } = await resolveProjectId(composioKey, posthogKey, region, argProjectId);
  if (error || !projectId) {
    return { fail: errorResult(BASE_CSS, eyebrow, error || "Could not resolve PostHog project ID.") };
  }
  return { ctx: { composioKey, posthogKey, region, projectId } };
}

// Every project-scoped call: the caller passes an explicit argument object, never the raw tool args.
function runInProject(ctx: ToolCtx, slug: string, args: Record<string, any>) {
  return executeComposioAction(slug, { ...args, project_id: ctx.projectId }, ctx.composioKey, ctx.posthogKey, ctx.region);
}

function glanceResult(payload: Record<string, any>, blocks: Array<Block | null | false | undefined>) {
  const card = renderWidget({ blocks, accent: ACCENT });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ...payload, _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] } }),
      },
    ],
  };
}

const positiveInt = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatDate(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function formatDuration(seconds: unknown): string {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

// ============================================================================
// Tool 5: get_feature_flag
// ============================================================================
server.registerTool(
  "get_feature_flag",
  {
    title: "Get feature flag",
    description:
      "Get full details of one PostHog feature flag by its ID or key: status, rollout conditions, variants, and who created it. Use when the user asks about a specific flag.",
    inputSchema: {
      flag_id: z.string().optional().describe("Numeric feature flag ID."),
      key: z.string().optional().describe("Feature flag key, e.g. 'new-checkout'. Used when no ID is given."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const flagIdArg = String(args.flag_id ?? "").trim();
    const keyArg = String(args.key ?? "").trim();
    if (!flagIdArg && !keyArg) return errorResult(BASE_CSS, "FEATURE FLAG", "Give a feature flag ID or key.");
    if (flagIdArg && positiveInt(flagIdArg) === null) {
      return errorResult(BASE_CSS, "FEATURE FLAG", `Feature flag ID must be numeric (got "${flagIdArg}").`);
    }

    const { ctx, fail } = await toolContext("FEATURE FLAG", args.project_id);
    if (fail) return fail;

    let flagId = flagIdArg ? positiveInt(flagIdArg)! : null;
    if (flagId === null) {
      // Resolve key → ID by paging the flag list (the details endpoint only takes IDs).
      for (let offset = 0; flagId === null; offset += 100) {
        const page = await runInProject(ctx, "POSTHOG_LIST_AND_MANAGE_PROJECT_FEATURE_FLAGS", { limit: 100, offset });
        if (!page.ok) return errorResult(BASE_CSS, "FEATURE FLAG", page.error || "Failed to list feature flags.");
        const rows = extractArray(page.data);
        const hit = rows.find((f: any) => String(f.key).toLowerCase() === keyArg.toLowerCase());
        if (hit) flagId = Number(hit.id);
        else if (!page.data?.next || rows.length === 0) {
          return errorResult(BASE_CSS, "FEATURE FLAG", `No feature flag with key "${keyArg}" in project ${ctx.projectId}.`);
        }
      }
    }

    const res = await runInProject(ctx, "POSTHOG_GET_FEATURE_FLAG_DETAILS", { id: flagId });
    if (!res.ok) return errorResult(BASE_CSS, "FEATURE FLAG", res.error || `Feature flag ${flagId} could not be retrieved.`);

    const f = res.data || {};
    const groups = Array.isArray(f.filters?.groups) ? f.filters.groups : [];
    const variants = Array.isArray(f.filters?.multivariate?.variants) ? f.filters.multivariate.variants : [];
    const payload = {
      project_id: ctx.projectId,
      flag: {
        id: f.id,
        key: f.key,
        name: f.name || "",
        active: Boolean(f.active),
        rollout: parseRollout(f),
        release_conditions: groups.map((g: any) => ({
          rollout_percentage: g.rollout_percentage ?? 100,
          property_filters: Array.isArray(g.properties) ? g.properties.length : 0,
          variant: g.variant ?? null,
        })),
        variants: variants.map((v: any) => ({ key: v.key, rollout_percentage: v.rollout_percentage })),
        tags: f.tags ?? [],
        experiments: Array.isArray(f.experiment_set) ? f.experiment_set.length : 0,
        created_at: f.created_at,
        created_by: [f.created_by?.first_name, f.created_by?.last_name].filter(Boolean).join(" ") || null,
      },
    };

    return glanceResult(payload, [
      vHeader({ title: "Feature flag", trailing: f.active ? "ON" : "OFF" }),
      vKeyValue([
        { label: "Key", value: String(f.key ?? "—") },
        { label: "Status", value: f.active ? "Active" : "Inactive", tone: f.active ? "good" : "neutral" },
        { label: "Rollout", value: parseRollout(f) },
        { label: "Conditions", value: `${groups.length} group${groups.length === 1 ? "" : "s"}${variants.length ? `, ${variants.length} variants` : ""}` },
        { label: "Created", value: formatDate(f.created_at) },
      ]),
    ]);
  }
);

// ============================================================================
// Tool 6: get_funnel
// ============================================================================
server.registerTool(
  "get_funnel",
  {
    title: "Get funnel insights",
    description:
      "Run a conversion funnel over 2 or more events in order and return how many users reached each step. Use when the user asks about conversion, drop-off, or a funnel between events.",
    inputSchema: {
      steps: z.array(z.string()).describe("Event names in funnel order, at least 2 (e.g. ['$pageview', 'signed_up'])."),
      date_from: z.string().optional().describe("Start of the date range, e.g. '-30d', '-7d', or '2026-01-01'. Default '-30d'."),
      window_days: z.number().optional().describe("Days a user has to complete the funnel (1-90, default 14)."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const steps = (Array.isArray(args.steps) ? args.steps : []).map((s: any) => String(s).trim()).filter(Boolean);
    if (steps.length < 2) {
      return errorResult(BASE_CSS, "FUNNEL", `A funnel needs at least 2 steps; got ${steps.length}. Name the events in order, e.g. "$pageview" then "signed_up".`);
    }
    if (steps.length > 10) return errorResult(BASE_CSS, "FUNNEL", `A funnel can have at most 10 steps; got ${steps.length}.`);

    const { ctx, fail } = await toolContext("FUNNEL", args.project_id);
    if (fail) return fail;

    const dateFrom = String(args.date_from || "-30d").trim();
    const windowDays = Math.min(Math.max(Math.round(Number(args.window_days) || 14), 1), 90);
    // POSTHOG_GET_FUNNEL_INSIGHTS_IN_PROJECT hits PostHog's legacy /insights/funnel/ endpoint, which rejects
    // personal API keys (403), so the funnel runs as a read-only FunnelsQuery on the query endpoint.
    const res = await runInProject(ctx, "POSTHOG_CREATE_QUERY_IN_PROJECT_BY_ID", {
      refresh: "blocking",
      query: {
        kind: "FunnelsQuery",
        series: steps.map((event: string) => ({ kind: "EventsNode", event, name: event })),
        dateRange: { date_from: dateFrom },
        funnelsFilter: { funnelWindowInterval: windowDays, funnelWindowIntervalUnit: "day" },
      },
    });
    if (!res.ok) return errorResult(BASE_CSS, "FUNNEL", res.error || "Failed to run the funnel.");

    const raw = Array.isArray(res.data?.results) ? res.data.results : [];
    // No events yet → PostHog returns an empty result; report every step as 0 rather than inventing numbers.
    const counts = steps.map((_: string, i: number) => Number(raw[i]?.count ?? 0));
    const first = counts[0];
    const stepRows = steps.map((event: string, i: number) => ({
      step: i + 1,
      event,
      users: counts[i],
      conversion_from_first_pct: pct(counts[i], first),
      conversion_from_previous_pct: i === 0 ? 100 : pct(counts[i], counts[i - 1]),
    }));
    const overall = pct(counts[counts.length - 1], first);

    const rows: RowItem[] = stepRows.map((s: any) => ({
      title: `${s.step}. ${s.event}`,
      subtitle: s.step === 1 ? "Entered funnel" : `${s.conversion_from_previous_pct}% from previous step`,
      trailing: formatVolume(s.users),
    }));
    return glanceResult(
      { project_id: ctx.projectId, date_from: dateFrom, window_days: windowDays, overall_conversion_pct: overall, steps: stepRows },
      [
        vHeader({ title: "Funnel", subtitle: `Since ${dateFrom} · ${windowDays}-day window`, trailing: `${overall}% overall` }),
        first === 0 ? vNote("No users entered this funnel in the date range.") : null,
        vList(rows),
      ]
    );
  }
);

// ============================================================================
// Tool 7: get_retention
// ============================================================================
server.registerTool(
  "get_retention",
  {
    title: "Get retention insights",
    description:
      "Calculate user retention: of the users who did a start event in each period, how many came back and did a return event later. Use when the user asks about retention, churn, or whether users come back.",
    inputSchema: {
      target_event: z.string().optional().describe("Event that puts a user into a cohort. Default '$pageview'."),
      returning_event: z.string().optional().describe("Event that counts as coming back. Defaults to the target event."),
      period: z.enum(["Day", "Week", "Month"]).optional().describe("Cohort period. Default 'Day'."),
      intervals: z.number().optional().describe("Number of periods to analyze (2-12, default 7)."),
      retention_type: z.enum(["first_time", "recurring"]).optional().describe("'first_time' (default) cohorts users by their first event; 'recurring' by any occurrence."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const { ctx, fail } = await toolContext("RETENTION", args.project_id);
    if (fail) return fail;

    const target = String(args.target_event || "$pageview").trim();
    const returning = String(args.returning_event || target).trim();
    const period = ["Day", "Week", "Month"].includes(args.period) ? args.period : "Day";
    const intervals = Math.min(Math.max(Math.round(Number(args.intervals) || 7), 2), 12);
    const retentionType = args.retention_type === "recurring" ? "retention_recurring" : "retention_first_time";

    const res = await runInProject(ctx, "POSTHOG_CREATE_PROJECT_RETENTION_INSIGHT", {
      refresh: "blocking",
      query: {
        kind: "RetentionQuery",
        retentionFilter: {
          period,
          totalIntervals: intervals,
          retentionType,
          targetEntity: { id: target, type: "events" },
          returningEntity: { id: returning, type: "events" },
        },
      },
    });
    if (!res.ok) return errorResult(BASE_CSS, "RETENTION", res.error || "Failed to calculate retention.");

    const cohorts = (Array.isArray(res.data?.results) ? res.data.results : []).map((c: any) => {
      const values = (Array.isArray(c.values) ? c.values : []).map((v: any) => Number(v?.count ?? 0));
      const size = values[0] ?? 0;
      return {
        cohort: c.label ?? formatDate(c.date),
        date: c.date,
        users: size,
        retained: values.slice(1),
        retained_pct: values.slice(1).map((v: number) => pct(v, size)),
      };
    });
    const totalUsers = cohorts.reduce((n: number, c: any) => n + c.users, 0);
    // Period-1 retention across cohorts that have had a full period-1 window (weighted by cohort size).
    const eligible = cohorts.filter((c: any) => c.retained.length > 0 && c.users > 0);
    const p1 = pct(
      eligible.reduce((n: number, c: any) => n + c.retained[0], 0),
      eligible.reduce((n: number, c: any) => n + c.users, 0)
    );

    const unit = period.toLowerCase();
    return glanceResult(
      { project_id: ctx.projectId, target_event: target, returning_event: returning, period, intervals, retention_type: retentionType, total_users: totalUsers, period_1_retention_pct: p1, cohorts },
      [
        vHeader({ title: "Retention", subtitle: `${target} → ${returning}`, trailing: `${intervals} ${unit}s` }),
        vStats([
          { label: "Users in cohorts", value: formatVolume(totalUsers) },
          { label: `${period} 1 retention`, value: `${p1}%` },
          { label: "Cohorts", value: String(cohorts.length) },
        ]),
        totalUsers === 0
          ? vNote(`No users did ${target} in this window yet.`)
          : vList(
              cohorts
                .filter((c: any) => c.users > 0)
                .slice(-5)
                .map((c: any) => ({ title: c.cohort, trailing: formatVolume(c.users), subtitle: c.retained_pct.length ? `${c.retained_pct[0]}% back in ${unit} 1` : "Too recent" }))
            ),
      ]
    );
  }
);

// ============================================================================
// Tool 8: run_query
// ============================================================================
const QUERY_ROW_CAP = 50;
server.registerTool(
  "run_query",
  {
    title: "Run report query",
    description:
      "Run a read-only HogQL (PostHog SQL) SELECT query and return up to 50 rows. Tables include events (event, timestamp, distinct_id, properties.$current_url, ...), persons, and sessions. Use when the user asks a custom data question no other PostHog tool answers.",
    inputSchema: {
      sql: z.string().describe("A single HogQL SELECT (or WITH ... SELECT) query, e.g. \"SELECT event, count() FROM events GROUP BY event ORDER BY count() DESC\"."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const sql = String(args.sql ?? "").trim().replace(/;+\s*$/, "");
    if (!sql) return errorResult(BASE_CSS, "QUERY", "Give a HogQL SELECT query to run.");
    if (!/^(select|with)\b/i.test(sql) || sql.includes(";")) {
      return errorResult(BASE_CSS, "QUERY", "Only a single read-only SELECT query is allowed.");
    }

    const { ctx, fail } = await toolContext("QUERY", args.project_id);
    if (fail) return fail;

    // Wrapping enforces the cap whatever LIMIT the query has; one extra row tells us if it was truncated.
    const res = await runInProject(ctx, "POSTHOG_CREATE_QUERY_IN_PROJECT_BY_ID", {
      refresh: "blocking",
      query: { kind: "HogQLQuery", query: `SELECT * FROM (\n${sql}\n) LIMIT ${QUERY_ROW_CAP + 1}` },
    });
    if (!res.ok) return errorResult(BASE_CSS, "QUERY", res.error || "Query failed.");
    if (res.data?.error) return errorResult(BASE_CSS, "QUERY", `PostHog query error: ${res.data.error}`);

    const columns: string[] = Array.isArray(res.data?.columns) ? res.data.columns.map(String) : [];
    const allRows: any[][] = Array.isArray(res.data?.results) ? res.data.results : [];
    const rows = allRows.slice(0, QUERY_ROW_CAP);
    const truncated = allRows.length > QUERY_ROW_CAP;
    const cell = (v: any) => (v === null || v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v));

    let body: Block;
    if (rows.length === 0) {
      body = vEmpty({ title: "No rows", hint: "The query ran but returned nothing." });
    } else if (rows.length === 1 && columns.length <= 3) {
      body = vStats(columns.map((c, i) => ({ label: c, value: cell(rows[0][i]) })));
    } else {
      body = vList(
        rows.map((r) => ({
          title: cell(r[0]),
          subtitle: r.length > 2 ? r.slice(1, -1).map((v, i) => `${columns[i + 1]}: ${cell(v)}`).join(" · ") : undefined,
          trailing: r.length > 1 ? cell(r[r.length - 1]) : undefined,
        }))
      );
    }

    return glanceResult(
      { project_id: ctx.projectId, columns, row_count: rows.length, truncated_at_50_rows: truncated, rows },
      [vHeader({ title: "Query", subtitle: columns.join(", "), trailing: `${rows.length}${truncated ? "+" : ""} rows` }), body]
    );
  }
);

// ============================================================================
// Tool 9: get_persons (read-only: only list/retrieve arguments are ever sent)
// ============================================================================
function summarizePerson(p: any, withProperties: boolean) {
  const props = p?.properties && typeof p.properties === "object" ? p.properties : {};
  return {
    id: p?.uuid ?? p?.id,
    name: p?.name || props.email || props.name || null,
    email: props.email ?? null,
    distinct_ids: Array.isArray(p?.distinct_ids) ? p.distinct_ids.slice(0, 5) : [],
    created_at: p?.created_at,
    ...(withProperties ? { properties: Object.fromEntries(Object.entries(props).slice(0, 25)) } : {}),
  };
}

server.registerTool(
  "get_persons",
  {
    title: "Get persons",
    description:
      "Look up people tracked in PostHog: list or search persons by email or distinct ID, or get one person's details and properties by their UUID. Read-only. Use when the user asks who a user is or wants to find users.",
    inputSchema: {
      person_id: z.string().optional().describe("Person UUID for one person's details."),
      search: z.string().optional().describe("Search by email (full text) or distinct ID (exact)."),
      limit: z.number().optional().describe("Number of persons to list (1-10, default 5)."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const personId = String(args.person_id ?? "").trim();
    if (personId && !UUID_RE.test(personId)) {
      return errorResult(BASE_CSS, "PERSONS", `Person ID must be a UUID (got "${personId}"). Use search to find someone by email or distinct ID.`);
    }
    const { ctx, fail } = await toolContext("PERSONS", args.project_id);
    if (fail) return fail;

    if (personId) {
      const res = await runInProject(ctx, "POSTHOG_RETRIEVE_PERSON_DETAILS_BY_ID", { id: personId });
      if (!res.ok) return errorResult(BASE_CSS, "PERSON", res.error || `Person ${personId} could not be retrieved.`);
      const person = summarizePerson(res.data, true);
      return glanceResult({ project_id: ctx.projectId, person }, [
        vHeader({ title: "Person", trailing: formatDate(person.created_at) }),
        vKeyValue([
          { label: "Name", value: String(person.name ?? "—") },
          { label: "Distinct ID", value: String(person.distinct_ids[0] ?? "—") },
          { label: "Properties", value: String(Object.keys(res.data?.properties ?? {}).length) },
        ]),
      ]);
    }

    const limit = Math.min(Math.max(Math.round(Number(args.limit) || 5), 1), 10);
    const search = String(args.search ?? "").trim();
    const res = await runInProject(ctx, "POSTHOG_LIST_OR_DELETE_PERSONS_WITH_OPTIONAL_FILTERS", search ? { limit, search } : { limit });
    if (!res.ok) return errorResult(BASE_CSS, "PERSONS", res.error || "Failed to list persons.");
    const persons = extractArray(res.data).slice(0, limit).map((p: any) => summarizePerson(p, false));

    return glanceResult(
      { project_id: ctx.projectId, search: search || null, count: persons.length, has_more: Boolean(res.data?.next), persons },
      [
        vHeader({ title: "Persons", subtitle: search ? `Matching "${search}"` : undefined, trailing: `${persons.length}${res.data?.next ? "+" : ""}` }),
        persons.length === 0
          ? vEmpty({ title: search ? "No matching persons" : "No persons yet", hint: search ? undefined : "Persons appear once events are captured." })
          : vList(persons.map((p: any) => ({ title: String(p.name ?? p.distinct_ids[0] ?? p.id), subtitle: String(p.distinct_ids[0] ?? ""), trailing: formatDate(p.created_at) }))),
      ]
    );
  }
);

// ============================================================================
// Tool 10: get_cohorts
// ============================================================================
function summarizeCohort(c: any) {
  return {
    id: c?.id,
    name: c?.name || "Untitled cohort",
    description: c?.description || "",
    people: c?.count ?? null,
    is_static: Boolean(c?.is_static),
    is_calculating: Boolean(c?.is_calculating),
    last_calculation: c?.last_calculation ?? null,
    created_at: c?.created_at,
  };
}

server.registerTool(
  "get_cohorts",
  {
    title: "Get cohorts",
    description:
      "List PostHog cohorts (saved groups of users) with their sizes, or get one cohort's details and filters by ID. Use when the user asks about cohorts, segments, or user groups.",
    inputSchema: {
      cohort_id: z.string().optional().describe("Numeric cohort ID for one cohort's details."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const cohortArg = String(args.cohort_id ?? "").trim();
    if (cohortArg && positiveInt(cohortArg) === null) {
      return errorResult(BASE_CSS, "COHORT", `Cohort ID must be numeric (got "${cohortArg}"). List cohorts first to find the ID.`);
    }
    const { ctx, fail } = await toolContext("COHORTS", args.project_id);
    if (fail) return fail;

    if (cohortArg) {
      const res = await runInProject(ctx, "POSTHOG_RETRIEVE_PROJECT_COHORT_DETAILS", { id: positiveInt(cohortArg) });
      if (!res.ok) return errorResult(BASE_CSS, "COHORT", res.error || `Cohort ${cohortArg} could not be retrieved.`);
      const cohort = { ...summarizeCohort(res.data), filters: res.data?.filters ?? null };
      return glanceResult({ project_id: ctx.projectId, cohort }, [
        vHeader({ title: "Cohort", trailing: cohort.is_static ? "Static" : "Dynamic" }),
        vKeyValue([
          { label: "Name", value: cohort.name },
          { label: "People", value: cohort.people === null ? "—" : formatVolume(cohort.people) },
          { label: "Last calculated", value: formatDate(cohort.last_calculation) },
        ]),
        cohort.description ? vNote(cohort.description) : null,
      ]);
    }

    const res = await runInProject(ctx, "POSTHOG_RETRIEVE_PROJECT_COHORTS_WITH_PAGINATION", { limit: 20 });
    if (!res.ok) return errorResult(BASE_CSS, "COHORTS", res.error || "Failed to list cohorts.");
    const cohorts = extractArray(res.data).map(summarizeCohort);
    const total = totalCount(res.data);
    return glanceResult({ project_id: ctx.projectId, total_cohorts: total, cohorts }, [
      vHeader({ title: "Cohorts", trailing: String(total) }),
      cohorts.length === 0
        ? vEmpty({ title: "No cohorts in this project" })
        : vList(cohorts.map((c: any) => ({ title: c.name, subtitle: c.description || (c.is_static ? "Static cohort" : "Dynamic cohort"), trailing: c.people === null ? "—" : `${formatVolume(c.people)} people` }))),
    ]);
  }
);

// ============================================================================
// Tool 11: get_actions
// ============================================================================
function summarizeAction(a: any) {
  const steps = Array.isArray(a?.steps) ? a.steps : [];
  return {
    id: a?.id,
    name: a?.name || "Untitled action",
    description: a?.description || "",
    tags: a?.tags ?? [],
    steps: steps.map((s: any) => ({ event: s.event ?? null, url: s.url ?? null, selector: s.selector ?? null, text: s.text ?? null })),
    created_at: a?.created_at,
  };
}

server.registerTool(
  "get_actions",
  {
    title: "Get actions",
    description:
      "List PostHog actions (named definitions that group events, like 'Signed up'), or get one action's matching steps by ID. Use when the user asks about actions or how an action is defined.",
    inputSchema: {
      action_id: z.string().optional().describe("Numeric action ID for one action's details."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const actionArg = String(args.action_id ?? "").trim();
    if (actionArg && positiveInt(actionArg) === null) {
      return errorResult(BASE_CSS, "ACTION", `Action ID must be numeric (got "${actionArg}"). List actions first to find the ID.`);
    }
    const { ctx, fail } = await toolContext("ACTIONS", args.project_id);
    if (fail) return fail;

    if (actionArg) {
      const res = await runInProject(ctx, "POSTHOG_RETRIEVE_PROJECT_ACTION_DETAILS_BY_ID", { id: positiveInt(actionArg) });
      if (!res.ok) return errorResult(BASE_CSS, "ACTION", res.error || `Action ${actionArg} could not be retrieved.`);
      const action = summarizeAction(res.data);
      return glanceResult({ project_id: ctx.projectId, action }, [
        vHeader({ title: action.name, trailing: `${action.steps.length} step${action.steps.length === 1 ? "" : "s"}` }),
        action.steps.length
          ? vList(action.steps.map((s: any) => ({ title: s.event || "Any event", subtitle: [s.url, s.selector, s.text].filter(Boolean).join(" · ") || undefined })))
          : vEmpty({ title: "This action has no steps" }),
      ]);
    }

    const res = await runInProject(ctx, "POSTHOG_LIST_PROJECT_ACTIONS", { limit: 20 });
    if (!res.ok) return errorResult(BASE_CSS, "ACTIONS", res.error || "Failed to list actions.");
    const actions = extractArray(res.data).map(summarizeAction);
    const total = totalCount(res.data);
    return glanceResult({ project_id: ctx.projectId, total_actions: total, actions }, [
      vHeader({ title: "Actions", trailing: String(total) }),
      actions.length === 0
        ? vEmpty({ title: "No actions in this project" })
        : vList(actions.map((a: any) => ({ title: a.name, subtitle: a.description || undefined, trailing: `${a.steps.length} step${a.steps.length === 1 ? "" : "s"}` }))),
    ]);
  }
);

// ============================================================================
// Tool 12: get_session_recordings
// ============================================================================
function summarizeRecording(r: any) {
  return {
    id: r?.id,
    person: r?.person?.name || r?.person?.properties?.email || r?.distinct_id || null,
    distinct_id: r?.distinct_id ?? null,
    start_time: r?.start_time,
    end_time: r?.end_time,
    duration_seconds: r?.recording_duration ?? null,
    active_seconds: r?.active_seconds ?? null,
    clicks: r?.click_count ?? null,
    keypresses: r?.keypress_count ?? null,
    console_errors: r?.console_error_count ?? null,
    start_url: r?.start_url ?? null,
    viewed: Boolean(r?.viewed),
  };
}

server.registerTool(
  "get_session_recordings",
  {
    title: "Get session recordings",
    description:
      "List recent PostHog session recordings with duration, user, and activity, or get one recording's details by ID. Use when the user asks about session replays or recordings.",
    inputSchema: {
      recording_id: z.string().optional().describe("Session recording ID for one recording's details."),
      limit: z.number().optional().describe("Number of recordings to list (1-10, default 5)."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const recordingId = String(args.recording_id ?? "").trim();
    const { ctx, fail } = await toolContext("RECORDINGS", args.project_id);
    if (fail) return fail;

    if (recordingId) {
      const res = await runInProject(ctx, "POSTHOG_RETRIEVE_SESSION_RECORDING_DETAILS", { id: recordingId });
      if (!res.ok) return errorResult(BASE_CSS, "RECORDING", res.error || `Recording ${recordingId} could not be retrieved.`);
      const recording = summarizeRecording(res.data);
      return glanceResult({ project_id: ctx.projectId, recording }, [
        vHeader({ title: "Session recording", trailing: formatDate(recording.start_time) }),
        vStats([
          { label: "Duration", value: formatDuration(recording.duration_seconds) },
          { label: "Clicks", value: String(recording.clicks ?? "—") },
          { label: "Console errors", value: String(recording.console_errors ?? "—"), tone: recording.console_errors ? "bad" : "neutral" },
        ]),
        vKeyValue([
          { label: "User", value: String(recording.person ?? "—") },
          { label: "Start URL", value: String(recording.start_url ?? "—") },
        ]),
      ]);
    }

    const limit = Math.min(Math.max(Math.round(Number(args.limit) || 5), 1), 10);
    const res = await runInProject(ctx, "POSTHOG_LIST_PROJECT_SESSION_RECORDINGS", { limit });
    if (!res.ok) return errorResult(BASE_CSS, "RECORDINGS", res.error || "Failed to list session recordings.");
    const recordings = extractArray(res.data).slice(0, limit).map(summarizeRecording);
    return glanceResult({ project_id: ctx.projectId, count: recordings.length, has_more: Boolean(res.data?.has_next), recordings }, [
      vHeader({ title: "Session recordings", trailing: `${recordings.length}${res.data?.has_next ? "+" : ""}` }),
      recordings.length === 0
        ? vEmpty({ title: "No session recordings yet", hint: "Recordings appear once the PostHog snippet captures sessions." })
        : vList(recordings.map((r: any) => ({ title: String(r.person ?? r.id), subtitle: `${formatDate(r.start_time)} · ${r.start_url ?? ""}`, trailing: formatDuration(r.duration_seconds) }))),
    ]);
  }
);

// ============================================================================
// Write-tool interlock
// ============================================================================
// VoiceOS shows a confirmation card only for tools whose manifest entry declares one. A write tool is
// registered only when this folder's manifest declares its card, so a stale or invalid manifest makes
// the write unavailable instead of letting it run unconfirmed.
const CONFIRMED_TOOLS: Set<string> = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL("./voiceos.integration.json", import.meta.url), "utf8"));
    return new Set((manifest.tools ?? []).filter((t: any) => t?.confirmation?.root).map((t: any) => String(t.name)));
  } catch (err: any) {
    console.error(`[PostHog] Could not read voiceos.integration.json; write tools disabled: ${err.message}`);
    return new Set<string>();
  }
})();

function registerWriteTool(name: string, config: any, handler: (args: any) => Promise<any>) {
  if (!CONFIRMED_TOOLS.has(name)) {
    console.error(`[PostHog] "${name}" not registered: its manifest entry has no confirmation card.`);
    return;
  }
  server.registerTool(name, config, handler);
}

// ============================================================================
// Tool 13: create_feature_flag (write — confirmation card in manifest)
// ============================================================================
registerWriteTool(
  "create_feature_flag",
  {
    title: "Create feature flag",
    description:
      "Create a new boolean feature flag in PostHog. New flags are created OFF with 0% rollout unless the user explicitly asks for it to be on or names a percentage. Use when the user asks to add, create, or set up a feature flag.",
    inputSchema: {
      key: z.string().describe("Flag key used in code: letters, numbers, hyphens, underscores (e.g. 'new-checkout')."),
      name: z.string().optional().describe("Human-readable description of the flag."),
      rollout_percentage: z.union([z.string(), z.number()]).describe("Percent of users who get the flag, 0-100. Use \"0\" unless the user explicitly names a percentage."),
      active: z.union([z.boolean(), z.string()]).describe("Whether the flag is on immediately. Use false unless the user explicitly asks for it to be on."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const key = String(args.key ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,400}$/.test(key)) {
      return errorResult(BASE_CSS, "CREATE FLAG", `Flag key "${key}" is invalid. Use only letters, numbers, hyphens, and underscores.`);
    }
    // Safe defaults: a blank or missing rollout is 0%, and the flag stays off unless explicitly turned on.
    const rolloutRaw = String(args.rollout_percentage ?? "").trim().replace(/%$/, "").trim() || "0";
    const rollout = Number(rolloutRaw);
    if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100) {
      return errorResult(BASE_CSS, "CREATE FLAG", `Rollout percentage must be a number from 0 to 100 (got "${args.rollout_percentage}").`);
    }
    const activeRaw = typeof args.active === "string" ? args.active.trim().toLowerCase() : args.active;
    if (![undefined, "", true, false, "true", "false"].includes(activeRaw)) {
      return errorResult(BASE_CSS, "CREATE FLAG", `Active must be on or off (got "${args.active}").`);
    }
    const active = activeRaw === true || activeRaw === "true";
    const name = String(args.name ?? "").trim();

    const { ctx, fail } = await toolContext("CREATE FLAG", args.project_id);
    if (fail) return fail;

    const res = await runInProject(ctx, "POSTHOG_CREATE_FEATURE_FLAG", {
      key,
      ...(name ? { name } : {}),
      active,
      filters: { groups: [{ properties: [], rollout_percentage: rollout }] },
    });
    if (!res.ok) return errorResult(BASE_CSS, "CREATE FLAG", res.error || `Feature flag "${key}" was not created.`);
    if (!res.data?.id) return errorResult(BASE_CSS, "CREATE FLAG", "PostHog did not confirm the new flag (no ID returned).");

    // Report what PostHog actually stored, not what was requested.
    const f = res.data;
    const storedRollout = f.filters?.groups?.[0]?.rollout_percentage ?? 100;
    return glanceResult(
      {
        created: true,
        project_id: ctx.projectId,
        flag: { id: f.id, key: f.key, name: f.name || "", active: Boolean(f.active), rollout_percentage: storedRollout },
      },
      [
        vHeader({ title: "Feature flag created", trailing: f.active ? "ON" : "OFF" }),
        vKeyValue([
          { label: "Key", value: String(f.key) },
          { label: "Status", value: f.active ? "On" : "Off", tone: f.active ? "good" : "neutral" },
          { label: "Rollout", value: `${storedRollout}% of users` },
          { label: "ID", value: String(f.id) },
        ]),
      ]
    );
  }
);

// ============================================================================
// Tool 14: capture_event (write — confirmation card in manifest)
// ============================================================================
// Project api_token (public ingestion key) per project ID; memory only, never logged or returned.
const projectTokens = new Map<string, string>();

async function projectApiToken(ctx: ToolCtx): Promise<{ token?: string; error?: string }> {
  const cached = projectTokens.get(ctx.projectId);
  if (cached) return { token: cached };
  const res = await executeComposioAction("POSTHOG_LIST_ALL_PROJECTS_ACROSS_ORGANIZATIONS", {}, ctx.composioKey, ctx.posthogKey, ctx.region);
  if (!res.ok) return { error: res.error || "Failed to look up the project's API token." };
  const project = extractArray(res.data).find((p: any) => String(p.id) === ctx.projectId);
  if (!project?.api_token) return { error: `Project ${ctx.projectId} was not found in your PostHog account.` };
  projectTokens.set(ctx.projectId, String(project.api_token));
  return { token: String(project.api_token) };
}

registerWriteTool(
  "capture_event",
  {
    title: "Capture event",
    description:
      "Send one custom analytics event to PostHog, optionally with properties. Use when the user asks to log, track, send, or record an event in PostHog.",
    inputSchema: {
      event: z.string().describe("Event name, e.g. 'demo_booked'."),
      distinct_id: z.string().describe("ID of the user the event belongs to. Use 'voiceos' if the user doesn't name one."),
      properties: z.string().optional().describe("Optional event properties as a JSON object string, e.g. '{\"plan\": \"pro\"}'."),
      project_id: z.string().optional().describe("Optional PostHog project ID. Uses default project if omitted."),
    } as any,
  },
  async (args: any) => {
    const event = String(args.event ?? "").trim();
    if (!event) return errorResult(BASE_CSS, "CAPTURE EVENT", "Give an event name to capture.");
    // No hidden default: what was shown on the confirmation card is exactly what is sent.
    const distinctId = String(args.distinct_id ?? "").trim();
    if (!distinctId) return errorResult(BASE_CSS, "CAPTURE EVENT", "Give a distinct ID for the event (who it belongs to).");

    let properties: Record<string, any> | undefined;
    const propsRaw = String(args.properties ?? "").trim();
    if (propsRaw) {
      try {
        const parsed = JSON.parse(propsRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        properties = parsed;
      } catch {
        return errorResult(BASE_CSS, "CAPTURE EVENT", `Properties must be a JSON object, e.g. {"plan": "pro"} (got ${clip(propsRaw, 80)}).`);
      }
    }

    const { ctx, fail } = await toolContext("CAPTURE EVENT", args.project_id);
    if (fail) return fail;
    const { token, error } = await projectApiToken(ctx);
    if (!token) return errorResult(BASE_CSS, "CAPTURE EVENT", error || "Could not find the project's API token.");

    const res = await executeComposioAction(
      "POSTHOG_CAPTURE_EVENT",
      {
        api_key: token,
        event,
        distinct_id: distinctId,
        ingest_host: ctx.region === "eu" ? "https://eu.i.posthog.com" : "https://us.i.posthog.com",
        ...(properties ? { properties } : {}),
      },
      ctx.composioKey,
      ctx.posthogKey,
      ctx.region
    );
    if (!res.ok) return errorResult(BASE_CSS, "CAPTURE EVENT", res.error || `Event "${event}" was not captured.`);
    if (res.data?.success !== true) {
      return errorResult(BASE_CSS, "CAPTURE EVENT", redactSecrets(`PostHog did not accept the event (status ${res.data?.status ?? "unknown"}): ${res.data?.message ?? "no message"}`));
    }

    return glanceResult(
      { captured: true, project_id: ctx.projectId, event, distinct_id: distinctId, properties: properties ?? {}, note: "PostHog ingests events asynchronously; it can take a minute to appear." },
      [
        vHeader({ title: "Event captured", trailing: "Sent" }),
        vKeyValue([
          { label: "Event", value: event },
          { label: "Distinct ID", value: distinctId },
          { label: "Properties", value: properties ? String(Object.keys(properties).length) : "None" },
        ]),
      ]
    );
  }
);

await server.connect(new StdioServerTransport());
