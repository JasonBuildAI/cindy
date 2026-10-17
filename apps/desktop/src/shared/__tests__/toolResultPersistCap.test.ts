import { describe, expect, it, vi } from 'vitest';

import {
  TOOL_RESULT_JSON_TRUNCATION_MARKER,
  extractPayloadToolResultFiles,
  parseToolResultPayload,
} from '@cindy/maker-shared/payload-summary';

import {
  TOOL_RESULT_PERSIST_CONTENT_LIMIT,
  TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX,
  TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX,
  capImportedToolResultContent,
  capToolResultTextForPersist,
} from '../toolResultPersistCap';

describe('capToolResultTextForPersist', () => {
  it('returns short text unchanged', () => {
    expect(capToolResultTextForPersist('hello')).toBe('hello');
    const exact = 'x'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capToolResultTextForPersist(exact)).toBe(exact);
  });

  it('caps oversized text to the limit with a truncation suffix', () => {
    const big = 'a'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT + 1);
    const capped = capToolResultTextForPersist(big);
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    // 纯文本正文(预筛没命中)只带中性标记:它不承诺正文形态,读取侧也不会拿它
    // 当可修复凭据(见工具文件头的「可修复凭据契约」)。
    expect(capped.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
    expect(capped.endsWith(TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX)).toBe(false);
    expect(capped.startsWith('aaa')).toBe(true);
  });

  it('keeps its credential bytes in sync with the reader', () => {
    // 读取侧只认这一串字节;两处常量分属两个包(worker 不引入 maker-shared),
    // 靠这条锁定,不能各自漂移。
    expect(TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX).toBe(TOOL_RESULT_JSON_TRUNCATION_MARKER);
    expect(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX).not.toBe(TOOL_RESULT_JSON_TRUNCATION_MARKER);
  });

  it('is idempotent', () => {
    const big = 'b'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 3);
    const once = capToolResultTextForPersist(big);
    expect(capToolResultTextForPersist(once)).toBe(once);
  });

  it('does not split a surrogate pair at the cut point', () => {
    const budget = TOOL_RESULT_PERSIST_CONTENT_LIMIT - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length;
    const text = `${'x'.repeat(budget - 1)}😀${'y'.repeat(2 * TOOL_RESULT_PERSIST_CONTENT_LIMIT)}`;
    const capped = capToolResultTextForPersist(text);
    const kept = capped.slice(0, capped.length - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length);
    const lastCode = kept.charCodeAt(kept.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    expect(kept).toBe('x'.repeat(budget - 1));
  });

  it('respects a custom limit', () => {
    const capped = capToolResultTextForPersist('c'.repeat(300), 100);
    expect(capped.length).toBeLessThanOrEqual(100);
    expect(capped.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
  });
});

describe('capImportedToolResultContent', () => {
  it('caps string tool_result and leaves other roles alone', () => {
    const huge = 'z'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 2);
    const capped = capImportedToolResultContent('tool_result', huge);
    expect(typeof capped).toBe('string');
    expect((capped as string).length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capImportedToolResultContent('assistant', huge)).toBe(huge);
    expect(capImportedToolResultContent('tool_result', { text: huge })).toEqual({ text: huge });
  });
});

