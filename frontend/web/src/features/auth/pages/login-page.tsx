import { useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Bot,
  Eye,
  EyeOff,
  GitCommitHorizontal,
  Globe,
  Lock,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";

/** 原型 .input 的 Tailwind 翻译（登录页专用尺寸，比 ui/Input 矮一截）。 */
const INPUT_CLS =
  "border-edge-2 bg-ink-950/55 text-bone h-[34px] w-full rounded-md border px-3 text-[12.5px] transition-colors outline-none placeholder:text-faint focus:border-amber/55 focus:shadow-[0_0_0_3px_rgba(242,174,91,0.08)]";

/** 品牌侧的三条卖点（原型 login-features）。 */
const FEATURES = [
  { icon: GitCommitHorizontal, label: "裸 Git + 原生 HTTP / SSH 协议" },
  { icon: Bot, label: "Agent 写操作必须显式批准" },
  { icon: Users, label: "实时协同编辑与房间聊天" },
] as const;

/**
 * 登录页（原型 login.html）。
 *
 * AppShell 外的独立全屏页：左侧品牌叙事（字标、宣言、卖点、页脚），
 * 右侧登录表单：提交走真实会话接口（auth-store.login），成功进工作台。
 */
export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const pending = useAuthStore((state) => state.pending);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 提交登录：成功进工作台，失败在表单内给出错误条。 */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("请输入用户名和密码。");
      return;
    }
    setError(null);
    try {
      await login(username.trim(), password);
      navigate("/", { replace: true });
    } catch {
      // 后端 401 的 detail 已被语言协商翻译，但不外传细节，统一给表单错误
      setError(t("auth.invalidCredentials"));
    }
  };

  return (
    <div className="bg-ink-950 min-h-screen overflow-x-hidden lg:grid lg:grid-cols-[minmax(430px,1.08fr)_minmax(420px,0.92fr)]">
      {/* 氛围：左上琥珀提灯 + 右下冷光（原型 login-body） */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(900px_700px_at_18%_20%,rgba(242,174,91,0.1),transparent_62%),radial-gradient(800px_600px_at_90%_90%,rgba(131,169,196,0.05),transparent_60%)]"
      />

      {/* ---------------- 品牌侧 ---------------- */}
      <section
        aria-labelledby="login-brand-title"
        className="border-edge-1 bg-[radial-gradient(700px_480px_at_20%_46%,rgba(242,174,91,0.1),transparent_68%),linear-gradient(155deg,rgba(21,35,42,0.72),rgba(8,13,16,0.5))] relative flex min-h-[360px] flex-col justify-between overflow-hidden border-b p-[28px_30px_24px] lg:min-h-screen lg:border-r lg:border-b-0 lg:p-[34px_46px_30px]"
      >
        {/* 品牌区左侧的琥珀发丝竖线 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 left-[54px] w-px bg-[linear-gradient(180deg,transparent,rgba(242,174,91,0.16)_30%,rgba(242,174,91,0.04)_72%,transparent)] lg:left-[74px]"
        />
        {/* 右下角大水印字标 */}
        <span
          aria-hidden="true"
          className="font-display pointer-events-none absolute -right-[140px] -bottom-[180px] text-[480px] leading-none text-bone opacity-[0.045] select-none lg:-right-[90px] lg:-bottom-[90px] lg:text-[560px]"
        >
          K
        </span>

        {/* 字标 + 自托管胶囊 */}
        <div className="relative z-[1] flex items-start justify-between gap-5">
          <span className="inline-flex items-center gap-3">
            <span className="bg-amber/15 text-amber-2 font-display grid size-[42px] shrink-0 place-items-center rounded-md text-[20px]">
              K
            </span>
            <span>
              <span className="font-display text-bone block text-[24px] font-semibold tracking-[0.16em] leading-none">
                KUSTOS
              </span>
              <span className="text-faint mt-1 block text-[7.5px] font-semibold tracking-[0.2em]">
                SELF-HOSTED GIT FORGE
              </span>
            </span>
          </span>
          <span className="border-edge-1 bg-ink-800/70 text-muted inline-flex h-7 items-center gap-[7px] whitespace-nowrap rounded-full border px-2.5 text-[11px]">
            <Lock className="size-3" aria-hidden="true" />
            {t("auth.selfHosted")}
          </span>
        </div>

        {/* 宣言区 */}
        <div className="relative z-[1] max-w-[560px] py-[42px] lg:py-[60px]">
          <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">
            MERIDIAN · NORTHSTAR LABS
          </p>
          <h1
            id="login-brand-title"
            className="font-display text-bone mt-4 text-[clamp(2.7rem,5.4vw,5.1rem)] font-medium tracking-[-0.045em] leading-[0.96]"
          >
            守护真正
            <br />
            重要的代码。
          </h1>
          <p className="text-muted mt-6 max-w-[42ch] text-[14.5px] leading-[1.62]">
            一座安静的自托管 Git 锻炉，配一位常驻守护者。仓库、评审、实时房间与一个谨慎的 Agent
            ——全部跑在你自己的机器上。
          </p>
          <ul className="border-edge-1 mt-[38px] hidden max-w-[390px] flex-col border-t lg:flex">
            {FEATURES.map((feature) => (
              <li key={feature.label} className="border-edge-1 flex items-center gap-2.5 border-b py-2.5 text-[11.5px] text-bone-2 last:border-b-0">
                <feature.icon className="text-amber size-3.5 shrink-0" aria-hidden="true" />
                <span>{feature.label}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* 页脚 */}
        <footer className="text-faint relative z-[1] flex items-center gap-[18px] text-[9.5px]">
          <span className="text-muted-2 inline-flex items-center gap-[7px]">
            <ShieldCheck className="size-3" aria-hidden="true" />
            仅登录入口
          </span>
          <span className="font-mono ml-auto hidden sm:inline">MIT · meridian.northstar.dev</span>
        </footer>
      </section>

      {/* ---------------- 表单侧 ---------------- */}
      <section aria-labelledby="login-title" className="bg-ink-950/55 grid place-items-center p-[36px_20px_50px] lg:p-10">
        <div className="w-full max-w-[382px]">
          <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">NORTHSTAR LABS</p>
          <h2 id="login-title" className="font-display text-bone mt-2.5 text-[26px] font-medium tracking-[-0.03em] leading-none">
            欢迎回来。
          </h2>
          <p className="text-muted mt-2 text-[11px]">登录以继续。</p>

          <form className="mt-[30px] flex flex-col gap-[15px]" onSubmit={handleSubmit} noValidate>
            <div>
              <label htmlFor="username" className="text-bone-2 mb-1.5 block text-[11.5px] font-medium">
                用户名
              </label>
              <input
                id="username"
                name="username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                spellCheck={false}
                required
                className={INPUT_CLS}
              />
            </div>

            <div>
              <div className="mb-[-1px] flex items-center justify-between">
                <label htmlFor="password" className="text-bone-2 text-[11.5px] font-medium">
                  {t("auth.password")}
                </label>
                <button
                  type="button"
                  onClick={() => toast.info("本实例不提供自助重置：请联系实例管理员签发新密码。")}
                  className="text-muted hover:text-amber-2 rounded-sm text-[10.5px] transition-colors hover:underline decoration-amber/45 underline-offset-[3px]"
                >
                  忘记密码？
                </button>
              </div>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  className={cn(INPUT_CLS, "pr-[42px]")}
                />
                <button
                  type="button"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((visible) => !visible)}
                  className={cn(
                    "absolute top-1/2 right-[3px] grid size-7 -translate-y-1/2 place-items-center rounded-md transition-colors hover:bg-bone/5",
                    showPassword ? "text-amber" : "text-muted-2",
                  )}
                >
                  {showPassword ? <EyeOff className="size-[15px]" aria-hidden="true" /> : <Eye className="size-[15px]" aria-hidden="true" />}
                </button>
              </div>
            </div>

            {error ? (
              <p role="alert" className="border-rose/30 bg-rose/10 text-rose-2 rounded-md border px-2.5 py-2 text-[11px]">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={pending}
              className="bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 flex h-[38px] w-full items-center justify-center gap-2 rounded-md border text-[12.5px] font-semibold text-ink-950 transition-colors disabled:opacity-50"
            >
              {pending ? t("common.loading") : t("auth.signInWithPassword")}
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </button>
          </form>

          {/* 分隔线 */}
          <div className="text-faint my-[22px] mb-3.5 flex items-center gap-3 text-[9.5px] tracking-[0.08em] uppercase">
            <span className="border-edge-1 h-px flex-1 border-t" />
            <span>{t("auth.oauthProviders")}</span>
            <span className="border-edge-1 h-px flex-1 border-t" />
          </div>

          {/* 第三方登录 */}
          <div className="grid gap-2">
            {["GitHub", "GitLab"].map((provider) => (
              <button
                key={provider}
                type="button"
                onClick={() => toast.info(`${provider} OAuth 由实例管理员配置（环境变量，受保护）。`)}
                className="border-edge-2 bg-ink-750/55 hover:border-edge-3 hover:bg-ink-750 text-muted hover:text-bone inline-flex h-[34px] w-full items-center justify-center gap-2 rounded-md border text-[12px] font-medium transition-colors"
              >
                <Globe className="size-[15px]" aria-hidden="true" />
                {provider}
              </button>
            ))}
          </div>

          <p className="text-muted-2 mt-[26px] text-center text-[11px]">
            第一次使用 Kustos？{" "}
            <button
              type="button"
              onClick={() => toast.info("本实例开放自助注册 —— POST /api/v1/users。")}
              className="text-bone-2 hover:text-amber-2 rounded-sm transition-colors hover:underline decoration-amber/45 underline-offset-[3px]"
            >
              创建账号
            </button>
          </p>

          <p className="text-faint mt-[30px] text-center text-[9.5px]">
            <span className="font-mono">kustos 1.0.0</span> · self-hosted ·{" "}
            <Link to="/" className="text-muted-2 hover:text-amber-2 underline decoration-edge-2 underline-offset-[3px] transition-colors">
              返回应用预览
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
