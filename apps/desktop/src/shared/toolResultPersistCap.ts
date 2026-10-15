/**
 * tool_result 落库正文上限(chat-data perf):全文不再无界写进 messages.content。
 *
 * 背景:7GB 级本地库里 tool_result 占了绝对大头(单条可达 MB 级、177 万行里
 * 4.5GB),而它既不进 FTS、不进嵌入、不做侧栏预览,device-link 同步到手机也早已
 * 截到 8KB(dispatch.ts REMOTE_TOOL_RESULT_CONTENT_LIMIT)。本地持久化对齐同一
 * 阈值:重开任务仍能看到开头 8K 字符,当前 turn 的完整内容继续走内存
 * resolvedContent,Agent 续跑走 SDK transcript,不依赖这张表。
 *
 * 媒体挂账契约:截断丢弃的尾部可能含首次出现的 cindy-media blob URL,调用方
 * 必须**先对原文扫 URL 挂账、再截断**(见 messagePersistBroadcaster 的
 * persistableToolResultContent),否则生成产物会被 recycler 判零引用回收。
 *
 * 呈现控制契约:只做减法的那一个判定(`_xdt_render_image:false` 抑制文件卡)
 * 若落在切点之后,就从保留的前缀里彻底消失,读取侧无法反推——重开任务/手机历史
 * 会把同一份结果读成"未抑制",重新长出 live 从未投递的文件卡。截断前先按读取侧
 * 同一判定把抑制决定提到切口之前(与 device-link 投影「控制位先于引用」同一条
 * 规则,见 mobileToolProjection 的 projectMobileToolResult),live 与重开的结论
 * 才会一致。
 *
 * 纯函数、无依赖:main 侧 broadcaster、Claude 导入准备层与 DB worker importer
 * (tx.ts / inline worker fallback)共用同一份,保证所有写入口一个口径。
 * 导入路径的媒体挂账在 main 侧对原文执行(worker 碰不到 cindy-media ledger)。
 */

export const TOOL_RESULT_PERSIST_CONTENT_LIMIT = 8 * 1024;

export const TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX =
  '\n\n[tool result truncated: stored first 8KB]';

/** 抑制决定提上来时占用的头,插入根对象第一个成员的位置。 */
const SUPPRESSED_RENDER_HEAD = '"_xdt_render_image":false,';

/**
 * 保留前缀要带上的抑制头:正文是 JSON 对象、且它自身的判定是"不渲染"时返回
 * 抑制头,否则返回空串。
 *
 * 这里刻意不引入 @cindy/maker-shared/payload-summary 的 parseToolResultPayload:
 * 本模块被 DB worker 打包,而 worker 目前只做类型级引用,不拖整包进来。判定规则
 * 与该函数保持一致(外层 `_xdt_render_image:false`,以及 `ok:true` 信封里
 * `result` 上的同一个字段),由 toolResultPersistCap.test.ts 对照锁定。
 */
function suppressionHeadFor(text: string, limit: number): string {
  // 便宜的前置筛:正文压根没提这个字段就别解析(MB 级 tool_result 很常见)。
  if (text[0] !== '{' || !text.includes('_xdt_render_image')) return '';
  if (limit < TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length + SUPPRESSED_RENDER_HEAD.length) return '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const outer = parsed as Record<string, unknown>;
    if (outer._xdt_render_image === false) return SUPPRESSED_RENDER_HEAD;
    const inner = outer.ok === true ? outer.result : null;
    const record = inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? inner as Record<string, unknown> : null;
    return record?._xdt_render_image === false ? SUPPRESSED_RENDER_HEAD : '';
  } catch {
    // 不是 JSON(或半截 JSON)就没有可保留的已解码判定。
    return '';
  }
}

/**
 * 把 tool_result 正文截到落库上限,超限时带截断后缀。按字符数截(不是字节):
 * 上限的意义是"有界",不追求与 device-link 的字节口径逐字节一致。切点回退一位
 * 避免劈开 surrogate pair。幂等:已截断的文本长度必然 <= 上限,不会二次截断。
 */
export function capToolResultTextForPersist(
  text: string,
  limit = TOOL_RESULT_PERSIST_CONTENT_LIMIT,
): string {
  if (text.length <= limit) return text;
  const suppression = suppressionHeadFor(text, limit);
  let cut = Math.max(0, limit - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length - suppression.length);
  const lastKept = text.charCodeAt(cut - 1);
  if (cut > 0 && lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1;
  // 抑制头插在根对象的左花括号之后:保留下来的仍是同一份文档的 JSON 前缀,
  // 截断修复只按前缀解码,不会因为多这个成员而改变其它判定。
  const head = suppression ? `{${suppression}${text.slice(1, cut)}` : text.slice(0, cut);
  return `${head}${TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX}`;
}

/** 导入行与 live 落库同一上限:只有字符串 tool_result 会被截;其它 role 原样返回。 */
export function capImportedToolResultContent(role: string, content: unknown): unknown {
  if (role !== 'tool_result' || typeof content !== 'string') return content;
  return capToolResultTextForPersist(content);
}
