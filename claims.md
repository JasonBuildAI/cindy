# Coordination claims (append-only)

- claim: jb-a7c3 | 2026-10-13T12:06:00+08:00 | 旧PR: #4972 | 缺陷: cron 引擎在 30 分钟 DST 偏移（Australia/Lord_Howe）下 nextRun 返回已过去的时刻，调度器按 tick 重复触发该小时内任务 | 文件: packages/maker-scheduler/src/engine/cron.ts | issue: #5924 | PR: #5925
- claim: cx7c4e | 2026-10-13T13:14:06+08:00 | 旧PR: none | 缺陷: composer「引用目录」系统项文案「Mivo 作品库（只读）」硬编码简体中文未接入 i18n，非简中界面下显示错误语言 | 文件: apps/desktop/src/renderer/components/new-chat/extraDirsActions.ts,apps/desktop/src/renderer/components/new-chat/AtMentionPanel.tsx | issue: #5929 | PR: #5948
- claim: 01a13335 | 2026-10-13T13:35:00+08:00 | 旧PR: none | 缺陷: 工具结果落库被 8KB 截断后变成非法 JSON，对象键/数组分隔符被当成源码语法，全部 xdt-file 投递在重开任务后消失（含移动端文件卡片） | 文件: packages/maker-shared/src/payloadSummary.ts | issue: #待回填
