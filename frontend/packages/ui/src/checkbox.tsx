"use client";

import * as React from "react";
import { cn } from "./utils";
import { CheckIcon } from "lucide-react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer border-edge-2 focus-visible:border-amber focus-visible:ring-amber/30 aria-invalid:border-rose aria-invalid:ring-rose/25 data-[state=checked]:border-amber data-[state=checked]:bg-amber data-[state=checked]:text-ink-1000 dark:bg-ink-800 dark:aria-invalid:ring-rose/40 dark:data-[state=checked]:bg-amber size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
