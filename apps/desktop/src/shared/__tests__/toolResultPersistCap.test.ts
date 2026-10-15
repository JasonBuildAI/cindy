import { describe, expect, it } from 'vitest';

import {
  extractPayloadToolResultFiles,
  parseToolResultPayload,
} from '@cindy/maker-shared/payload-summary';

import {
  TOOL_RESULT_PERSIST_CONTENT_LIMIT,
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
    expect(capped.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
    expect(capped.startsWith('aaa')).toBe(true);
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
  const plainCut = (text: string) =>
    `${text.slice(0, TOOL_RESULT_PERSIST_CONTENT_LIMIT - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length)}`
    + TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX;
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
    expect(capped).toBe(plainCut(declaredOnly));
    expect(extractPayloadToolResultFiles(capped)).toEqual([{ url: 'xdt-file:///tmp/report.pdf', title: 'report.pdf' }]);
  });

  it('does not read a mention inside a string value as a decision', () => {
    // 只有解析出来的决定才算数:字符串里的同名写法不是抑制。
    expect(capToolResultTextForPersist(mentionInsideValue)).toBe(plainCut(mentionInsideValue));
  });

  it('reserves the preserved head from the character budget', () => {
    // 提上来的成员算在同一个上限里,否则截断结果会超过上限、破坏幂等。
    const suppressed = JSON.stringify({ _xdt_render_image: false, log: 'q'.repeat(200) });
    const capped = capToolResultTextForPersist(suppressed, 80);
    expect(capped.startsWith('{"_xdt_render_image":false,')).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(80);
    expect(capToolResultTextForPersist(capped, 80)).toBe(capped);
    // 上限连后缀加抑制头都放不下时按原样截,不越界。
    const tight = capToolResultTextForPersist(suppressed, 50);
    expect(tight.length).toBeLessThanOrEqual(50);
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
});