describe('capToolResultTextForPersist suppression preservation', () => {
  const url = 'xdt-file:///tmp/suppressed.pdf';
  // 合法 JSON 文档被截断时带的是可修复凭据标记;带凭据才需要在读取侧修复,所以
  // 「正文一字不改」的对照也用这条标记切。
  const jsonCut = (text: string) =>
    `${text.slice(0, TOOL_RESULT_PERSIST_CONTENT_LIMIT - TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX.length)}`
    + TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX;
  // 生产者按 JSON.stringify 的成员顺序落库:抑制字段排在长字段之后时,8KB 切点
  // 落在 log 里,保留前缀本身看不到这个决定(评审 r4265638841)。
  const suppressedAfterCut = JSON.stringify({
    _xdt_model_files: [{ url }],
    log: 'x'.repeat(9000),
    _xdt_render_image: false,
  });
  const envelopeAfterCut = JSON.stringify({
    ok: true,
    result: { _xdt_model_files: [{ url }], log: 'y'.repeat(9000), _xdt_render_image: false },
  });
  const declaredOnly = JSON.stringify({
    _xdt_model_files: [{ url: 'xdt-file:///tmp/report.pdf' }],
    log: 'x'.repeat(9000),
  });
  const mentionInsideValue = JSON.stringify({
    note: 'pass "_xdt_render_image":false to suppress',
    log: 'z'.repeat(9000),
  });
  const longText = 'q'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 2);

  it('keeps a suppression decision serialized after the cut', () => {
    // 完整正文判为非投递;截断后必须还是非投递,否则重开会补出 live 没有的卡片。
    expect(extractPayloadToolResultFiles(suppressedAfterCut)).toEqual([]);
    const capped = capToolResultTextForPersist(suppressedAfterCut);
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capped.startsWith('{"_xdt_render_image":false,')).toBe(true);
    expect(extractPayloadToolResultFiles(capped)).toEqual([]);
    expect(capToolResultTextForPersist(capped)).toBe(capped);
  });

  it('keeps suppression declared inside the ok/result envelope', () => {
    expect(extractPayloadToolResultFiles(envelopeAfterCut)).toEqual([]);
    const capped = capToolResultTextForPersist(envelopeAfterCut);
    expect(capped.startsWith('{"_xdt_render_image":false,')).toBe(true);
    expect(extractPayloadToolResultFiles(capped)).toEqual([]);
  });

  it('leaves the cut untouched when the result is not suppressed', () => {
    const capped = capToolResultTextForPersist(declaredOnly);
    expect(capped).toBe(jsonCut(declaredOnly));
    expect(extractPayloadToolResultFiles(capped)).toEqual([{ url: 'xdt-file:///tmp/report.pdf', title: 'report.pdf' }]);
  });

  it('does not read a mention inside a string value as a decision', () => {
    // 只有解析出来的决定才算数:字符串里的同名写法不是抑制。
    expect(capToolResultTextForPersist(mentionInsideValue)).toBe(jsonCut(mentionInsideValue));
  });

  it('keeps suppression when the root object has leading JSON whitespace', () => {
    // JSON.parse 接受根 `{` 前的空白,截断修复也接受;读取侧同样会解析这份正文,
    // 所以保留抑制决定时同样要先跳过空白再定位根花括号(评审 r4279033446)。
    const full = '\n' + JSON.stringify({
      _xdt_model_files: [{ url }],
      log: 'x'.repeat(9000),
      _xdt_render_image: false,
    });
    expect(extractPayloadToolResultFiles(full)).toEqual([]);
    const capped = capToolResultTextForPersist(full);
    expect(capped.startsWith('\n{"_xdt_render_image":false,')).toBe(true);
    expect(extractPayloadToolResultFiles(capped)).toEqual([]);
  });

  it('replaces a preserved root-level render flag so the decision survives', () => {
    // 外层 true 被内层 false 覆盖(mergeToolResultPayload 的规则),但内层 false 落在
    // 切点之后;若把 false 插在原有 true 之前,重复键“后者覆盖前者”会让修复后的文档
    // 读回 true,重开又长出文件卡。提上来的决定必须摘掉根级同名成员(评审 r4279033455)。
    const full = JSON.stringify({
      _xdt_render_image: true,
      ok: true,
      result: { _xdt_model_files: [{ url }], log: 'y'.repeat(9000), _xdt_render_image: false },
    });
    expect(extractPayloadToolResultFiles(full)).toEqual([]);
    const capped = capToolResultTextForPersist(full);
    expect(capped.startsWith('{"_xdt_render_image":false,')).toBe(true);
    expect(capped.match(/_xdt_render_image/g)).toHaveLength(1);
    expect(extractPayloadToolResultFiles(capped)).toEqual([]);
    expect(capToolResultTextForPersist(capped)).toBe(capped);
  });

  it('replaces a trailing root-level render flag without leaving a dangling comma', () => {
    // 根级同名成员是最后一位时,摘掉它要吞掉前导逗号,修复前缀才是合法 JSON。
    const full = JSON.stringify({
      ok: true,
      result: { _xdt_model_files: [{ url: 'xdt-file:///tmp/report.pdf', name: 'Report' }] },
      log: 'z'.repeat(9000),
      _xdt_render_image: false,
    });
    const capped = capToolResultTextForPersist(full);
    expect(capped.startsWith('{"_xdt_render_image":false,"ok":true,')).toBe(true);
    expect(capped.match(/_xdt_render_image/g)).toHaveLength(1);
    expect(extractPayloadToolResultFiles(capped)).toEqual([]);
  });

  it('withholds the repairable marker from a non-JSON body', () => {
    // 可修复凭据契约(评审 r4337984066):完整正文不是合法 JSON 时,live 的
    // 判定是 [];截断结果若也带凭据,读取侧会把保留前缀修复成一份文档,
    // 复活 live 从未产出过的文件声明。中性标记不带凭据,读取侧按普通文本
    // 扫描,与 live 同结论。
    const broken = JSON.stringify({ _xdt_model_files: [{ url }], log: 'x'.repeat(9000) }) + ' BROKEN';
    expect(extractPayloadToolResultFiles(broken)).toEqual([]);
    const capped = capToolResultTextForPersist(broken);
    expect(capped.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
    expect(capped.endsWith(TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX)).toBe(false);
    expect(extractPayloadToolResultFiles(capped)).toEqual([]);
    // 合法 JSON 文档带凭据标记,截断读取走修复后的已解码判定。
    const document_ = JSON.stringify({ _xdt_model_files: [{ url }], log: 'x'.repeat(9000) });
    const kept = capToolResultTextForPersist(document_);
    expect(kept.endsWith(TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX)).toBe(true);
    expect(extractPayloadToolResultFiles(kept)).toEqual([{ url, title: 'suppressed.pdf' }]);
  });

  it('does not parse a capped body that cannot carry a delivery', () => {
    // 同步成本契约(评审 r4296349421):几十 MB 的日志/文本块在 Main 线程上不该被
    // JSON.parse 物化一次。预筛没命中就连解析都不做。
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const huge = JSON.stringify({ text: 'x'.repeat(4 * 1024 * 1024) });
      const capped = capToolResultTextForPersist(huge);
      expect(parse).not.toHaveBeenCalled();
      expect(capped.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
      // 同样的正文一旦可能产出投递,就必须走已解码判定(凭据才可信)。
      capToolResultTextForPersist(declaredOnly);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('removes every duplicate root-level control member', () => {
    // 重复键:JSON.parse 取后者,所以提上来的决定必须让所有同名成员都消失。
    // 只摘最后一段的话,更早那个仍会在新值之后覆盖回来(评审 r4296349410)。
    const renderFlags = '{"_xdt_render_image":true,"_xdt_model_files":[{"url":"' + url + '"}],"log":"'
      + 'x'.repeat(9000) + '","_xdt_render_image":false}';
    expect(extractPayloadToolResultFiles(renderFlags)).toEqual([]);
    const cappedFlags = capToolResultTextForPersist(renderFlags);
    expect(cappedFlags.match(/_xdt_render_image/g)).toHaveLength(1);
    expect(extractPayloadToolResultFiles(cappedFlags)).toEqual([]);
    // 根级文件声明重复时,生效值(最后一个,空数组)提到首位,所有旧声明摘净;
    // result 内层那份仍在,由根级空数组按合并规则压住。
    const declarations = '{"_xdt_model_files":[{"url":"xdt-file:///tmp/decoy.pdf"}],"ok":true,'
      + '"result":{"_xdt_model_files":[{"url":"' + url + '"}],"log":"' + 'y'.repeat(9000) + '"},"_xdt_model_files":[]}';
    expect(extractPayloadToolResultFiles(declarations)).toEqual([]);
    const cappedDeclarations = capToolResultTextForPersist(declarations);
    expect(cappedDeclarations.startsWith('{"_xdt_model_files":[],"ok":true,')).toBe(true);
    expect(cappedDeclarations).not.toContain('decoy.pdf');
    expect(extractPayloadToolResultFiles(cappedDeclarations)).toEqual([]);
    expect(capToolResultTextForPersist(cappedDeclarations)).toBe(cappedDeclarations);
  });

  it('preserves a root-level empty declaration that overrides the inner one', () => {
    // 外层覆盖重登记契约(评审 r4337984071):ok 信封里根级 _xdt_model_files:[]
    // 覆盖 result 的声明(合并取根级值);根级成员落在切点之后时,截断读取会把
    // 内层声明当成有效投递——那是 live 从未投递过的文件卡。空数组本身就是受
    // 合并逻辑支持的减法决定,不能因为尾部缺失就被解释成没有覆盖。
    const full = JSON.stringify({
      ok: true,
      result: { _xdt_model_files: [{ url }], log: 'y'.repeat(9000) },
      _xdt_model_files: [],
    });
    expect(extractPayloadToolResultFiles(full)).toEqual([]);
    const capped = capToolResultTextForPersist(full);
    expect(capped.startsWith('{"_xdt_model_files":[],"ok":true,')).toBe(true);
    expect(capped.match(/"_xdt_model_files"/g)).toHaveLength(2); // 根级一次 + result 内一次
    expect(extractPayloadToolResultFiles(capped)).toEqual([]);
    expect(capToolResultTextForPersist(capped)).toBe(capped);
  });

  it('re-registers an in-prefix root-level override instead of duplicating it', () => {
    // 根级成员就在保留前缀里时,重登记 = 摘掉旧位 + 插到首位,全文只出现一次。
    const full = JSON.stringify({
      _xdt_model_files: [],
      ok: true,
      result: { _xdt_model_files: [{ url }], log: 'y'.repeat(9000) },
    });
    expect(extractPayloadToolResultFiles(full)).toEqual([]);
    const capped = capToolResultTextForPersist(full);
    expect(capped.match(/"_xdt_model_files"/g)).toHaveLength(2);
    expect(extractPayloadToolResultFiles(capped)).toEqual([]);
  });

  it('preserves a non-empty root-level override the same way', () => {
    // 根级非空声明同样是覆盖决定:不重登记的话,截断会把 live 已覆盖掉的内层
    // 声明暴露出来——另一份 live 从未投递过的文件卡。
    const other = 'xdt-file:///tmp/other.pdf';
    const full = JSON.stringify({
      ok: true,
      result: { _xdt_model_files: [{ url: other }], log: 'y'.repeat(9000) },
      _xdt_model_files: [{ url, name: 'Report' }],
    });
    expect(extractPayloadToolResultFiles(full)).toEqual([{ url, title: 'Report' }]);
    const capped = capToolResultTextForPersist(full);
    expect(extractPayloadToolResultFiles(capped)).toEqual([{ url, title: 'Report' }]);
  });

  it('preserves a root-level empty media declaration that overrides the inner one', () => {
    // xdt_media_produced 与 _xdt_model_files 走同一条合并覆盖规则。
    const full = JSON.stringify({
      ok: true,
      result: { xdt_media_produced: [url], log: 'y'.repeat(9000) },
      xdt_media_produced: [],
    });
    expect(extractPayloadToolResultFiles(full)).toEqual([]);
    const capped = capToolResultTextForPersist(full);
    expect(extractPayloadToolResultFiles(capped)).toEqual([]);
  });

  it('reserves the preserved head from the character budget', () => {
    // 提上来的成员算在同一个上限里,否则截断结果会超过上限、破坏幂等。
    const suppressed = JSON.stringify({ _xdt_render_image: false, log: 'q'.repeat(200) });
    const capped = capToolResultTextForPersist(suppressed, 120);
    expect(capped.startsWith('{"_xdt_render_image":false,')).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(120);
    expect(capToolResultTextForPersist(capped, 120)).toBe(capped);
    // 上限连后缀加抑制头都放不下时按原样截,不越界(后缀本身仍要占满)。
    const tight = capToolResultTextForPersist(suppressed, TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX.length + 6);
    expect(tight.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_JSON_TRUNCATION_SUFFIX.length + 6);
    expect(tight.startsWith('{"_xdt_render_image":false,')).toBe(false);
  });

  it('decides exactly like the reader it mirrors', () => {
    // 与 parseToolResultPayload 的判定对齐(本模块不引入 maker-shared,靠这条锁定)。
    for (const source of [suppressedAfterCut, envelopeAfterCut, declaredOnly, mentionInsideValue, longText]) {
      const suppressed = parseToolResultPayload(source)?._xdt_render_image === false;
      expect(capToolResultTextForPersist(source).startsWith('{"_xdt_render_image":false,'))
        .toBe(suppressed);
    }
  });

  it('never invents a delivery at any cut point', () => {
    // 逐个切点扫一遍:截断后的读取只能是 live 投递的子集(切点吞掉的引用允许消失,
    // 物理上已不存在),绝不能多出 live 没有的文件卡;同时守住上限与幂等。
    const shapes = [
      suppressedAfterCut,
      envelopeAfterCut,
      declaredOnly,
      JSON.stringify({
        ok: true,
        result: { _xdt_model_files: [{ url }], log: 'l'.repeat(9000) },
        _xdt_model_files: [],
      }),
      '{"_xdt_render_image":true,"_xdt_model_files":[{"url":"' + url + '"}],"log":"'
        + 'm'.repeat(9000) + '","_xdt_render_image":false}',
      '{"_xdt_model_files":[{"url":"xdt-file:///tmp/decoy.pdf"}],"ok":true,'
        + '"result":{"_xdt_model_files":[{"url":"' + url + '"}],"log":"' + 'n'.repeat(9000) + '"},"_xdt_model_files":[]}',
    ];
    for (const source of shapes) {
      const live = extractPayloadToolResultFiles(source).map((file) => file.url);
      for (let limit = 200; limit <= TOOL_RESULT_PERSIST_CONTENT_LIMIT; limit += 89) {
        const capped = capToolResultTextForPersist(source, limit);
        expect(capped.length, `limit ${limit}`).toBeLessThanOrEqual(limit);
        expect(capToolResultTextForPersist(capped, limit), `limit ${limit}`).toBe(capped);
        for (const file of extractPayloadToolResultFiles(capped)) {
          expect(live, `limit ${limit} invented ${file.url}`).toContain(file.url);
        }
      }
    }
  });
});
