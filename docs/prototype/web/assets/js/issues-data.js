/* Fictional issue tracker contents. */
window.KUSTOS_ISSUES = [
  {
    id: 94,
    title: "Agent approval can be lost if the worker restarts between CAS and enqueue",
    status: "open",
    priority: "high",
    labels: ["agent", "reliability"],
    author: { name: "Noor Haddad", initials: "NH", color: "rose" },
    assignee: { name: "Lin Wei", initials: "LW", color: "amber" },
    opened: "18m ago",
    updated: "2m ago",
    body: [
      "Seen twice in staging. <span class=\"mono\">AgentService.approve</span> commits the approval decision, then the job is re-enqueued in a separate await. If the worker dies in between, the job sits in <span class=\"mono\">queued</span> with <span class=\"mono\">approval_decision=approved</span> and nothing picks it up.",
      "<span class=\"mono\">reclaim_stale_jobs</span> only reconciles jobs older than the stale timeout, so the window is small but real. The inline queue path has the same shape."
    ],
    code: {
      label: "app/services/agent_service.py",
      lines: [
        "await self._store_decision(job_id, decision)",
        "await self._queue.enqueue(process_agent_job, job_id)",
        "# crash between these two lines leaves a queued job with no worker"
      ]
    },
    triage: {
      summary: "The approval decision and the queue hand-off are not atomic. A boot-time reconcile of approved-but-unqueued jobs is the smallest safe fix.",
      next: "Check whether the inline queue path can reuse the same reconciliation helper."
    },
    comments: [
      {
        author: { name: "Noor Haddad", initials: "NH", color: "rose" },
        time: "18m ago",
        body: "Repro is intermittent but the window is visible in the audit trail: decision at 14:02:11, no worker claim after. I can share the two job IDs."
      },
      {
        author: { name: "Kustos agent", initials: "KA", color: "bot", bot: true },
        time: "14m ago",
        body: "Triage: the write is committed before the queue publish. A boot sweep over <span class=\"mono\">status=queued AND approval_decision=approved</span> is likely sufficient. I did not open a fix because that requires write approval."
      },
      {
        author: { name: "Lin Wei", initials: "LW", color: "amber" },
        time: "9m ago",
        body: "I can take this. Smallest fix is a reconciliation sweep at worker boot, but let's confirm the queue is the only gap before adding a new table."
      },
      {
        author: { name: "Ilya Sokolov", initials: "IS", color: "sky" },
        time: "2m ago",
        body: "Also check the inline queue path — there is no arq entry there, so a restart is even less recoverable."
      }
    ]
  },
  {
    id: 91,
    title: "Search index silently falls back to Git tree on monorepos",
    pullRequests: [{ number: 139, title: "Bound semantic recall to the default branch", status: "open", closesOnMerge: false }],
    status: "open",
    priority: "high",
    labels: ["search", "performance"],
    author: { name: "Ilya Sokolov", initials: "IS", color: "sky" },
    assignee: { name: "Ilya Sokolov", initials: "IS", color: "sky" },
    opened: "2h ago",
    updated: "28m ago",
    body: [
      "Repositories above <span class=\"mono\">index_max_files</span> skip the index and every search request falls back to a Git tree substring scan. The response says <span class=\"mono\">source=git_tree</span>, but the UI does not surface that as a degradation.",
      "The search still returns correct results. It is just slow enough that people assume the index is broken."
    ],
    triage: {
      summary: "This is an explicit guard, not a bug. The missing piece is a visible index status and a clear fallback label in the search surface.",
      next: "Expose index state in the repo header before changing the guard."
    },
    comments: [
      {
        author: { name: "Noor Haddad", initials: "NH", color: "rose" },
        time: "1h ago",
        body: "The admin status endpoint already knows this. We just never show it in the repository UI."
      },
      {
        author: { name: "Ilya Sokolov", initials: "IS", color: "sky" },
        time: "28m ago",
        body: "I opened #139 to bound semantic recall; it does not fix the guard. Keeping this open for the status surface."
      }
    ]
  },
  {
    id: 88,
    title: "DM room presence stays green after the tab closes",
    status: "open",
    priority: "medium",
    labels: ["realtime", "bug"],
    author: { name: "Mara Voss", initials: "MV", color: "rose" },
    assignee: null,
    opened: "5h ago",
    updated: "4h ago",
    body: [
      "Closing a DM tab does not decrement the presence refcount. The Redis hash entry expires after the TTL, but the room list keeps the green dot until a reload.",
      "Likely the <span class=\"mono\">room_leave</span> handler is only wired for repository rooms."
    ],
    triage: {
      summary: "Presence expiry is server-side and correct; the room list does not re-read after the TTL. A presence invalidation event on room leave is the likely fix.",
      next: "Compare the DM leave path with the repository room leave path."
    },
    comments: [
      {
        author: { name: "Mara Voss", initials: "MV", color: "rose" },
        time: "5h ago",
        body: "Not urgent, but it makes the DM list feel haunted. I can pick it up after the LFS PR."
      }
    ]
  },
  {
    id: 83,
    title: "Expose index generation in admin status",
    status: "open",
    priority: "low",
    labels: ["admin", "search"],
    author: { name: "Noor Haddad", initials: "NH", color: "rose" },
    assignee: { name: "Noor Haddad", initials: "NH", color: "rose" },
    opened: "1d ago",
    updated: "1d ago",
    body: [
      "The admin search status shows the indexed commit but not <span class=\"mono\">index_generation</span>. When a generation bump forces a rebuild, operators cannot tell whether the old generation is still serving.",
      "Add it to the existing status payload and the admin card."
    ],
    triage: {
      summary: "Read-only surface change. The state row already stores the generation; no migration is needed.",
      next: "Add the field to the response and render it next to the indexed commit."
    },
    comments: [
      {
        author: { name: "Noor Haddad", initials: "NH", color: "rose" },
        time: "1d ago",
        body: "I will do this one; it is a small response-shape change."
      }
    ]
  },
  {
    id: 76,
    title: "LFS uploads >5GB fail before the size guard",
    pullRequests: [{ number: 142, title: "Harden LFS transfer token scope", status: "open", closesOnMerge: true }],
    status: "open",
    priority: "medium",
    labels: ["lfs", "bug"],
    author: { name: "Mara Voss", initials: "MV", color: "rose" },
    assignee: { name: "Mara Voss", initials: "MV", color: "rose" },
    opened: "2d ago",
    updated: "3h ago",
    body: [
      "The gateway rejects the upload body before the application-level <span class=\"mono\">lfs.max_upload_size</span> check runs. The user gets a generic 413 with no object id.",
      "We should either align the gateway limit or stream the size check earlier. The PR for token scope is separate; linking for context."
    ],
    triage: {
      summary: "The gateway body limit and the LFS size guard disagree. Align the limits first; the error message is secondary.",
      next: "Confirm the deployed gateway <span class=\"mono\">client_max_body_size</span> before touching the app guard."
    },
    comments: [
      {
        author: { name: "Mara Voss", initials: "MV", color: "rose" },
        time: "2d ago",
        body: "I can reproduce with a 6GB object. The request never reaches the app log."
      },
      {
        author: { name: "Lin Wei", initials: "LW", color: "amber" },
        time: "3h ago",
        body: "Linked #142 so we do not confuse the token failure with the body limit."
      }
    ]
  },
  {
    id: 72,
    title: "Add rebase merge strategy to the PR surface",
    status: "closed",
    priority: "low",
    labels: ["frontend", "pr"],
    author: { name: "Ilya Sokolov", initials: "IS", color: "sky" },
    assignee: { name: "Lin Wei", initials: "LW", color: "amber" },
    opened: "6d ago",
    updated: "2d ago",
    closedBy: "Lin Wei",
    body: [
      "The merge endpoint supports rebase, but the PR surface only offers merge and squash. Add the third option with a clear history note."
    ],
    triage: {
      summary: "Backend support already exists. This is a presentation and copy change.",
      next: "Use the same three-option dialog as the merge modal."
    },
    comments: [
      {
        author: { name: "Lin Wei", initials: "LW", color: "amber" },
        time: "2d ago",
        body: "Shipped in the review-flow update. Closing."
      }
    ]
  },
  {
    id: 68,
    title: "Presence TTL does not refresh on room switch",
    status: "closed",
    priority: "medium",
    labels: ["realtime", "bug"],
    author: { name: "Noor Haddad", initials: "NH", color: "rose" },
    assignee: { name: "Noor Haddad", initials: "NH", color: "rose" },
    opened: "8d ago",
    updated: "5d ago",
    closedBy: "Noor Haddad",
    body: [
      "Switching rooms quickly could leave the previous room's presence key alive until the TTL. Fixed by refreshing on every successful join."
    ],
    triage: {
      summary: "Fixed by the join-path refresh. No further action.",
      next: "No action."
    },
    comments: [
      {
        author: { name: "Noor Haddad", initials: "NH", color: "rose" },
        time: "5d ago",
        body: "Verified in staging with a 90s TTL. Closing."
      }
    ]
  },
  {
    id: 65,
    title: "Rate-limit agent job creation per room",
    status: "open",
    priority: "medium",
    labels: ["agent"],
    author: { name: "Ilya Sokolov", initials: "IS", color: "sky" },
    assignee: null,
    opened: "3d ago",
    updated: "1d ago",
    body: [
      "A noisy room can trigger many <span class=\"mono\">@kustos-agent</span> jobs at once. Per-user concurrency exists, but there is no room-level throttle.",
      "A small token bucket on the room would keep one channel from consuming the global budget."
    ],
    triage: {
      summary: "The chat bridge already deduplicates malformed mentions. A room-level limiter belongs before job creation, not inside the runtime.",
      next: "Decide whether the limit is per room or per repository."
    },
    comments: [
      {
        author: { name: "Ilya Sokolov", initials: "IS", color: "sky" },
        time: "1d ago",
        body: "Low urgency, but worth a small guard before we enable triggers for everyone."
      }
    ]
  },
  {
    id: 62,
    title: "Index status endpoint returns stale generation after rebuild",
    status: "open",
    priority: "medium",
    labels: ["search"],
    author: { name: "Noor Haddad", initials: "NH", color: "rose" },
    assignee: { name: "Noor Haddad", initials: "NH", color: "rose" },
    opened: "3d ago",
    updated: "2d ago",
    body: [
      "After a manual reindex, the status endpoint keeps returning the previous <span class=\"mono\">index_generation</span> until the next request path rebuild. The state row is written, but the endpoint reads from a cached snapshot."
    ],
    triage: {
      summary: "Likely a read-after-write cache issue. The state row itself looks correct.",
      next: "Invalidate the status cache in the rebuild completion path."
    },
    comments: [
      {
        author: { name: "Noor Haddad", initials: "NH", color: "rose" },
        time: "2d ago",
        body: "Reproduced on harbor too. It is not atlas-specific."
      }
    ]
  },
  {
    id: 59,
    title: "DM unread count drifts after reconnect",
    status: "open",
    priority: "low",
    labels: ["realtime"],
    author: { name: "Mara Voss", initials: "MV", color: "rose" },
    assignee: null,
    opened: "4d ago",
    updated: "3d ago",
    body: [
      "After a WebSocket reconnect, a DM can show one extra unread message until the next read receipt. The REST unread count and the socket payload disagree for a moment."
    ],
    triage: {
      summary: "The socket reconnect path does not replay the read cursor. Persisted unread state is correct.",
      next: "Replay the last read timestamp on reconnect."
    },
    comments: [
      {
        author: { name: "Mara Voss", initials: "MV", color: "rose" },
        time: "3d ago",
        body: "Cosmetic but annoying. I will pick it up with the presence fix."
      }
    ]
  },
  {
    id: 55,
    title: "LFS batch response leaks internal object paths",
    status: "open",
    priority: "high",
    labels: ["lfs", "bug"],
    author: { name: "Lin Wei", initials: "LW", color: "amber" },
    assignee: { name: "Mara Voss", initials: "MV", color: "rose" },
    opened: "5d ago",
    updated: "4d ago",
    body: [
      "The batch response includes a debug field with the local storage path. It is only visible to authenticated users, but it should not leave the application boundary.",
      "Remove the field and keep the object id as the only public handle."
    ],
    triage: {
      summary: "Small response-shape fix. No storage change required.",
      next: "Drop the debug field and add a response-shape test."
    },
    comments: [
      {
        author: { name: "Mara Voss", initials: "MV", color: "rose" },
        time: "4d ago",
        body: "I included the fix in #142 since I was already in this file."
      }
    ]
  },
  {
    id: 51,
    title: "Add a keyboard shortcut for the command palette",
    status: "closed",
    priority: "low",
    labels: ["frontend"],
    author: { name: "Ilya Sokolov", initials: "IS", color: "sky" },
    assignee: { name: "Lin Wei", initials: "LW", color: "amber" },
    opened: "9d ago",
    updated: "6d ago",
    closedBy: "Lin Wei",
    body: [
      "The palette is only reachable from the search button. Add <span class=\"mono\">Ctrl K</span> and <span class=\"mono\">/</span> as global shortcuts."
    ],
    triage: {
      summary: "Shipped with the shell update.",
      next: "No action."
    },
    comments: [
      {
        author: { name: "Lin Wei", initials: "LW", color: "amber" },
        time: "6d ago",
        body: "Both shortcuts are live. Closing."
      }
    ]
  }
];
