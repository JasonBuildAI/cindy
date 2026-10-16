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

/** 抑制决定提上来时占用的成员,插入根对象第一个成员的位置。 */
const SUPPRESSED_RENDER_KEY = '_xdt_render_image';
const SUPPRESSED_RENDER_HEAD = `"${SUPPRESSED_RENDER_KEY}":false,`;
const JSON_WHITESPACE = ' \t\n\r';
const JSON_VALUE_MAX_DEPTH = 256;

/** 首个非 JSON 空白字符的下标:JSON.parse 允许根 `{` 前带空白。 */
function leadingJsonWhitespaceEnd(text: string): number {
  let index = 0;
  while (index < text.length && JSON_WHITESPACE.includes(text[index])) index += 1;
  return index;
}

function skipJsonWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && JSON_WHITESPACE.includes(text[index])) index += 1;
  return index;
}

/** 已确认从 `"` 开始的 JSON 字符串的结束下标(独占),未闭合返回 null。 */
function skipJsonString(text: string, from: number): number | null {
  let index = from + 1;
  while (index < text.length) {
    if (text[index] === '\\') index += 2;
    else if (text[index] === '"') return index + 1;
    else index += 1;
  }
  return null;
}

/** 跳过一个完整 JSON 值,返回其结束下标;非法或不完整返回 null。 */
function skipJsonValue(text: string, from: number): number | null {
  const first = text[from];
  if (first === '"') return skipJsonString(text, from);
  if (first !== '{' && first !== '[') {
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(from));
    return literal ? from + literal[0].length : null;
  }
  const closers: string[] = [];
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = skipJsonString(text, index);
      if (end === null) return null;
      index = end;
      continue;
    }
    if (char === '{' || char === '[') {
      if (closers.length >= JSON_VALUE_MAX_DEPTH) return null;
      closers.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      if (closers.pop() !== char) return null;
      if (closers.length === 0) return index + 1;
    }
    index += 1;
  }
  return null;
}

/**
 * 根对象里已有的 `_xdt_render_image` 成员 [start, end)(含其后的成员分隔逗号),
 * 找不到返回 null。仅在 `JSON.parse(text)` 成功之后调用,故按合法 JSON 顶层成员
 * 扫描即可。用途见 capToolResultTextForPersist:根级同名值会以「后者覆盖前者」
 * 顶掉提上来的抑制决定,必须先摘掉,读取侧才会和 live 得出同一结论。
 */
function rootRenderImageMemberRange(text: string): { start: number; end: number } | null {
  const brace = leadingJsonWhitespaceEnd(text);
  if (text[brace] !== '{') return null;
  let index = brace + 1;
  let separator = -1; // 上一个成员后的逗号:摘掉末位成员时一并吞掉它。
  for (;;) {
    index = skipJsonWhitespace(text, index);
    if (text[index] === '}') return null;
    if (text[index] !== '"') return null;
    const keyStart = index;
    const keyEnd = skipJsonString(text, index);
    if (keyEnd === null) return null;
    index = skipJsonWhitespace(text, keyEnd);
    if (text[index] !== ':') return null;
    index = skipJsonWhitespace(text, index + 1);
    const valueEnd = skipJsonValue(text, index);
    if (valueEnd === null) return null;
    if (text.slice(keyStart, keyEnd) === `"${SUPPRESSED_RENDER_KEY}"`) {
      const after = skipJsonWhitespace(text, valueEnd);
      return text[after] === ','
        ? { start: keyStart, end: after + 1 } // 有后继成员:连带尾逗号一起摘。
        : { start: separator === -1 ? keyStart : separator, end: valueEnd }; // 末位成员:吞掉前导逗号。
    }
    index = skipJsonWhitespace(text, valueEnd);
    if (text[index] !== ',') return null;
    separator = index;
    index += 1;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

type SuppressionPlan = {
  /** 根 `{` 的下标(空白之后)。 */
  brace: number;
  /** 要提到根对象第一个成员位置的抑制头(含尾逗号)。 */
  head: string;
  /** 需要摘掉的根级 `_xdt_render_image` 成员范围(含其后的成员分隔逗号)。 */
  removal: { start: number; end: number } | null;
};

/**
 * 保留前缀要带上的抑制决定:正文是 JSON 对象、且它自身的判定是"不渲染"时返回
 * 抑制头与需摘掉的同名根成员,否则返回 null。
 *
 * 这里刻意不引入 @cindy/maker-shared/payload-summary 的 parseToolResultPayload:
 * 本模块被 DB worker 打包,而 worker 目前只做类型级引用,不拖整包进来。判定规则
 * 与该函数保持一致(外层 `_xdt_render_image:false`,以及 `ok:true` 信封里
 * `result` 上的同一个字段,内层 false 覆盖外层 true),由
 * toolResultPersistCap.test.ts 对照锁定。
 *
 * 根级已有的同名成员必须摘掉:JSON.parse 对重复键取后者,若把 false 插在原有的
 * true 之前,修复后的文档会读成「未抑制」,重开又长出 live 从未投递的文件卡。
 */
function suppressionPlanFor(text: string, limit: number): SuppressionPlan | null {
  if (limit < TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length + SUPPRESSED_RENDER_HEAD.length) return null;
  // 便宜的前置筛:正文压根没提这个字段就别解析(MB 级 tool_result 很常见)。
  if (!text.includes(SUPPRESSED_RENDER_KEY)) return null;
  // JSON.parse 接受根 `{` 前的空白,定位真正的根花括号再判形态。
  const brace = leadingJsonWhitespaceEnd(text);
  if (text[brace] !== '{') return null;
  try {
    const outer = readRecord(JSON.parse(text));
    if (!outer) return null;
    const inner = outer.ok === true ? readRecord(outer.result) : null;
    const suppressed = outer[SUPPRESSED_RENDER_KEY] === false
      || inner?.[SUPPRESSED_RENDER_KEY] === false;
    if (!suppressed) return null;
    return { brace, head: SUPPRESSED_RENDER_HEAD, removal: rootRenderImageMemberRange(text) };
  } catch {
    // 不是 JSON(或半截 JSON)就没有可保留的已解码判定。
    return null;
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
  const plan = suppressionPlanFor(text, limit);
  const head = plan?.head ?? '';
  let cut = Math.max(0, limit - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length - head.length);
  const lastKept = text.charCodeAt(cut - 1);
  if (cut > 0 && lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1;
  let retained = text.slice(0, cut);
  // 抑制头插在根对象的左花括号之后(含根花括号前的空白):保留下来的仍是同一份
  // 文档的 JSON 前缀,截断修复只按前缀解码,不会因为多这个成员而改变其它判定。
  if (plan && cut > plan.brace + 1) {
    const removal = plan.removal;
    let body = retained;
    if (removal && removal.start < body.length) {
      body = body.slice(0, removal.start) + body.slice(Math.min(removal.end, body.length));
    }
    retained = `${text.slice(0, plan.brace + 1)}${head}${body.slice(plan.brace + 1)}`;
  }
  return `${retained}${TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX}`;
}

/** 导入行与 live 落库同一上限:只有字符串 tool_result 会被截;其它 role 原样返回。 */
export function capImportedToolResultContent(role: string, content: unknown): unknown {
  if (role !== 'tool_result' || typeof content !== 'string') return content;
  return capToolResultTextForPersist(content);
}
