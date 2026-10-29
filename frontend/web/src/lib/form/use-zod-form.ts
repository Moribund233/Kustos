/**
 * 表单校验基座。
 *
 * Issue / PR / 评论 / 登录 / 管理台配置共用同一套「react-hook-form + zod」组合：
 * zod schema 同时作为类型来源与运行时校验器，避免 DTO 与表单各写一份。
 */
import { zodResolver } from "@hookform/resolvers/zod";
import {
  useForm,
  type DefaultValues,
  type UseFormProps,
  type UseFormReturn,
} from "react-hook-form";
import { type z, type AnyZodObject } from "zod";

/**
 * 创建带 zod 校验的表单。
 *
 * schema 约束为对象类型，保证输入是表单可承载的 `FieldValues`。
 * 表单值类型取 schema 的输入类型——zod 的输入与输出可以不同
 * （如 `z.string().transform()`），而 react-hook-form 持有的是转换前的值。
 *
 * @param schema zod 对象 schema
 * @param defaults 默认值
 * @param options 其余 react-hook-form 配置
 * @returns 表表单实例
 */
export function useZodForm<TSchema extends AnyZodObject>(
  schema: TSchema,
  defaults?: DefaultValues<z.input<TSchema>>,
  options?: Partial<UseFormProps<z.input<TSchema>>>,
): UseFormReturn<z.input<TSchema>> {
  const resolver = zodResolver(schema);

  return useForm<z.input<TSchema>, unknown, z.input<TSchema>>({
    resolver,
    defaultValues: defaults,
    ...options,
  });
}
