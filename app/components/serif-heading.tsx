import * as React from "react";
import { cn } from "@/lib/utils";

const serif = "font-[family-name:var(--font-display)] font-normal text-foreground";

export function H1({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={cn(serif, "text-3xl tracking-tight", className)}
      {...props}
    />
  );
}

export function H2({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn(serif, "text-xl tracking-tight", className)}
      {...props}
    />
  );
}
