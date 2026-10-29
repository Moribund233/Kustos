/**
 * Agent 控制台的本地视图类型。
 *
 * schema.d.ts 里 agent 端点的响应体是 `unknown`，页面按后端
 * agent_controller 的实际字段（jobs 列表 / 详情 / steps / pending_approval）
 * 映射到这些类型后渲染。
 */

/** 运行状态：与后端 AgentJob.status 同名（services/agent_service.py 的 STATUS_*）。 */
export type RunStatus = "queued" | "running" | "awaiting_approval" | "succeeded" | "failed" | "cancelled";

/** 工具调用步：参数为键值对，result 是给读者的结果摘要。 */
export interface ToolStep {
  type: "tool";
  name: string;
  args: [string, string][];
  result: string;
  /** 写工具等待批准：轨迹里单独标出，配合审批卡出现。 */
  pending?: boolean;
}

/** 非工具步：助手结论、失败原因或状态备注（页面负责渲染）。 */
export interface TextStep {
  type: "assistant" | "error" | "note";
  content: string;
}

export type RunStep = ToolStep | TextStep;

export interface AgentRun {
  id: string;
  title: string;
  repo: string;
  status: RunStatus;
  model: string;
  /** 会话短 id（AgentSession.id 前 8 位）。 */
  session: string;
  created: string;
  duration: string;
  tokens: { prompt: number; completion: number; cached: number };
  /** 提问原文。 */
  prompt: string;
  /** 回答 Markdown；运行中尚未定稿时取最近一条 assistant 步，失败的运行可以为空。 */
  answer: string;
  /** 运行中的回答仍在流式输出。 */
  streaming?: boolean;
  steps: RunStep[];
  /** 待审批的写工具；批准或拒绝后由后端清除。 */
  approval?: {
    tool: string;
    args: [string, string][];
    reason: string;
    note: string;
  };
}
