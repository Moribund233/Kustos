/**
 * 设置面：本机系统集成。
 *
 * 只放"这台机器上、与某个实例无关"的偏好。为什么单独成面而不是塞进某个工作
 * 分区：协议注册与开机自启在用户换实例、换仓库时都不该变，混在业务界面里
 * 会让人以为它们跟着仓库走。
 */
import { useTranslation } from "react-i18next";

import { Icon } from "@/shell/icon";

import {
  useIntegrationStatus,
  useRegisterProtocol,
  useSetAutostart,
  useUnregisterProtocol,
} from "@/lib/integration";

export function SettingsDetail() {
  const { t } = useTranslation();
  const status = useIntegrationStatus();
  const setAutostart = useSetAutostart();
  const registerProtocol = useRegisterProtocol();
  const unregisterProtocol = useUnregisterProtocol();

  const busy = setAutostart.isPending || registerProtocol.isPending || unregisterProtocol.isPending;
  const exePath = status.data?.exePath ?? "";

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="shrink-0 border-b border-[var(--color-edge-1)] px-5 py-3">
        <h1 className="text-[13px] font-medium text-[var(--color-bone)]">{t("settings.title")}</h1>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-muted)]">
          {t("settings.hint")}
        </p>
      </div>

      <div className="space-y-3 px-5 py-4">
        {/* 深链：没有注册时，浏览器里点 kustos:// 链接什么都不会发生。 */}
        <section className="rounded-[8px] border border-[var(--color-edge-2)] bg-[var(--color-ink-900)] p-3">
          <div className="flex items-start gap-2">
            <Icon name="external" size={13} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-[var(--color-bone)]">{t("settings.deeplinkTitle")}</p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-[var(--color-muted)]">
                {t("settings.deeplinkHint")}
              </p>
              <p className="mt-1 font-mono text-[10px] break-all text-[var(--color-faint)]">
                {exePath || "—"}
              </p>
            </div>
            <span
              className={[
                "shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px]",
                status.data?.protocolRegistered
                  ? "bg-[rgba(134,183,158,0.14)] text-[var(--color-sage)]"
                  : "bg-[var(--color-ink-800)] text-[var(--color-faint)]",
              ].join(" ")}
            >
              {status.data?.protocolRegistered
                ? t("settings.registered")
                : t("settings.notRegistered")}
            </span>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy || status.data?.protocolRegistered === true}
              onClick={() => registerProtocol.mutate()}
              className="h-[26px] rounded-[7px] border border-[var(--color-amber)] px-2.5 text-[11px] text-[var(--color-amber)] hover:bg-[rgba(242,174,91,0.12)] disabled:opacity-40"
            >
              {t("settings.register")}
            </button>
            <button
              type="button"
              disabled={busy || status.data?.protocolRegistered !== true}
              onClick={() => unregisterProtocol.mutate()}
              className="h-[26px] rounded-[7px] border border-[var(--color-edge-2)] px-2.5 text-[11px] text-[var(--color-muted-2)] hover:text-[var(--color-bone-2)] disabled:opacity-40"
            >
              {t("settings.unregister")}
            </button>
          </div>
        </section>

        {/* 开机自启：托盘常驻的应用没这个开关，每次重启都要手动找一次图标。 */}
        <section className="rounded-[8px] border border-[var(--color-edge-2)] bg-[var(--color-ink-900)] p-3">
          <div className="flex items-start gap-2">
            <Icon name="zap" size={13} className="mt-px shrink-0 text-[var(--color-muted-2)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-[var(--color-bone)]">{t("settings.autostartTitle")}</p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-[var(--color-muted)]">
                {t("settings.autostartHint")}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => setAutostart.mutate(status.data?.autostart !== true)}
              className={[
                "h-[26px] shrink-0 rounded-[7px] border px-2.5 text-[11px] disabled:opacity-40",
                status.data?.autostart
                  ? "border-[var(--color-sage)] text-[var(--color-sage)] hover:bg-[rgba(134,183,158,0.12)]"
                  : "border-[var(--color-edge-2)] text-[var(--color-bone-2)] hover:text-[var(--color-bone)]",
              ].join(" ")}
            >
              {status.data?.autostart ? t("settings.autostartOn") : t("settings.autostartOff")}
            </button>
          </div>
        </section>

        {/* 写注册表失败时说清原因：静默不写而界面翻开关，就是骗人。 */}
        {(setAutostart.error ?? registerProtocol.error ?? unregisterProtocol.error) != null && (
          <p className="text-[10.5px] leading-relaxed text-[var(--color-rose)]">
            {String(
              (setAutostart.error ?? registerProtocol.error ?? unregisterProtocol.error) instanceof Error
                ? ((setAutostart.error ?? registerProtocol.error ?? unregisterProtocol.error) as Error).message
                : (setAutostart.error ?? registerProtocol.error ?? unregisterProtocol.error),
            ).replace(/^(RuntimeError|Error):\s*/i, "")}
          </p>
        )}

        {status.data?.error != null && status.data.error !== "" && (
          <p className="text-[10.5px] leading-relaxed text-[var(--color-amber)]">{status.data.error}</p>
        )}

        <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)]">
          {t("settings.writeScope")}
        </p>
      </div>
    </div>
  );
}
