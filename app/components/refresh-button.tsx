"use client";

import { useEffect, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RefreshButton({
  lastRunAt,
  minIntervalSeconds = 30,
  onRefresh,
  className,
}: {
  lastRunAt?: number;
  minIntervalSeconds?: number;
  onRefresh: () => void;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, []);

  const elapsed = lastRunAt ? (now - lastRunAt) / 1000 : Infinity;
  const remaining = Math.max(0, minIntervalSeconds - elapsed);
  const disabled = remaining > 0;
  const pct = Math.min(1, elapsed / minIntervalSeconds);

  return (
    <Button
      onClick={onRefresh}
      disabled={disabled}
      className={cn("relative overflow-hidden gap-1.5", className)}
    >
      <RefreshCcw className={cn("h-3.5 w-3.5", disabled && "opacity-60")} />
      <span className="hidden sm:inline">
        {disabled ? `Wait ${Math.ceil(remaining)}s` : "Refresh"}
      </span>
      {disabled && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[2px] bg-foreground/40"
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      )}
    </Button>
  );
}
