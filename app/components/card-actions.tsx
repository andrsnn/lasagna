"use client";

import * as React from "react";
import Link from "next/link";
import { MoreHorizontal, type LucideIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type CardActionItem = {
  key: string;
  label: string;
  icon: LucideIcon | React.ReactNode;
  ariaLabel?: string;
  onSelect?: () => void | Promise<void>;
  href?: string;
  hidden?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  pressed?: boolean;
  active?: boolean;
};

export type CardActionsProps = {
  actions: CardActionItem[];
  primaryCount?: number;
  primaryKeys?: string[];
  variant?: "default" | "chip";
  tooltipSide?: "top" | "bottom";
  menuAlign?: "start" | "end";
  className?: string;
};

function renderIcon(icon: CardActionItem["icon"], sizeClass: string) {
  if (React.isValidElement(icon)) return icon;
  // Function components are detected by typeof === "function"; forwardRef /
  // memo components are objects carrying a `$$typeof` tag (lucide-react
  // v1+ wraps every icon in forwardRef, so the function check alone misses
  // them and React error #31 fires when the raw object is returned as a child).
  if (
    typeof icon === "function" ||
    (typeof icon === "object" && icon !== null && "$$typeof" in icon)
  ) {
    const Icon = icon as LucideIcon;
    return <Icon className={sizeClass} />;
  }
  return icon as React.ReactNode;
}

function inlineButtonClasses(
  variant: "default" | "chip",
  destructive: boolean,
  active: boolean,
) {
  if (variant === "chip") {
    return cn(
      "tap flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition disabled:opacity-50 data-popup-open:text-foreground sm:h-6 sm:w-6",
      destructive
        ? "hover:text-destructive"
        : active
          ? "text-primary hover:text-primary"
          : "hover:text-foreground",
    );
  }
  return cn(
    "tap rounded-md p-2 transition disabled:opacity-50 data-popup-open:bg-primary/10 data-popup-open:text-primary sm:p-1.5",
    destructive
      ? "text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
      : active
        ? "text-primary hover:bg-primary/10"
        : "text-muted-foreground/70 hover:bg-primary/10 hover:text-primary",
  );
}

function InlineAction({
  action,
  variant,
  tooltipSide,
}: {
  action: CardActionItem;
  variant: "default" | "chip";
  tooltipSide: "top" | "bottom";
}) {
  const sizeClass = variant === "chip" ? "h-3 w-3" : "h-4 w-4";
  const className = inlineButtonClasses(
    variant,
    !!action.destructive,
    !!action.active,
  );
  const ariaLabel = action.ariaLabel ?? action.label;

  const triggerProps = {
    "aria-label": ariaLabel,
    "aria-pressed": action.pressed,
    disabled: action.disabled,
    className,
  } as const;

  const content = renderIcon(action.icon, sizeClass);

  const trigger = action.href ? (
    <TooltipTrigger
      render={
        <Link href={action.href} aria-label={ariaLabel} className={className}>
          {content}
        </Link>
      }
    />
  ) : (
    <TooltipTrigger
      type="button"
      onClick={() => void action.onSelect?.()}
      {...triggerProps}
    >
      {content}
    </TooltipTrigger>
  );

  return (
    <Tooltip>
      {trigger}
      <TooltipContent side={tooltipSide}>{action.label}</TooltipContent>
    </Tooltip>
  );
}

export function CardActions({
  actions,
  primaryCount = 3,
  primaryKeys,
  variant = "default",
  tooltipSide = "top",
  menuAlign = "end",
  className,
}: CardActionsProps) {
  const visible = actions.filter((a) => !a.hidden);

  let primary: CardActionItem[];
  let overflow: CardActionItem[];
  if (primaryKeys && primaryKeys.length) {
    const set = new Set(primaryKeys);
    const pinned = primaryKeys
      .map((k) => visible.find((a) => a.key === k))
      .filter((a): a is CardActionItem => !!a);
    primary = pinned;
    overflow = visible.filter((a) => !set.has(a.key));
  } else {
    primary = visible.slice(0, primaryCount);
    overflow = visible.slice(primaryCount);
  }

  // If conditional `hidden` removed every primary, promote leading overflow
  // items so the user still sees inline buttons (avoids a lone caret trigger
  // hiding the only remaining action behind a click).
  if (primary.length === 0 && overflow.length > 0) {
    const promoteCount = Math.min(primaryCount, overflow.length);
    primary = overflow.slice(0, promoteCount);
    overflow = overflow.slice(promoteCount);
  }

  const caretClass = inlineButtonClasses(variant, false, false);

  return (
    <div className={cn("flex items-center", variant === "chip" ? "gap-1" : "gap-1", className)}>
      {primary.map((action) => (
        <InlineAction
          key={action.key}
          action={action}
          variant={variant}
          tooltipSide={tooltipSide}
        />
      ))}
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More actions"
            className={caretClass}
          >
            <MoreHorizontal className={variant === "chip" ? "h-3 w-3" : "h-4 w-4"} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align={menuAlign} className="min-w-[12rem]">
            {overflow.map((action) => {
              const ariaLabel = action.ariaLabel ?? action.label;
              const itemIcon = renderIcon(action.icon, "h-4 w-4");
              if (action.href) {
                return (
                  <DropdownMenuItem
                    key={action.key}
                    disabled={action.disabled}
                    variant={action.destructive ? "destructive" : "default"}
                    render={
                      <Link href={action.href} aria-label={ariaLabel}>
                        {itemIcon}
                        <span>{action.label}</span>
                      </Link>
                    }
                  />
                );
              }
              return (
                <DropdownMenuItem
                  key={action.key}
                  disabled={action.disabled}
                  variant={action.destructive ? "destructive" : "default"}
                  aria-label={ariaLabel}
                  onClick={() => void action.onSelect?.()}
                >
                  {itemIcon}
                  <span>{action.label}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
