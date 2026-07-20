"use client";

// Singleton client-mount that boots the account-sync background loop:
//   - Registers the db.ts save hook so account-shared rows push on every put.
//   - Pulls the latest account state immediately, then every 60s while the
//     tab is visible.
//
// Mounted once at the root layout so every page benefits, including share
// recipients (the proxy bypass means /share/* gets the component but the
// pull will 401 silently — non-fatal).

import { useEffect } from "react";
import { startAccountSync } from "@/app/lib/account-sync";

export function AccountSyncMount() {
  useEffect(() => {
    const stop = startAccountSync();
    return stop;
  }, []);
  return null;
}
