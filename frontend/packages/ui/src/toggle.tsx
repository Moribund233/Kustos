"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";
import * as TogglePrimitive from "@radix-ui/react-toggle";

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,box-shadow] outline-none hover:bg-ink-800 hover:text-muted focus-visible:border-amber focus-visible:ring-[3px] focus-visible:ring-amber/30 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-rose aria-invalid:ring-rose/25 data-[state=on]:bg-ink-750 data-[state=on]:text-bone-2 dark:aria-invalid:ring-rose/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-edge-2 bg-transparent shadow-xs hover:bg-ink-750 hover:text-bone-2",
      },
      size: {
        default: "h-9 min-w-9 px-2",
        sm: "h-8 min-w-8 px-1.5",
        lg: "h-10 min-w-10 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
