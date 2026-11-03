/* Fictional agent runs for the approval console. */
window.KUSTOS_AGENT_RUNS = [
  {
    id: "A-1042",
    title: "Review LFS token scope",
    repo: "lin/atlas",
    branch: "main",
    status: "awaiting",
    model: "gpt-4o-mini",
    session: "LFS hardening",
    created: "18m ago",
    startedBy: "Lin Wei",
    duration: "2m 14s",
    tokensUsed: 18400,
    promptTokens: 14352,
    completionTokens: 4048,
    cachedTokens: 2583,
    stepCount: 6,
    prompt: "Review the LFS token changes in PR #142 and tell me if any write path can be reached without a repo-scoped token. If you find a gap, open an issue with the repro.",
    memory: "PR #142 hardens LFS token scope; e2e is still queued. A write token can be replayed on the download path.",
    steps: [
      { type: "tool", name: "search_code", detail: 'query: "transfer_token scope"', meta: "8 hits · 412 ms" },
      { type: "tool", name: "read_file", detail: "app/services/lfs.py · lines 68–112", meta: "98 ms" },
      { type: "tool", name: "get_diff", detail: "PR #142 · 3 files", meta: "+148 −37 · 210 ms" },
      { type: "tool", name: "find_usages", detail: "verify_transfer_token", meta: "6 references · 64 ms" },
      {
        type: "assistant",
        content: "I found one gap. <span class=\"mono\">TransferTokenService.verify</span> accepts any write-scoped token when the expected action is <span class=\"mono\">read</span>. The batch route mints write tokens, so the download endpoint can be reached with an upload token. The PR's exact-match change closes it, but the regression test is the real guard."
      }
    ],
    approval: {
      tool: "create_issue",
      args: [
        ["repository", "lin/atlas"],
        ["title", "LFS download accepts upload-scoped transfer tokens"],
        ["labels", "security, lfs"],
        ["body", "Repro: mint a write token, then call the download endpoint with action=read. Current verify accepts it."]
      ],
      reason: "Opening an issue writes to the tracker. Kustos stops here until you decide.",
      note: "Nothing has been written. The job is paused and can be resumed from this card."
    }
  },
  {
    id: "A-1040",
    title: "Audit agent write tools",
    repo: "lin/atlas",
    branch: "main",
    status: "running",
    model: "gpt-4.1-mini",
    session: "Agent safety",
    created: "6m ago",
    startedBy: "Lin Wei",
    duration: "6m 02s",
    tokensUsed: 9100,
    promptTokens: 7098,
    completionTokens: 2002,
    cachedTokens: 1278,
    stepCount: 3,
    prompt: "Audit every write tool in the registry for a repository-scoped permission check. Report anything that can execute before approval.",
    memory: "The write registry is being compared against the repo action matrix. No findings yet.",
    steps: [
      { type: "tool", name: "search_code", detail: 'query: "requires_approval"', meta: "12 hits · 380 ms" },
      { type: "tool", name: "read_file", detail: "app/services/agent/tools_write.py", meta: "112 ms" },
      { type: "assistant", content: "Working through the write registry now. The approval gate is present on all eight tools; I am checking whether each handler re-checks <span class=\"mono\">AGENT_WRITE</span> before the side effect." }
    ]
  },
  {
    id: "A-1039",
    title: "Triage search fallback",
    repo: "lin/atlas",
    branch: "main",
    status: "succeeded",
    origin: "trigger",
    writeEnabled: false,
    model: "gpt-4o-mini",
    session: "Search quality",
    created: "1h ago",
    startedBy: "Trigger · issue.opened",
    duration: "1m 08s",
    tokensUsed: 12400,
    promptTokens: 9672,
    completionTokens: 2728,
    cachedTokens: 1741,
    stepCount: 3,
    prompt: "Why does search on large repositories fall back to a Git tree scan? Read issue #91 and the index guard.",
    memory: "The guard is explicit; the missing surface is index status.",
    steps: [
      { type: "tool", name: "read_file", detail: "app/services/search_service.py · guard block", meta: "84 ms" },
      { type: "tool", name: "get_issue", detail: "#91 · search index fallback", meta: "2 comments · 61 ms" },
      { type: "assistant", content: "The fallback is an intentional guard, not a failed rebuild. Repositories above <span class=\"mono\">index_max_files</span> skip indexing and every request scans the Git tree. Results stay correct; the missing piece is a visible <span class=\"mono\">source=git_tree</span> label and index status in the repo header." }
    ]
  },
  {
    id: "A-1031",
    title: "Draft release notes for v0.9.4",
    repo: "lin/atlas",
    branch: "main",
    status: "succeeded",
    model: "gpt-4o-mini",
    session: "Release prep",
    created: "2h ago",
    startedBy: "Lin Wei",
    duration: "48s",
    tokensUsed: 7800,
    promptTokens: 6084,
    completionTokens: 1716,
    cachedTokens: 1095,
    stepCount: 3,
    prompt: "Draft release notes for v0.9.4 from the last 20 commits. Group by feature, fix and internal.",
    memory: "Release notes drafted; two commits need a human summary.",
    steps: [
      { type: "tool", name: "list_commits", detail: "main · last 20", meta: "20 commits · 92 ms" },
      { type: "tool", name: "get_diff", detail: "8f3c2a1..c41d7e0", meta: "+412 −118 · 240 ms" },
      { type: "assistant", content: "Draft ready: <strong>LFS token scope</strong>, <strong>presence heartbeat cleanup</strong>, and <strong>index status</strong>. Two internal commits need a human summary before publishing." }
    ]
  },
  {
    id: "A-1027",
    title: "Why did atlas-e2e fail?",
    repo: "lin/atlas",
    branch: "main",
    status: "failed",
    model: "gpt-4o-mini",
    session: "Build triage",
    created: "3h ago",
    startedBy: "Lin Wei",
    duration: "22s",
    tokensUsed: 3100,
    promptTokens: 2418,
    completionTokens: 682,
    cachedTokens: 435,
    stepCount: 2,
    prompt: "Why did atlas-e2e fail on main? Check the build logs and the last three commits.",
    memory: "The build callback returned no log lines. The run failed before the model could answer.",
    steps: [
      { type: "tool", name: "get_build_logs", detail: "atlas-e2e · build 8f3c2a1", meta: "0 lines · 41 ms" },
      { type: "error", content: "The build log buffer was empty. The run stopped rather than guessing at a cause." }
    ]
  },
  {
    id: "A-1018",
    title: "Review recent changes",
    repo: "lin/atlas",
    branch: "main",
    status: "succeeded",
    model: "gpt-4o-mini",
    session: "Weekly watch",
    created: "yesterday",
    startedBy: "Trigger · push",
    duration: "1m 36s",
    tokensUsed: 15600,
    promptTokens: 12168,
    completionTokens: 3432,
    cachedTokens: 2190,
    stepCount: 3,
    prompt: "Review the last 24 hours of changes on main and flag anything that deserves a second pair of eyes.",
    memory: "Three commits reviewed; one deserves review by the LFS owner.",
    steps: [
      { type: "tool", name: "review_recent_changes", detail: "main · last 24h", meta: "3 commits · 120 ms" },
      { type: "tool", name: "get_diff", detail: "8f3c2a1", meta: "2 files · 88 ms" },
      { type: "assistant", content: "All changes look routine. The LFS token change is the only one that touches a trust boundary; it already has a review thread. No new issue opened." }
    ]
  }
];
