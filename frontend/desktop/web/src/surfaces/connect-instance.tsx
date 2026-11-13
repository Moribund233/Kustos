import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "@kustos/ui";

import { useAddInstance, type InstanceInfo } from "@/lib/session";
import { instanceTooOld } from "@/lib/onboarding";

/**
 * 添加实例的表单。
 *
 * 这里是**表单**，不是页面：它出现在引导流程的第一步里，也可能出现在
 * "切换实例"展开后的位置。居中和标题由外层容器负责——表单自己带 padding
 * 与居中时，嵌进卡片就会多出一圈留白。
 *
 * 添加前先探活：让用户在**这一步**就知道地址对不对、版本是否可用，
 * 而不是等到登录时才失败（那时用户会怀疑是密码问题）。
 */
export function ConnectForm({
  onPicked,
}: {
  onPicked: (id: string, info: InstanceInfo) => void;
}) {
  const { t } = useTranslation();
  const [baseURL, setBaseURL] = useState("");
  const [probe, setProbe] = useState<InstanceInfo | null>(null);
  const addInstance = useAddInstance();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = baseURL.trim();
    if (!url) return;

    addInstance.mutate(url, {
      onSuccess: ([instance, info]) => {
        setProbe(info);
        // 版本过旧是**阻断式**的：不尝试"降级兼容"，半兼容状态比明确失败更难查。
        // 连不上同理——此时放行只会把失败推到登录那一步。
        if (info.reachable && !instanceTooOld(info) && instance.id) {
          onPicked(instance.id, info);
        }
      },
    });
  };

  return (
    <form onSubmit={submit}>
      <label htmlFor="instance-url" className="mb-1 block text-[11px] text-faint">
        {t("session.instanceUrl")}
      </label>
      <div className="mb-3 flex gap-2">
        <Input
          id="instance-url"
          value={baseURL}
          onChange={(e) => {
            setBaseURL(e.target.value);
            setProbe(null);
          }}
          placeholder="https://kustos.example.com"
          autoFocus
          spellCheck={false}
        />
        <Button type="submit" disabled={addInstance.isPending || !baseURL.trim()}>
          {addInstance.isPending ? t("session.connecting") : t("session.connect")}
        </Button>
      </div>

      {/* 探活结果就地展示，不用 toast 掩盖持续故障 */}
      {probe && <ProbeNote info={probe} />}

      {addInstance.isError && (
        <p className="mt-3 text-[12px] text-[var(--color-rose)]">
          {t("session.addFailed", { error: String(addInstance.error) })}
        </p>
      )}
    </form>
  );
}

/** 探活结果。不可达时给出原因，而不是"出错了"。 */
export function ProbeNote({ info }: { info: InstanceInfo }) {
  const { t } = useTranslation();
  if (!info.reachable) {
    return (
      <div className="rounded-md border border-[color-mix(in_srgb,var(--color-rose)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-rose)_8%,transparent)] px-3 py-2">
        <p className="text-[12px] text-[var(--color-rose-2)]">{t("session.unreachable")}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
          {info.error || t("session.unreachableHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-edge-2)] px-3 py-2">
      <p className="text-[12px] text-bone">
        {info.title || t("session.connected")}
        <span className="ml-2 text-[11px] text-faint">v{info.version}</span>
      </p>
      {info.apiCompat ? (
        <p className="mt-0.5 text-[11px] text-muted">
          {t("session.contract", { version: info.apiCompat.apiVersion, min: info.apiCompat.apiMin })}
        </p>
      ) : (
        // 老实例没有 client-compat：如实说明，不假装知道兼容性。
        <p className="mt-0.5 text-[11px] text-muted">{t("session.noContract")}</p>
      )}
      {instanceTooOld(info) && (
        <p className="mt-1 text-[11px] text-[var(--color-rose)]">{t("session.tooOld")}</p>
      )}
    </div>
  );
}
