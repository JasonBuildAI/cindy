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
 * 可修复凭据契约(评审 r4337984066、r4296349399):读取侧
 * (payloadSummary 的 salvageTruncatedJsonPrefix)修复保留前缀的唯一凭据是「正文
 * 是被截断的**合法 JSON 文档**」。这个事实只有写过完整正文的一方知道,所以凭据必须
 * 由能验证它的生产者发出:只有 JSON.parse 成功才写带凭据的标记;否则写中性标记
 * (与旧版本逐字节相同)。旧版本对任意超限文本都写中性标记、device-link 的两种上限
 * 截断的也是未校验的字符串,因此读取侧不认它们——认了就会修复出 live 从未产出过的
 * 文档,Mobile/历史页长出虚假 FileChip。
 *
 * 同步成本契约(评审 r4296349421):这条路径在 Main 线程同步跑,几十 MB 的正文
 * 不能无条件 JSON.parse。先做不分配的廉价预筛:只有可能产出投递(文件 URL)或携带
 * 控制位的正文才需要已解码判定,其余超限正文(日志、文本块)直接按原样截断。
 *
 * 外层覆盖重登记契约(评审 r4337984071):ok:true 信封的合并规则是「根级值覆盖
 * result 内层值」(mergeToolResultPayload 的 {...inner, ...outer})。根级的
 * `_xdt_model_files` / `xdt_media_produced` 落在切点之后时,截断读取会把内层
 * 声明当成有效投递——同样是 live 从未投递过的文件卡(根级空数组尤其是受合并
 * 逻辑支持的减法决定)。截断前把根级成员按原字节提到根对象第一个成员的位置,
 * 与抑制位同一条规则。
 *
 * 纯函数、无依赖:main 侧 broadcaster、Claude 导入准备层与 DB worker importer
 * (tx.ts / inline worker fallback)共用同一份,保证所有写入口一个口径。
 * 导入路径的媒体挂账在 main 侧对原文执行(worker 碰不到 cindy-media ledger)。
 */

export const TOOL_RESULT_PERSIST_CONTENT_LIMIT = 8 * 1024;

/**
 * 中性截断提示:不附带任何关于正文形态的断言,与旧版本写下的标记逐字节相同。
 * 旧版本对**任意**超限文本都写它,所以读取侧不把它当作可修复凭据(见文件头
 * 「可修复凭据契约」);这一条也可能属于「预筛没命中、来不及验证」的正文。
 */
export const TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX =
  '\n\n[tool result truncated: stored first 8KB]';

/**
 * 带可修复凭据的截断提示:只有完整正文通过 JSON.parse 才写这一条,读取侧只认它。
 * 与中性标记的字节必须不同,否则凭据无法区分。
 */
export const TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX =
  '\n\n[tool result truncated: stored first 8KB; complete result was JSON]';

/**
 * 廉价预筛:只有出现这些字面量的正文才可能产出文件投递,或被控制位改变投递结论。
 * 没命中的超限正文(日志、纯文本块)不需要任何已解码判定,连 JSON.parse 都不该做。
 *
 * 一次正则扫描而不是逐个 includes:5.9MB 的结构化 JSON 上,JSON.parse 约 46ms
 * 且要把整棵对象物化,单趟正则约 1.2ms(逐个 includes 反而要扫 5 遍)。
 */
const DELIVERY_TOKENS_RE =
  /xdt-file:\/\/|cindy-media:\/\/blobs\/|_xdt_model_files|xdt_media_produced|_xdt_render_image/;

/** 抑制决定提上来时占用的成员,插入根对象第一个成员的位置。 */
const SUPPRESSED_RENDER_KEY = '_xdt_render_image';
const SUPPRESSED_RENDER_HEAD = `"${SUPPRESSED_RENDER_KEY}":false,`;
/**
 * 受「根级覆盖内层」合并规则保护的文件声明键:根级与 result 内层同键时,
 * 读取侧取根级值。根级成员落在切点之后会让截断读取改口供认内层声明。
 */
const FILE_DECLARATION_KEYS = ['_xdt_model_files', 'xdt_media_produced'] as const;
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

/** 根对象顶层成员的区间。 */
type RootMemberRange = {
  /** 键的开引号位置:重登记按原字节切片用。 */
  keyStart: number;
  /**
   * 摘除区间 [start, end):有后继成员时从键开始、连带尾逗号;末位成员时吞掉
   * 前导逗号(首个成员则从键开始)——摘掉后剩下的仍是合法 JSON。
   */
  start: number;
  end: number;
  /** 值终点(独占):重登记按原字节切片用(不含尾逗号)。 */
  valueEnd: number;
};

