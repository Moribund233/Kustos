import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-amber text-ink-1000 hover:bg-amber-2",
        secondary: "border border-edge-2 bg-ink-800 text-bone-2 hover:bg-ink-750",
        outline: "border border-edge-2 bg-transparent text-bone-2 hover:bg-ink-800",
        ghost: "text-muted hover:bg-ink-800 hover:text-bone-2",
        danger: "bg-rose text-ink-1000 hover:bg-rose-2",
        link: "text-sky underline-offset-4 hover:underline",
      },
      size: {
        /* xs 补的是密集工具栏的档位。原先最小档 sm 也有 32px，而文件树、
           消息操作行、diff 行这类位置只能容下 24px，所以那些地方一直
           写裸 <button>——不是不用组件，是组件没有合适的档位。

           24px 是 WCAG 2.2 SC 2.5.8（目标尺寸最小）的下限，再小就不合规，
           因此不提供 20px 档。图标同步降到 14px，否则 16px 图标在 24px
           的方框里会顶满。 */
        xs: "h-6 gap-1.5 px-2 text-xs [&_svg]:size-3.5",
        default: "h-9 px-4",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
        "icon-xs": "size-6 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
