# PostHog for VoiceOS: handoff

Version 1.1.1 of a VoiceOS integration that lets the voice agent read PostHog analytics, create feature flags, and capture events. All PostHog access goes through Composio's REST API v3.1, using the user's own PostHog personal API key.

Install link: https://api.voiceos.com/integration-share/ULwa_N-k5wRV/page

## Tools

There are 14 tools: 12 read tools and 2 write tools. `POSTHOG_LIST_ALL_PROJECTS_ACROSS_ORGANIZATIONS` is a setup helper for project detection and the capture token. It isn't exposed as a tool.

| Tool | Type | Composio slugs |
|---|---|---|
| `list_feature_flags` | Read | `POSTHOG_LIST_AND_MANAGE_PROJECT_FEATURE_FLAGS` |
| `get_feature_flag` | Read | `POSTHOG_GET_FEATURE_FLAG_DETAILS`; key lookup uses the list slug above |
| `get_insights` | Read | `POSTHOG_RETRIEVE_PROJECT_INSIGHTS_WITH_PAGINATION`, `POSTHOG_RETRIEVE_PROJECT_INSIGHT_DETAILS` |
| `get_dashboard` | Read | `POSTHOG_LIST_PROJECT_DASHBOARDS`, `POSTHOG_RETRIEVE_SPECIFIC_PROJECT_DASHBOARD_DETAILS` |
| `get_event_definitions` | Read | `POSTHOG_GET_EVENT_DEFINITIONS` |
| `get_funnel` | Read | `POSTHOG_CREATE_QUERY_IN_PROJECT_BY_ID` (FunnelsQuery) |
| `get_retention` | Read | `POSTHOG_CREATE_PROJECT_RETENTION_INSIGHT` |
| `run_query` | Read | `POSTHOG_CREATE_QUERY_IN_PROJECT_BY_ID` (HogQLQuery) |
| `get_persons` | Read | `POSTHOG_LIST_OR_DELETE_PERSONS_WITH_OPTIONAL_FILTERS`, `POSTHOG_RETRIEVE_PERSON_DETAILS_BY_ID` |
| `get_cohorts` | Read | `POSTHOG_RETRIEVE_PROJECT_COHORTS_WITH_PAGINATION`, `POSTHOG_RETRIEVE_PROJECT_COHORT_DETAILS` |
| `get_actions` | Read | `POSTHOG_LIST_PROJECT_ACTIONS`, `POSTHOG_RETRIEVE_PROJECT_ACTION_DETAILS_BY_ID` |
| `get_session_recordings` | Read | `POSTHOG_LIST_PROJECT_SESSION_RECORDINGS`, `POSTHOG_RETRIEVE_SESSION_RECORDING_DETAILS` |
| `create_feature_flag` | Write, confirmation required | `POSTHOG_CREATE_FEATURE_FLAG` |
| `capture_event` | Write, confirmation required | `POSTHOG_CAPTURE_EVENT` |

## Setup

1. Create a Composio API key and a PostHog personal API key.
2. Open the install link in VoiceOS and install the app.
3. Enter both keys in the app's setup fields and choose the PostHog region (US or EU).
4. Set a project ID only if the account has more than one project. With a single project, it's detected automatically.

The app creates its Composio auth config and connected account on first use. To run the server locally, run `bun install`, then set the variables in `.env.example` in your environment and run `bun server.ts`.

## Audit changes

- **Create annotation dropped.** Composio requires response-only fields as inputs, and PostHog then rejects the placeholder `dashboard_id`. A real dashboard ID would attach the annotation to that dashboard instead of the project, so the planned 15 tools became 14.
- **Funnels use the query slug.** `POSTHOG_GET_FUNNEL_INSIGHTS_IN_PROJECT` calls an endpoint that rejects personal API keys, so `get_funnel` sends a `FunnelsQuery` through `POSTHOG_CREATE_QUERY_IN_PROJECT_BY_ID`.
- **Persons are read-only.** `get_persons` sends only fixed list and detail arguments, so tool input can't trigger a delete.
- **Queries are capped at 50 rows.** `run_query` accepts a single SELECT statement and enforces the cap whatever LIMIT the query uses.
- **Write safety.** New flags default to off at 0% rollout. Write tools register only when the manifest declares their confirmation cards.

## Test results

All 36 real checks passed on v1.1.1, run over MCP against a live PostHog project with no mocks. They covered list, detail, empty, and bad-input cases across all 14 tools, and both writes were confirmed in PostHog.

Detail lookups for `get_actions` and `get_session_recordings` were tested with unknown IDs only, because the test project had no actions or recordings.

## How to test

`bun test` runs the offline suite in `tests/server.test.ts`. It starts the real server against a fake Composio, so it needs no keys or network.

```bash
bun install
bun test
```

`tests/e2e.ts` starts the server through `run.sh`, as VoiceOS does, and calls all 14 tools over MCP against a real PostHog project. Keys are read from environment variables only.

```bash
COMPOSIO_API_KEY=... POSTHOG_API_KEY=... bun tests/e2e.ts
```

The default run is read-only and covers the 12 read tools. To also test the 2 write tools, add `RUN_WRITE_TESTS=1`. This creates one feature flag (off, 0%) and one event, both named `voiceos-e2e-<timestamp>`, and the flag stays in PostHog until you delete it. These calls go directly over MCP, so they skip VoiceOS's confirmation cards.

Optional variables are `POSTHOG_REGION` (default `us`) and `POSTHOG_PROJECT_ID`, which is required if the account has more than one project. The test exits with a non-zero status if any check fails.

## Known limitations

- Some VoiceOS builds don't re-read a changed manifest after install. See `AGENTS.md` for how to load one.
- Annotations aren't supported.