/**
 * 根对象里若干顶层成员**全部**出现的区间(一次扫描,只为真正关心的键收集)。仅在
 * `JSON.parse(text)` 成功之后调用,故按合法 JSON 顶层成员扫描即可。
 *
 * 为什么不是「只要最后一个」:JSON.parse 对重复键取后者,所以最后一个出现才是
 * 生效值;但更早的同名成员仍留在正文里。若只摘掉最后一个,把新决定插到根对象
 * 开头,修复后的文档会按「后者覆盖前者」读回更早那个旧值,决定又被顶回去
 * (评审 r4296349410)。因此生效值取最后一段、移除区间取全部出现。
 *
 * 一次扫描收全部键:逐个键各扫一遍会让 MB 级正文多走几趟完整遍历。
 */
function rootMemberRangesByKey(
  text: string,
  keys: readonly string[],
): Map<string, RootMemberRange[]> {
  const rangesByKey = new Map<string, RootMemberRange[]>();
  const brace = leadingJsonWhitespaceEnd(text);
  if (text[brace] !== '{') return rangesByKey;
  const wanted = new Set(keys.map((key) => `"${key}"`));
  let index = brace + 1;
  let separator = -1; // 上一个成员后的逗号:摘掉末位成员时一并吞掉它。
  for (;;) {
    index = skipJsonWhitespace(text, index);
    if (index >= text.length || text[index] === '}') return rangesByKey;
    if (text[index] !== '"') return rangesByKey;
    const keyStart = index;
    const keyEnd = skipJsonString(text, index);
    if (keyEnd === null) return rangesByKey;
    index = skipJsonWhitespace(text, keyEnd);
    if (text[index] !== ':') return rangesByKey;
    index = skipJsonWhitespace(text, index + 1);
    const valueEnd = skipJsonValue(text, index);
    if (valueEnd === null) return rangesByKey;
    const literal = text.slice(keyStart, keyEnd);
    if (wanted.has(literal)) {
      const ranges = rangesByKey.get(literal) ?? [];
      const after = skipJsonWhitespace(text, valueEnd);
      if (text[after] === ',') {
        // 有后继成员:连带尾逗号一起摘。
        ranges.push({ keyStart, start: keyStart, end: after + 1, valueEnd });
      } else {
        // 末位成员:吞掉前导逗号;后面只可能是 `}`,可以直接收尾。
        ranges.push({ keyStart, start: separator === -1 ? keyStart : separator, end: valueEnd, valueEnd });
        rangesByKey.set(literal, ranges);
        return rangesByKey;
      }
      rangesByKey.set(literal, ranges);
    }
    index = skipJsonWhitespace(text, valueEnd);
    if (text[index] !== ',') return rangesByKey;
    separator = index;
    index += 1;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * 摘掉若干成员区间。区间可能重叠或相邻:被摘成员的尾逗号可能正是下一个被摘成员
 * 的前导逗号(重复键紧挨着时),所以先合并重叠区间再一次性拼接,不能按原下标
 * 逐个 slice(前一次摘除会让后一次的下标错位)。
 */
function removeRanges(text: string, ranges: readonly RootMemberRange[]): string {
  const spans = ranges
    .filter((range) => range.start < text.length)
    .map((range) => [range.start, Math.min(range.end, text.length)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let body = text;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const [start, end] = merged[index];
    body = body.slice(0, start) + body.slice(end);
  }
  return body;
}

/** 要提到根对象第一个成员位置的重登记成员。 */
type HoistedMember = {
  /** 插入根 `{` 之后的成员文本(含尾逗号)。 */
  head: string;
  /** 根级同名成员的既有区间:插入前全部摘掉,避免重复键把决定顶回来。 */
  removals: readonly RootMemberRange[];
};

type SuppressionPlan = {
  /** 根 `{` 的下标(空白之后)。 */
  brace: number;
  /** 按插入顺序排列的重登记成员。 */
  members: HoistedMember[];
};

/**
 * 保留前缀要带上的重登记成员:正文是 JSON 对象、且存在「落在切点之后就再也
 * 无法从保留前缀反推」的根级决定时返回插入计划,否则返回 null。
 *
 * 这里刻意不引入 @cindy/maker-shared/payload-summary 的 parseToolResultPayload:
 * 本模块被 DB worker 打包,而 worker 目前只做类型级引用,不拖整包进来。判定规则
 * 与该函数保持一致(外层 `_xdt_render_image:false`、`ok:true` 信封里 `result`
 * 上的同一个字段内层 false 覆盖外层 true,以及根级文件声明覆盖内层声明),
 * 由 toolResultPersistCap.test.ts 对照锁定。
 *
 * 根级已有的同名成员必须全部摘掉:JSON.parse 对重复键取后者,若把新值插在原有的
 * 旧值之前,修复后的文档会读回旧值,重开又长出 live 从未投递的文件卡;重复键的
 * 更早几次出现同样必须摘掉,否则它们仍会在新值之后覆盖回来。
 *
 * @param parsed 完整正文的 JSON.parse 结果(调用方已确认解析成功)
 * @param suffixLength 本次截断将使用的标记长度,用于预算校验
 */
function suppressionPlanFor(
  text: string,
  limit: number,
  parsed: unknown,
  suffixLength: number,
): SuppressionPlan | null {
  // JSON.parse 接受根 `{` 前的空白,定位真正的根花括号再判形态。
  const brace = leadingJsonWhitespaceEnd(text);
  if (text[brace] !== '{') return null;
  const outer = readRecord(parsed);
  if (!outer) return null;
  const inner = outer.ok === true ? readRecord(outer.result) : null;

  const members: HoistedMember[] = [];
  // 一次扫描定位所有根级同名字段:抑制位与两条文件声明共用同一趟遍历。
  const rangesByKey = rootMemberRangesByKey(text, [SUPPRESSED_RENDER_KEY, ...FILE_DECLARATION_KEYS]);
  // ① 抑制决定:外层 false,或 ok 信封内层 false(内层 false 覆盖外层 true,
  // 见 mergeToolResultPayload 末尾对 _xdt_render_image 的重断言)。
  if (outer[SUPPRESSED_RENDER_KEY] === false || inner?.[SUPPRESSED_RENDER_KEY] === false) {
    members.push({
      head: SUPPRESSED_RENDER_HEAD,
      removals: rangesByKey.get(`"${SUPPRESSED_RENDER_KEY}"`) ?? [],
    });
  }
  // ② 外层文件声明覆盖:根级与 result 内层同键时,合并取根级值;根级成员落在
  // 切点之后,截断读取会把内层声明当成有效投递(根级空数组即"无文件"的减法
  // 决定,同样不能因为尾部缺失就被解释成没有覆盖)。
  if (inner) {
    for (const key of FILE_DECLARATION_KEYS) {
      if (!(key in outer) || !(key in inner)) continue;
      const ranges = rangesByKey.get(`"${key}"`) ?? [];
      const effective = ranges[ranges.length - 1];
      if (!effective) continue;
      members.push({
        head: `${text.slice(effective.keyStart, effective.valueEnd)},`,
        removals: ranges,
      });
    }
  }
  if (members.length === 0) return null;
  const headsLength = members.reduce((total, member) => total + member.head.length, 0);
  if (limit < suffixLength + headsLength) return null;
  return { brace, members };
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
  // 廉价预筛先跑:只有可能产出投递、或携带控制位的正文才需要已解码判定;其余
  // (日志、纯文本块,几十 MB 的也常见)不该在 Main 线程上被 JSON.parse 物化一次
  // (见文件头「同步成本契约」)。预筛没命中就没有决定可读,也不带可修复凭据。
  let parsed: unknown;
  let jsonDocument = false;
  if (DELIVERY_TOKENS_RE.test(text)) {
    try {
      parsed = JSON.parse(text);
      jsonDocument = true;
    } catch {
      // 非 JSON 正文:没有可解码的判定,也不带可修复凭据。
    }
  }
  const suffix = jsonDocument
    ? TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX
    : TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX;
  const plan = jsonDocument ? suppressionPlanFor(text, limit, parsed, suffix.length) : null;
  const heads = plan ? plan.members.map((member) => member.head).join('') : '';
  let cut = Math.max(0, limit - suffix.length - heads.length);
  const lastKept = text.charCodeAt(cut - 1);
  if (cut > 0 && lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1;
  const retained = text.slice(0, cut);
  // 重登记成员插在根对象的左花括号之后(含根花括号前的空白):保留下来的仍是同一份
  // 文档的 JSON 前缀,截断修复只按前缀解码,不会因为多这些成员而改变其它判定。
  if (plan && heads.length > 0 && cut > plan.brace + 1) {
    const body = removeRanges(retained, plan.members.flatMap((member) => member.removals));
    return `${text.slice(0, plan.brace + 1)}${heads}${body.slice(plan.brace + 1)}${suffix}`;
  }
  return `${retained}${suffix}`;
}

/** 导入行与 live 落库同一上限:只有字符串 tool_result 会被截;其它 role 原样返回。 */
export function capImportedToolResultContent(role: string, content: unknown): unknown {
  if (role !== 'tool_result' || typeof content !== 'string') return content;
  return capToolResultTextForPersist(content);
}
