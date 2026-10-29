import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "@radix-ui/react-slot";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-amber focus-visible:ring-[3px] focus-visible:ring-amber/30 aria-invalid:border-rose aria-invalid:ring-rose/25 dark:aria-invalid:ring-rose/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-amber text-ink-1000 [a&]:hover:bg-amber-2",
        secondary: "bg-ink-800 text-bone-2 [a&]:hover:bg-ink-800/90",
        destructive:
          "bg-rose text-ink-1000 focus-visible:ring-rose/25 dark:bg-rose/70 dark:focus-visible:ring-rose/40 [a&]:hover:bg-rose/90",
        outline: "border-edge-2 text-bone [a&]:hover:bg-ink-750 [a&]:hover:text-bone-2",
        ghost: "[a&]:hover:bg-ink-750 [a&]:hover:text-bone-2",
        link: "text-amber underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
