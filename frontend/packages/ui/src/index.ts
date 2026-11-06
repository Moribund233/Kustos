/**
 * Kustos 基础展示组件入口。
 *
 * 只含**无布局假设**的件（button/dialog/input/skeleton…）。页面组合、
 * 导航壳、悬浮 Dock 这类与布局强相关的东西不进来——那是两端取舍不同的地方
 * （设计文档 §3.2/§6.8）。
 *
 * 组件只依赖 `./utils` 的 `cn`，不引用任何应用内路径，因此可被 Web 与
 * 桌面端同时消费。
 */
export { cn } from "./utils";
export * from "./alert-dialog";
export * from "./button";
export * from "./checkbox";
export * from "./dialog";
export * from "./dropdown-menu";
export * from "./input";
export * from "./label";
export * from "./popover";
export * from "./select";
export * from "./separator";
export * from "./skeleton";
export * from "./switch";
export * from "./tabs";
export * from "./toggle";
export * from "./tooltip";
