import * as React from "react";

import { cn } from "./utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "border-edge-2 bg-ink-900 text-bone-2 flex h-9 w-full rounded-md border px-3 text-sm transition-colors",
        "placeholder:text-faint focus-visible:border-amber/50 focus-visible:ring-amber/40 focus-visible:ring-1 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
