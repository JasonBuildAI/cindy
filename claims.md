# Coordination claims (append-only)

- claim: jb-a7c3 | 2026-10-13T12:06:00+08:00 | 旧PR: #4972 | 缺陷: cron 引擎在 30 分钟 DST 偏移（Australia/Lord_Howe）下 nextRun 返回已过去的时刻，调度器按 tick 重复触发该小时内任务 | 文件: packages/maker-scheduler/src/engine/cron.ts | issue: #5924 | PR: #5925
