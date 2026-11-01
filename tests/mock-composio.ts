// Preloaded into the server for offline tests: replaces fetch with a fake Composio and logs each call to stderr.
const rows = (count: number, row: (i: number) => any) => Array.from({ length: count }, (_, i) => row(i));
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const success = (data: unknown) => respond({ successful: true, data });

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const path = String(url).replace(/^.*\/api\/v3\.1/, "");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  console.error(`MOCKCALL ${JSON.stringify({ path, arguments: body?.arguments })}`);

  if (path.startsWith("/connected_accounts?")) return respond({ items: [{ id: "ca_test" }] });

  const args = body?.arguments ?? {};
  switch (path.split("/").pop()) {
    case "POSTHOG_LIST_ALL_PROJECTS_ACROSS_ORGANIZATIONS":
      return success({ projects: [{ id: 1, name: "Test", api_token: "phc_faketoken12345", secret_api_token: "phs_fakesecret12345" }] });
    case "POSTHOG_LIST_AND_MANAGE_PROJECT_FEATURE_FLAGS":
      return success({ count: 8, results: rows(Math.min(8, args.limit ?? 8), (i) => ({ id: i, key: `flag-${i}`, active: false, filters: { groups: [] } })) });
    case "POSTHOG_RETRIEVE_PROJECT_INSIGHTS_WITH_PAGINATION":
      return success({ count: 8, results: rows(Math.min(8, args.limit ?? 8), (i) => ({ id: i, short_id: `s${i}`, name: `Insight ${i}` })) });
    case "POSTHOG_LIST_PROJECT_DASHBOARDS":
      return success({ count: 7, results: rows(7, (i) => ({ id: i, name: `Dashboard ${i}` })) });
    case "POSTHOG_GET_EVENT_DEFINITIONS":
      return success({ count: 40, results: rows(40, (i) => ({ name: `event_${i}`, volume_30_day: i })) });
    case "POSTHOG_LIST_PROJECT_ACTIONS":
      return success({ count: 0, results: [] });
    case "POSTHOG_LIST_OR_DELETE_PERSONS_WITH_OPTIONAL_FILTERS":
      return success({ next: null, results: [] });
    case "POSTHOG_CREATE_QUERY_IN_PROJECT_BY_ID":
      return success({ columns: ["number"], results: rows(51, (i) => [i]) });
    case "POSTHOG_CAPTURE_EVENT":
      return success({ success: true, status: 200, message: "Ok" });
    case "POSTHOG_CREATE_FEATURE_FLAG":
      if (args.key === "composio-rejects") {
        return respond({ error: { message: "Validation error", errors: ["field is invalid"], suggested_fix: "Check the payload", request_id: "req_1" } }, 400);
      }
      if (args.key === "posthog-rejects") {
        return respond({ successful: false, error: '{"detail":"Flag key already exists."}', data: { status_code: 400 } });
      }
      return success({ id: 7, key: args.key, name: args.name, active: args.active, filters: args.filters });
    default:
      throw new Error(`Unexpected request: ${path}`);
  }
}) as typeof fetch;
