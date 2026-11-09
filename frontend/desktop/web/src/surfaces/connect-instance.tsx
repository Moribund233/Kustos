import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "@kustos/ui";

import { useAddInstance, type InstanceInfo } from "@/lib/session";

/**
 * 首次启动：添加实例。
 *
 * 空状态直接给可执行动作——桌面用户要的是"在这输地址"，
 * 不是一段产品介绍。
 *
 * 添加前先探活：让用户在**这一步**就知道地址对不对、版本是否可用，
 * 而不是等到登录时才失败（那时用户会怀疑是密码问题）。
 */
export function ConnectInstance({ onAdded }: { onAdded: (id: string, info: InstanceInfo) => void }) {
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
        if (info.reachable && instance.id) {
          onAdded(instance.id, info);
        }
      },
    });
  };

  const info = probe ?? null;

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <form onSubmit={submit} className="w-full max-w-[420px]">
        <h1 className="font-display mb-1 text-lg text-bone">{t("session.connectTitle")}</h1>
        <p className="mb-5 text-[12px] leading-relaxed text-muted">
          {t("session.connectHint")}
        </p>

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
        {info && <ProbeResult info={info} />}

        {addInstance.isError && (
          <p className="mt-3 text-[12px] text-[var(--color-rose)]">
            {t("session.addFailed", { error: String(addInstance.error) })}
          </p>
        )}
      </form>
    </div>
  );
}

/** 探活结果。不可达时给出原因与可重试动作，而不是"出错了"。 */
function ProbeResult({ info }: { info: InstanceInfo }) {
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

  // 版本过旧是**阻断式**的：不尝试"降级兼容"，半兼容状态比明确失败更难查。
  const tooOld = info.apiCompat?.apiMin && info.apiCompat.apiMin !== "v1";

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
        <p className="mt-0.5 text-[11px] text-muted">
          {t("session.noContract")}
        </p>
      )}
      {tooOld && (
        <p className="mt-1 text-[11px] text-[var(--color-rose)]">
          {t("session.tooOld")}
        </p>
      )}
    </div>
  );
}




