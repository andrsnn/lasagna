// The one-time "upgrade to declared data" migration instruction.
//
// Fired into the app's designer chat (prefill + autosend) from the app's
// Settings -> Data -> Advanced row. The model performs the migration with the
// Build gates verifying the result: strict manifest.state validation catches a
// bad declaration, and esbuild catches broken wiring, both inside the model's
// own fix loop. The affordance is self-retiring - it only renders while the
// manifest has no "state" block, so a successful migration removes the button.

export const DECLARED_DATA_UPGRADE_PROMPT = `Upgrade this app to DECLARED DATA (the manifest "state" block). This is a one-time migration: keep every feature and all styling exactly as they are - only change how data is fetched, stored, and read.

1. Read manifest.json, App.tsx, Widget.tsx, and any data hooks/components. Find every dataset the app fetches and persists: artifact.query / artifact.task / useArtifactTask calls, onQueryResult and onScheduleUpdate handlers, the schedule (manifest "schedule" block or defineSchedule call), and the artifact.state keys those flows write.

2. Declare each dataset in manifest.json under "state" as a collection entry: a "schema" describing ONE record (carry over the fields the UI actually renders, adding "format"/"enum"/"minLength" where the intent is clear), "identity" keys that uniquely identify a record, "merge": "upsert", "retain": { "dateKey": ... } if records expire by date, and a "source" carrying the existing query prompt and webSearch flag. If the app had a schedule, set source.refresh.schedule to its cron and DELETE the old top-level "schedule" block and any defineSchedule call. If the prompt embeds a user-configurable value (city, topic, ticker), reference it as {params.key} against an existing or new param instead of hardcoding.

3. CRITICAL - reuse the app's EXISTING artifact.state key as the entry key (if the events live in state key "data", declare "data"; do not invent a new key). The user's already-saved records must appear immediately after the upgrade. Never clear or rename stored state.

4. Replace the hand-wired plumbing for those datasets in App.tsx AND Widget.tsx with useArtifact("<key>") from "@artifact/ui" (or artifact.entries.watch in non-React code). Delete the now-redundant onScheduleUpdate / onQueryResult / onRefresh re-fetch handlers and the state.set copying for those datasets. "Last refreshed" style labels should render the hook's lastRefreshedAt. Keep purely-local UI state as React state, or declare it as a "kind": "value" entry if it should sync across the widget and app.

5. Do not add features, do not restyle, do not touch unrelated code. Run Build and fix every reported error before finishing.`;
