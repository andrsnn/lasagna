"use client";

import { ArrowDownUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type SortOption<T extends string> = {
  value: T;
  label: string;
};

export function SortMenu<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<SortOption<T>>;
  onChange: (next: T) => void;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" className="gap-1.5">
            <ArrowDownUp className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Sort: </span>
            {current?.label}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => onChange(v as T)}
        >
          {options.map((opt) => (
            <DropdownMenuRadioItem key={opt.value} value={opt.value}>
              {opt.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
