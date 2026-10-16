import { describe, it, expect } from 'vitest';
import { extractPayloadToolResultMedia as media, extractPayloadToolResultFiles as files, extractPayloadToolCardIds as cards } from '../payloadSummary.js';
import { hasVisibleHistoryResult } from '../historyViewProjection.js';
const blob = (ext: string) => `cindy-media://blobs/${'a'.repeat(64)}.${ext}`;

describe('portable plugin results', () => {
  it.each(["'", '"'])('recognizes triple-quoted source strings using %s', (quote) => {
    const delimiter = quote.repeat(3);
    const url = 'xdt-file:///tmp/triple.pdf';
    for (const body of [url, 'Open\n' + quote + 'example' + quote.repeat(2) + '\n' + url,
      'Escaped ' + '\\' + delimiter + ' Open ' + url]) {
      for (const prefix of ['', 'r', 'f']) {
        const literal = prefix + delimiter + body + delimiter;
        for (const source of ['path = ' + literal, 'path = "prefix" + ' + literal + ' + "suffix"']) {
          expect(files(source), source).toEqual([]);
          expect(files(JSON.stringify({ text: source })), source).toEqual([]);
          expect(files(source + '\nSaved "' + url + '"')).toEqual([{ url, title: 'triple.pdf' }]);
          expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Triple' }] })))
            .toEqual([{ url, title: 'Triple' }]);
        }
        expect(files('path = ' + prefix + delimiter + body)).toEqual([]);
      }
    }
  });
  it('preserves hash-prefixed Markdown deliveries and hashes in legacy file names', () => {
    const url = 'xdt-file:///tmp/report#final.pdf';
    for (const text of ['# fixture: ' + url, '## Report: ' + url, '# [report](' + url + ')']) {
      expect(files(text)).toEqual([{ url, title: 'report#final.pdf' }]);
      expect(files(JSON.stringify({ text }))).toEqual([{ url, title: 'report#final.pdf' }]);
    }
  });
  it.each(["'", '"', String.fromCharCode(96)])('keeps concatenated source literals out of delivered files: %s', (quote) => {
    const url = 'xdt-file:///tmp/concatenated.pdf';
    const literal = quote + url + quote;
    for (const source of [
      'const path = "prefix" + ' + literal,
      'const path = "prefix" + /* continuation */\n  ' + literal,
      'return "prefix" + " middle " + ' + literal,
      'const path = "prefix"+' + quote + 'Open ' + url + quote,
    ]) {
      expect(files(source), source).toEqual([]);
      expect(files(JSON.stringify({ text: source })), source).toEqual([]);
      expect(files(source + '\nSaved ' + literal)).toEqual([{ url, title: 'concatenated.pdf' }]);
      expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Concatenated' }] })))
        .toEqual([{ url, title: 'Concatenated' }]);
    }
    const next = 'xdt-file:///tmp/next.pdf';
    expect(files('Saved ' + literal + ' + ' + quote + next + quote)).toEqual([
      { url, title: 'concatenated.pdf' }, { url: next, title: 'next.pdf' },
    ]);
    expect(files('Saved "prefix" + ' + literal)).toEqual([{ url, title: 'concatenated.pdf' }]);
  });
  it.each(['r', 'R', 'f', 'F', 'b', 'u', 'br', 'rb', 'fr', 'rf', '@', '$', '@$', '$@'])('recognizes source literals with prefix %s', (prefix) => {
    const url = 'xdt-file:///tmp/prefixed.pdf';
    for (const quote of (prefix.includes('@') || prefix.includes('$') ? ['"'] : ["'", '"'])) {
      for (const content of [url, 'Open ' + url]) {
        const literal = prefix + quote + content + quote;
        for (const source of ['path = ' + literal, 'return ' + literal, 'open(' + literal + ')', 'paths = [' + literal + ']', 'path = "prefix" + ' + literal]) {
          expect(files(source), source).toEqual([]);
          expect(files(JSON.stringify({ text: source })), source).toEqual([]);
          expect(files(source + '\nSaved "' + url + '"')).toEqual([{ url, title: 'prefixed.pdf' }]);
          expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Prefixed' }] })))
            .toEqual([{ url, title: 'Prefixed' }]);
        }
      }
    }
    // A language prefix alone must not turn ordinary output into source code.
    expect(files('Saved ' + prefix + '"' + url + '"')).toEqual([{ url, title: 'prefixed.pdf' }]);
  });
  it.each([
    '// fixture: xdt-file:///tmp/example.pdf',
    'const enabled = true; // fixture: xdt-file:///tmp/example.pdf',
    '/* fixture: xdt-file:///tmp/example.pdf */',
    '/* example\n * xdt-file:///tmp/example.pdf\n */',
    '// fixture: "xdt-file:///tmp/example.pdf"',
  ])('does not extract file deliveries from source comments: %s', (source) => {
    const url = 'xdt-file:///tmp/actual.pdf';
    expect(files(source)).toEqual([]);
    expect(files(JSON.stringify({ text: source }))).toEqual([]);
    expect(files(source + '\nSaved [report](' + url + ')')).toEqual([{ url, title: 'actual.pdf' }]);
    expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Actual' }] })))
      .toEqual([{ url, title: 'Actual' }]);
  });
  it.each(['xdt-file:///tmp/a//report.pdf', 'xdt-file:///tmp/a/*report.pdf'])('does not treat URL path characters as comments: %s', (url) => {
    const next = 'xdt-file:///tmp/next.pdf';
    const expected = [{ url, title: url.split('/').pop() }, { url: next, title: 'next.pdf' }];
    expect(files('Saved ' + url + ' and ' + next)).toEqual(expected);
    expect(files('[first](' + url + ') [next](' + next + ')')).toEqual(expected);
    expect(files(JSON.stringify({ text: 'Saved ' + url + ' and ' + next }))).toEqual(expected);
  });
  it.each(["'", '"', String.fromCharCode(96)])('recognizes arrow-function source literals quoted with %s', (quote) => {
    const url = 'xdt-file:///tmp/callback.pdf';
    for (const content of [url, 'Open ' + url]) {
      const literal = quote + content + quote;
      for (const source of [
        'const paths = names.map(() => ' + literal + ')',
        'const path = () => ' + literal,
        'const path = async () => /* example */\n  ' + literal,
      ]) {
        expect(files(source), source).toEqual([]);
        expect(files(JSON.stringify({ text: source })), source).toEqual([]);
        expect(files(source + '\nSaved "' + url + '"')).toEqual([{ url, title: 'callback.pdf' }]);
        expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Callback' }] })))
          .toEqual([{ url, title: 'Callback' }]);
      }
    }
    // A Markdown quote marker alone is not the arrow operator.
    expect(files('> ' + quote + url + quote)).toEqual([{ url, title: 'callback.pdf' }]);
  });
  it.each(["'", '"', String.fromCharCode(96)])('handles long escaped source literals ending in a backslash: %s', (quote) => {
    const source = 'const message = ' + quote + ('\\' + quote).repeat(5000)
      + ' Open xdt-file:///tmp/fixture.pdf' + '\\';
    expect(files(source)).toEqual([]);
    expect(files(JSON.stringify({ text: source }))).toEqual([]);
  });
  it('handles repeated unterminated block-comment openers without hiding earlier real files', () => {
    const url = 'xdt-file:///tmp/report.pdf';
    const source = 'Saved [report](' + url + ')\n/*' + 'a/*'.repeat(5000);
    expect(files(source)).toEqual([{ url, title: 'report.pdf' }]);
  });
  it.each(["'", '"', String.fromCharCode(96)])('ignores URLs anywhere inside source literals quoted with %s', (quote) => {
    const url = 'xdt-file:///tmp/fixture.pdf';
    const body = 'Open ' + url + ' or [report](xdt-file://open?path=%2Ftmp%2Fother.pdf)';
    const literal = quote + body + quote;
    for (const source of [
      'const message = ' + literal,
      'return ' + literal,
      'notify(' + literal + ')',
      'const messages = [' + literal + ', /* next */ ' + literal + ']',
      'const message = { text: ' + literal + ' }',
      'const message = enabled ? ' + literal + ' : undefined',
      'const message = fallback || ' + literal,
      'const message = ' + quote + 'Open \\' + quote + 'report\\' + quote + ' at ' + url + quote,
    ]) {
      expect(files(source), source).toEqual([]);
      expect(files(JSON.stringify({ content: [{ type: 'text', text: source }] })), source).toEqual([]);
      expect(files(source + '\nSaved [report](' + url + ')'), source).toEqual([{ url, title: 'fixture.pdf' }]);
      expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Report' }] }))).toEqual([{ url, title: 'Report' }]);
    }
  });
  it('keeps URLs in quoted prose and does not inherit source context from a previous statement', () => {
    const a = 'xdt-file:///tmp/first.pdf';
    const b = 'xdt-file:///tmp/second.pdf';
    const expected = [{ url: a, title: 'first.pdf' }, { url: b, title: 'second.pdf' }];
    for (const quote of ["'", '"', String.fromCharCode(96)]) {
      const prose = 'Saved ' + quote + 'first [file](' + a + ')' + quote + ', ' + quote + 'second [file](' + b + ')' + quote;
      expect(files(prose)).toEqual(expected);
      expect(files('const label = "example";\n' + prose)).toEqual(expected);
      expect(files(JSON.stringify({ note: prose }))).toEqual(expected);
    }
    expect(files('Saved "Open ' + a + '", "Open ' + b + '"')).toEqual(expected);
  });
  it('filters multiple URLs in a multiline source template', () => {
    const source = 'const message = ' + String.fromCharCode(96)
      + 'Open\nxdt-file:///tmp/first.pdf\nand xdt-file:///tmp/second.pdf\n'
      + String.fromCharCode(96);
    expect(files(source)).toEqual([]);
  });
  it('preserves the legacy direct-path punctuation alphabet in real references', () => {
    // #4692 accepted these filename characters. Source filtering must not
    // redefine the URL alphabet and silently point to a different file.
    for (const punctuation of "!#$%&'(*+,-.:;=?@[]^_{}~" + String.fromCharCode(96)) {
      const title = 'report' + punctuation + 'final.pdf';
      const url = 'xdt-file:///tmp/' + title;
      const expected = [{ url, title }];
      expect(files('[report](' + url + ')'), title).toEqual(expected);
      expect(files(JSON.stringify({ note: url })), title).toEqual(expected);
      expect(files(JSON.stringify([url])), title).toEqual(expected);
      expect(files(JSON.stringify({ _xdt_model_files: [{ url, name: title }] })), title).toEqual(expected);
    }
  });
  it('reads host ledger images, video and audio and deduplicates declarations', () => {
    const result = JSON.stringify({ xdt_image_urls: [blob('png')], xdt_media_produced: [blob('png'), blob('mp4'), blob('mp3'), blob('glb'), 'file:///secret.png', 'https://external/p.png', 'cindy-media://other/p.png'] });
    expect(media(result).map(({ kind, url }) => [kind, url])).toEqual([['image', blob('png')], ['video', blob('mp4')], ['audio', blob('mp3')]]);
    expect(files(result)).toEqual([{ url: blob('glb'), title: `${'a'.repeat(64)}.glb` }]);
    expect(hasVisibleHistoryResult(result)).toBe(true);
  });
  it('reads the old ghost envelope, including singular fields and card anchors', () => {
    const result = JSON.stringify({ ok: true, result: { xdt_image_url: blob('png'), xdt_video_url: blob('mp4'), xdt_card_id: 'c', xdt_anchor_card_id: 'c' } });
    expect(media(result).map((m) => m.kind)).toEqual(['image', 'video']);
    expect(cards(result)).toEqual(['c']);
    expect(media(JSON.stringify({ arbitrary: { xdt_image_url: blob('png') } }))).toEqual([]);
  });
  it('respects suppression in either envelope and never revives failed nested results', () => {
    for (const result of [
      { ok: true, _xdt_render_image: false, result: { xdt_image_url: blob('png') } },
      { ok: true, result: { _xdt_render_image: false }, xdt_media_produced: [blob('png')] },
      { ok: false, result: { xdt_image_url: blob('png') } },
    ]) expect(media(JSON.stringify(result))).toEqual([]);
  });
  it('retains managed file and model entries without inventing arbitrary local-path access', () => {
    const result = JSON.stringify({ ok: true, result: { _xdt_model_files: [{ url: blob('glb'), name: 'scene.glb' }, { url: 'file:///secret' }], note: 'Saved xdt-file://open?path=%2Ftmp%2Freport.pdf' } });
    expect(files(result)).toEqual([{ url: blob('glb'), title: 'scene.glb' }, { url: 'xdt-file://open?path=%2Ftmp%2Freport.pdf', title: 'report.pdf' }]);
    expect(files('Saved xdt-file://open?path=%2Ftmp%2Freport.pdf')[0].title).toBe('report.pdf');
    expect(hasVisibleHistoryResult(JSON.stringify({ ok: true, result: { xdt_card_id: 'c' } }))).toBe(true);
  });
  it('ignores quoted protocol URLs when a tool prints source code or test fixtures', () => {
    const source = [
      "const urls = ['xdt-file://open?path=%2Ftmp%2Freport.pdf', 'xdt-file://open?path=%2Ftmp%2Findex.html'];",
      "const template = `xdt-file://open?path=${encodeURIComponent(absPath)}`;",
    ].join('\n');
    expect(files(source)).toEqual([]);
    expect(files('Saved xdt-file://open?path=%2Ftmp%2Freport.pdf')).toEqual([
      { url: 'xdt-file://open?path=%2Ftmp%2Freport.pdf', title: 'report.pdf' },
    ]);
  });
  it.each([
    ['xdt-file:///tmp/report.pdf', 'report.pdf'],
    ['xdt-file:///C:/reports/report.pdf', 'report.pdf'],
    ['xdt-file:///tmp/report%20final.pdf', 'report final.pdf'],
    ['xdt-file://open?path=%2Ftmp%2Freport.pdf', 'report.pdf'],
    ['xdt-file://local/?path=C%3A%5Creports%5Creport.pdf', 'report.pdf'],
  ])('retains absolute file references in both supported URL forms: %s', (url, title) => {
    expect(files(`Saved [report](${url})`)).toEqual([{ url, title }]);
    expect(files(JSON.stringify({ _xdt_model_files: [{ url, name: title }] }))).toEqual([{ url, title }]);
    expect(files(JSON.stringify({ xdt_media_produced: [url] }))).toEqual([{ url, title }]);
  });
  it.each([
    ['xdt-file:///tmp/report100%.pdf', 'report100%.pdf'],
    ['xdt-file:///C:/reports/report100%.pdf', 'report100%.pdf'],
    ['xdt-file:///tmp/report%ZZ.pdf', 'report%ZZ.pdf'],
    ['xdt-file:///tmp/report%2', 'report%2'],
    ['xdt-file:///tmp/report%FF.pdf', 'report%FF.pdf'],
    ['xdt-file:///tmp/report%20at100%25.pdf', 'report at100%.pdf'],
    ['xdt-file:///tmp/report%2520.pdf', 'report%20.pdf'],
    ['xdt-file://open?path=%2Ftmp%2Freport100%25.pdf', 'report100%.pdf'],
  ])('retains percent file names and decodes valid escapes once: %s', (url, title) => {
    const expected = [{ url, title }];
    expect(files('[report](' + url + ')')).toEqual(expected);
    expect(files(JSON.stringify({ note: url }))).toEqual(expected);
    expect(files(JSON.stringify({ _xdt_model_files: [{ url }] }))).toEqual(expected);
    expect(files('const path = "' + url + '";')).toEqual([]);
  });
  it.each(['note', 'text', 'output'])('ignores source literals inside JSON %s while retaining real links', (field) => {
    const source = [
      "const a = 'xdt-file://open?path=%2Ftmp%2Ffixture.pdf';",
      'const b = "xdt-file:///tmp/fixture.html";',
      'const c = `xdt-file://open?path=${encodeURIComponent(absPath)}`;',
    ].join('\n');
    const url = 'xdt-file://open?path=%2Ftmp%2Factual.pdf';
    for (const wrap of [
      (text: string) => ({ [field]: text }),
      (text: string) => ({ ok: true, result: { [field]: text } }),
      (text: string) => ({ content: [{ type: 'text', text }] }),
    ]) {
      expect(files(JSON.stringify(wrap(source)))).toEqual([]);
      expect(files(JSON.stringify(wrap(`${source}\nSaved ${url}`)))).toEqual([{ url, title: 'actual.pdf' }]);
    }
  });
  it('keeps explicit file declarations when neighboring JSON text contains source examples', () => {
    const url = 'xdt-file:///tmp/report.pdf';
    expect(files(JSON.stringify({ ok: true, result: {
      _xdt_model_files: [{ url, name: 'Report' }],
      text: `const example = '${url}';`,
    } }))).toEqual([{ url, title: 'Report' }]);
  });
  it.each([
    'xdt-file:///tmp/report[final].pdf',
    'xdt-file://open?path=/tmp/report[final].pdf',
  ])('preserves square brackets in file names: %s', (url) => {
    expect(files('[报告](' + url + ')')).toEqual([{ url, title: 'report[final].pdf' }]);
    expect(files(JSON.stringify({ note: 'Saved ' + url }))).toEqual([{ url, title: 'report[final].pdf' }]);
  });
  it.each([
    'xdt-file:///tmp/report,final.pdf',
    'xdt-file:///C:/reports/report,final.pdf',
    'xdt-file://open?path=/tmp/report,final.pdf',
    'xdt-file://open?path=%2Ftmp%2Freport%2Cfinal.pdf',
  ])('preserves commas in file names without extracting source fixtures: %s', (url) => {
    const expected = [{ url, title: 'report,final.pdf' }];
    expect(files('[报告](' + url + ')')).toEqual(expected);
    expect(files('Saved "' + url + '"')).toEqual(expected);
    expect(files(JSON.stringify({ note: 'Saved ' + url }))).toEqual(expected);
    expect(files(JSON.stringify([url]))).toEqual(expected);
    const source = 'const urls = ["' + url + '", "xdt-file:///tmp/fixture.pdf"];';
    expect(files(source)).toEqual([]);
    expect(files(JSON.stringify({ text: source }))).toEqual([]);
  });
  it('keeps adjacent quoted prose references separate while filtering source arrays', () => {
    const first = "xdt-file:///tmp/O'Brien.pdf";
    const second = 'xdt-file:///tmp/second.pdf';
    const list = "'" + first + "','" + second + "'";
    expect(files('Saved ' + list)).toEqual([
      { url: first, title: "O'Brien.pdf" }, { url: second, title: 'second.pdf' },
    ]);
    expect(files('const urls = [' + list + '];')).toEqual([]);
  });
  it.each(["'", '"', String.fromCharCode(96)])('distinguishes conditional source literals from prose quoted with %s', (quote) => {
    const url = 'xdt-file:///tmp/fixture.pdf';
    const literal = quote + url + quote;
    for (const source of [
      'const path = enabled ? ' + literal + ' : undefined',
      'const path = enabled ? undefined : ' + literal,
      'return enabled ? ' + literal + ' : ' + literal,
      'const path = enabled\n  ? undefined\n  : ' + literal,
    ]) {
      expect(files(source)).toEqual([]);
      expect(files(JSON.stringify({ text: source }))).toEqual([]);
      expect(files(source + '\nFile: ' + literal)).toEqual([{ url, title: 'fixture.pdf' }]);
    }
  });
  it('retains adjacent prose references for every quote style without reviving source arrays', () => {
    const a = 'xdt-file:///tmp/first.pdf';
    const b = 'xdt-file:///tmp/second.pdf';
    for (const left of ["'", '"', String.fromCharCode(96)]) {
      for (const right of ["'", '"', String.fromCharCode(96)]) {
        for (const separator of [',', ', ']) {
          const list = left + a + left + separator + right + b + right;
          const expected = [{ url: a, title: 'first.pdf' }, { url: b, title: 'second.pdf' }];
          expect(files('Saved ' + list), list).toEqual(expected);
          expect(files(JSON.stringify({ note: 'Saved ' + list })), list).toEqual(expected);
          expect(files('const paths = [' + list + '];'), list).toEqual([]);
        }
      }
    }
  });
  it.each(['&&', '||', '??'])('ignores logical-expression source literals after %s', (operator) => {
    const url = 'xdt-file:///tmp/logical.pdf';
    for (const quote of ["'", '"', String.fromCharCode(96)]) {
      const source = 'const path = candidate ' + operator + ' ' + quote + url + quote;
      expect(files(source)).toEqual([]);
      expect(files(JSON.stringify({ text: source }))).toEqual([]);
      expect(files(source + '\nSaved ' + quote + url + quote)).toEqual([{ url, title: 'logical.pdf' }]);
      expect(files('const path = candidate ' + operator + ' /* fallback */ ' + quote + url + quote)).toEqual([]);
    }
  });
  it.each(['/* next file */', '// next file\n', '/* multi\nline "comment" */'])('filters source arrays across comments: %s', (comment) => {
    const a = 'xdt-file:///tmp/first.pdf';
    const b = 'xdt-file:///tmp/second.pdf';
    for (const quote of ["'", '"', String.fromCharCode(96)]) {
      const list = quote + a + quote + ', ' + comment + ' ' + quote + b + quote;
      const source = 'const paths = [ ' + comment + ' ' + list + ' ]';
      expect(files(source)).toEqual([]);
      expect(files(JSON.stringify({ text: source }))).toEqual([]);
      expect(files(source + '\nSaved "' + b + '"')).toEqual([{ url: b, title: 'second.pdf' }]);
      expect(files('Saved ' + list)).toEqual([{ url: a, title: 'first.pdf' }, { url: b, title: 'second.pdf' }]);
    }
  });
  it.each([
    "xdt-file:///tmp/O'Brien.pdf",
    "xdt-file:///C:/reports/O'Brien.pdf",
    "xdt-file://open?path=/tmp/O'Brien.pdf",
    'xdt-file://open?path=%2Ftmp%2FO%27Brien.pdf',
  ])('preserves apostrophes inside file names: %s', (url) => {
    const expected = [{ url, title: "O'Brien.pdf" }];
    expect(files('[report](' + url + ')')).toEqual(expected);
    expect(files('Saved ' + url)).toEqual(expected);
    expect(files(JSON.stringify({ note: 'Saved ' + url }))).toEqual(expected);
    expect(files(JSON.stringify([url]))).toEqual(expected);
    for (const quote of ["'", '"', String.fromCharCode(96)]) {
      expect(files('Saved ' + quote + url + quote)).toEqual(expected);
      expect(files('Saved ' + quote + url + quote + ', done')).toEqual(expected);
    }
    const source = 'const urls = ["' + url + '", "xdt-file:///tmp/fixture.pdf"];';
    expect(files(source)).toEqual([]);
    expect(files(JSON.stringify({ text: source }))).toEqual([]);
  });
  it.each(["'", '"', String.fromCharCode(96)])('keeps prose links quoted with %s without reviving source literals', (quote) => {
    const url = 'xdt-file:///tmp/report.pdf';
    const prose = 'Saved ' + quote + url + quote;
    expect(files(prose)).toEqual([{ url, title: 'report.pdf' }]);
    expect(files('File: ' + quote + url + quote)).toEqual([{ url, title: 'report.pdf' }]);
    expect(files(JSON.stringify({ note: prose }))).toEqual([{ url, title: 'report.pdf' }]);
    for (const source of [
      'const file = ' + quote + url + quote + ';',
      'const urls = [\n  ' + quote + url + quote + ',\n];',
      'open(' + quote + url + quote + ');',
      'const fixture = { url: ' + quote + url + quote + ' };',
      'const fixture = { "url": ' + quote + url + quote + ' };',
      'return ' + quote + url + quote,
    ]) expect(files(source)).toEqual([]);
  });
  it('decodes top-level JSON arrays before identifying source literals', () => {
    const a = 'xdt-file:///tmp/a.pdf';
    const b = 'xdt-file://open?path=%2Ftmp%2Fb.pdf';
    expect(files(JSON.stringify(a))).toEqual([{ url: a, title: 'a.pdf' }]);
    expect(files(JSON.stringify([a, { text: b }, [a]]))).toEqual([
      { url: a, title: 'a.pdf' }, { url: b, title: 'b.pdf' },
    ]);
    expect(files(JSON.stringify(['const file = "' + a + '";']))).toEqual([]);
  });
  it.each([
    'xdt-file://report.pdf',
    'xdt-file://open?path=relative%2Freport.pdf',
    'xdt-file://open?path=${encodeURIComponent(absPath)}',
    'xdt-file://open?path=',
  ])('rejects incomplete or non-absolute file references: %s', (url) => {
    expect(files(`Saved ${url}`)).toEqual([]);
    expect(files(JSON.stringify({ _xdt_model_files: [{ url }] }))).toEqual([]);
  });
  it('keeps declared files when the persist cap breaks the JSON envelope', () => {
    // tool_result 落库按 8KB 截断(capToolResultTextForPersist),超限的 JSON 结果
    // 会变成非法 JSON。对象键与数组分隔符仍是数据分隔符:不能被当成源码字面量
    // 语法,否则重开任务后全部投递消失(live 可解析时同一份数据会正常提取)。
    const a = 'xdt-file:///tmp/report.pdf';
    const b = 'xdt-file://open?path=%2Ftmp%2Findex.html';
    const suffix = '\n\n[tool result truncated: stored first 8KB]';
    const capped = (text: string) => text.slice(0, 8192 - suffix.length) + suffix;
    const envelope = (extra: Record<string, unknown>) =>
      JSON.stringify({ ok: true, result: { ...extra, log: 'x'.repeat(9000) } });
    for (const source of [
      envelope({ _xdt_model_files: [{ url: a, name: 'Report' }, { url: b, name: 'Index' }] }),
      envelope({ xdt_media_produced: [a, b] }),
    ]) {
      // 修复截断前缀后走已解码路径:投递清单与 live 完全一致(含声明 name 标题)。
      const text = capped(source);
      expect(files(text)).toEqual(files(source));
      expect(files(text).length).toBe(2);
      expect(hasVisibleHistoryResult(text)).toBe(true);
    }
    // 字符串内的源码 fixture 仍不算投递:其引号在 JSON 文本里是转义的 \"。
    const fixture = JSON.stringify({
      text: 'const a = "' + 'xdt-file:///tmp/fixture.pdf' + '";',
      log: 'y'.repeat(9000),
    });
    expect(files(capped(fixture))).toEqual([]);
  });
  it('keeps live and capped extraction consistent around escaped source literals', () => {
    // 同一份源码字面量:live 走已解码的字符串值,落库截断后走原文扫描。转义
    // 引号说明引用来自 JSON 字符串内部,两条路径必须得出同样的"非投递"结论。
    const url = 'xdt-file:///tmp/report.pdf';
    const source = JSON.stringify({ ok: true, stdout: `const urls = ["${url}"];`, log: 'x'.repeat(9000) });
    const suffix = '\n\n[tool result truncated: stored first 8KB]';
    expect(files(source)).toEqual([]);
    expect(files(source.slice(0, 8192 - suffix.length) + suffix)).toEqual([]);
    // 已解码的字符串值以 `[` 开头同样按源码过滤,与截断后的结论一致。
    expect(files(JSON.stringify({ stdout: `["${url}"]` }))).toEqual([]);
    // 未加引号的对象键是源码语法,不是被截断 JSON 的数据分隔符。
    expect(files(`{\n url: "${url}",\n}`)).toEqual([]);
  });
  it('folds string escapes before the source checks in the capped scan', () => {
    // JSON 字符串里的换行/制表符在原文中是 \n、\t 两个字符。多行源码写法
    // 在 live(已解码)与截断后(原文)也必须一致判非投递。
    const url = 'xdt-file:///tmp/report.pdf';
    const suffix = '\n\n[tool result truncated: stored first 8KB]';
    const cap = (text: string) => text.slice(0, 8192 - suffix.length) + suffix;
    for (const snippet of [
      `const urls = [\n  "${url}"];`,
      `const urls = [\n  "${url}",\n];`,
      `{ url:\n\t"${url}",\n}`,
      `{\n  url: "${url}"\n}`,
    ]) {
      const source = JSON.stringify({ ok: true, stdout: snippet, log: 'x'.repeat(9000) });
      expect(files(source), snippet).toEqual([]);
      expect(files(cap(source)), snippet).toEqual([]);
    }
    // 混合信封:截断后只保留真声明,字符串内的多行源码片段不升级为投递。
    const fixture = 'xdt-file:///tmp/fixture.pdf';
    const mixed = JSON.stringify({
      ok: true,
      result: { _xdt_model_files: [{ url, name: 'Report' }] },
      stdout: `const urls = [\n  "${fixture}"];`,
      log: 'z'.repeat(9000),
    });
    expect(files(cap(mixed))).toEqual([{ url, title: 'Report' }]);
    expect(files(cap(mixed))).toEqual(files(mixed));
  });
  it('decodes the repaired prefix instead of scanning raw JSON text', () => {
    // 截断信封先修复成可解析前缀,再走与 live 相同的已解码判定:抑制哨兵、
    // 字符串内注释、单引号源码数组、字面量反斜杠与嵌套非受支持层级都一致。
    const suffix = '\n\n[tool result truncated: stored first 8KB]';
    const cap = (text: string) => text.slice(0, 8192 - suffix.length) + suffix;
    const suppressed = JSON.stringify({
      _xdt_render_image: false,
      _xdt_model_files: [{ url: 'xdt-file:///tmp/suppressed.pdf' }],
      log: 'x'.repeat(9000),
    });
    expect(files(suppressed)).toEqual([]);
    expect(files(cap(suppressed))).toEqual([]);
    for (const text of [
      '// fixture: xdt-file:///tmp/example.pdf',
      "const paths = ['xdt-file:///tmp/report.pdf']",
    ]) {
      const source = JSON.stringify({ ok: true, stdout: text, log: 'y'.repeat(9000) });
      expect(files(source), text).toEqual([]);
      expect(files(cap(source)), text).toEqual([]);
    }
    // 字面量反斜杠是正文,不是换行转义:live 与截断后同样保留真投递。
    const literal = JSON.stringify({ text: '\\nreturn "xdt-file:///tmp/report.pdf"', log: 'x'.repeat(9000) });
    expect(files(literal)).toEqual([{ url: 'xdt-file:///tmp/report.pdf', title: 'report.pdf' }]);
    expect(files(cap(literal))).toEqual(files(literal));
    // 只有受支持层级的声明算投递:嵌在任意数据里的同名数组不算。
    const nested = JSON.stringify({
      ok: true,
      result: { metadata: { _xdt_model_files: [{ url: 'xdt-file:///tmp/nested.pdf' }] } },
      log: 'y'.repeat(9000),
    });
    expect(files(nested)).toEqual([]);
    expect(files(cap(nested))).toEqual([]);
  });
  it('drops the file URL the persist cap cut in half', () => {
    // 切点落在 URL 中段:半截 URL 指向的文件已物理丢失,不能变成死卡片。
    const suffix = '\n\n[tool result truncated: stored first 8KB]';
    const url = 'xdt-file:///tmp/report-final.pdf';
    const head = '{"ok":true,"note":"';
    const mid = '","result":{"_xdt_model_files":[{"url":"';
    const keep = 25;
    const source = head + 'x'.repeat(8192 - suffix.length - keep - head.length - mid.length)
      + mid + url + '"}],"log":"' + 'y'.repeat(9000) + '"}}';
    expect(source.indexOf(url)).toBe(8192 - suffix.length - keep);
    const capped = source.slice(0, 8192 - suffix.length) + suffix;
    expect(files(source)).toEqual([{ url, title: 'report-final.pdf' }]);
    expect(files(capped)).toEqual([]);
  });
  it('only repairs a text a platform truncation marker confirms', () => {
    // 平台截断标记是"复用已解码判定"的唯一凭据:普通文本即使以 `{`/`[` 开头,
    // 或本身就是破损 JSON,都保持与 live 相同的原文扫描口径。
    const url = 'xdt-file:///tmp/report.pdf';
    const suffix = '\n\n[tool result truncated: stored first 8KB]';
    // 根级单引号源码数组:live 判非投递,带不带截断标记都不能升级成卡片。
    expect(files(`['${url}']`)).toEqual([]);
    expect(files(`['${url}']` + suffix)).toEqual([]);
    // 不是平台截断的破损文本:真实 URL 按原文扫描保留(与父版本一致)。
    const broken = '{"message":"oops",broken:' + url;
    expect(files(broken)).toEqual([{ url, title: 'report.pdf' }]);
    // 带标记、但正文不是 JSON 前缀:同样从原文恢复该 URL,不被修复吞掉。
    const overlong = broken + ' ' + 'x'.repeat(9000);
    expect(files(overlong.slice(0, 8192 - suffix.length) + suffix)).toEqual(files(overlong));
  });
  it('treats the truncation marker as the cut boundary of a trailing literal', () => {
    // 8KB 切点恰好落在 `"ok":tru` 中段:字面量的截断边界是标记起点而不是物理
    // EOF,修复后 `ok:true` 仍能展开 result 里的文件声明。
    const url = 'xdt-file:///tmp/report.pdf';
    const suffix = '\n\n[tool result truncated: stored first 8KB]';
    const cut = 8192 - suffix.length;
    const head = '{"result":{"_xdt_model_files":[{"url":"' + url + '","name":"Report"}]},"pad":"';
    const source = head + 'x'.repeat(cut - 10 - head.length) + '","ok":true}';
    expect(source.slice(cut - 8, cut)).toBe('"ok":tru');
    const capped = source.slice(0, cut) + suffix;
    expect(files(source)).toEqual([{ url, title: 'Report' }]);
    expect(files(capped)).toEqual(files(source));
    expect(hasVisibleHistoryResult(capped)).toBe(true);
    // device-link 的两种内容上限标记同样视为截断边界。
    for (const remote of ['\n\n[remote content truncated: payload too large]', '\n[device-link truncated]']) {
      const envelope = JSON.stringify({
        ok: true,
        result: { _xdt_model_files: [{ url, name: 'Report' }] },
        log: 'x'.repeat(9000),
      });
      const text = envelope.slice(0, 8192 - remote.length) + remote;
      expect(files(text), remote).toEqual([{ url, title: 'Report' }]);
    }
  });
  it('rejects a repair prefix whose long string carries an illegal JSON escape', () => {
    // 字符串 lexer 也要校验转义:带 JSON 形前缀的破损文本(例如 `"log":"\q…`)
    // 不是被截断的 JSON,只有 `cut` 才允许修复;否则会从 checkpoint 复活前缀里
    // 已完成、而 live 原文判非投递的文件声明(评审 r4279033464)。
    const url = 'xdt-file:///tmp/report.pdf';
    const suffix = '\n\n[tool result truncated: stored first 8KB]';
    const cap = (text: string) => text.slice(0, 8192 - suffix.length) + suffix;
    for (const tail of ['"log":"\\q', '"log":"\\u12', '"log":"\\', '"log":"a\t']) {
      const source = '{"_xdt_model_files":[{"url":"' + url + '"}],' + tail + 'z'.repeat(9000) + '"}';
      expect(files(cap(source)), tail).toEqual(files(source));
      expect(files(cap(source)), tail).toEqual([]);
      expect(hasVisibleHistoryResult(cap(source)), tail).toBe(false);
    }
    // 合法转义不受影响:完成值照常保留。
    const ok = JSON.stringify({ _xdt_model_files: [{ url, name: 'Report' }], log: '\u0041'.repeat(9000) });
    expect(files(cap(ok))).toEqual(files(ok));
    expect(files(cap(ok))).toEqual([{ url, title: 'Report' }]);
  });
  it('does not salvage a body that carries the non-JSON truncation marker', () => {
    // 读取侧只把标准标记当作「正文是被截断的 JSON 文档」的证明。非 JSON 正文的
    // 截断结果带 plain 标记(apps/desktop 的
    // TOOL_RESULT_PERSIST_PLAIN_TRUNCATION_SUFFIX,此处按字面量复刻),读取侧
    // 不修前缀,按普通文本扫描——与 live 对同一正文的结论一致(评审 r4337984066)。
    const url = 'xdt-file:///tmp/report.pdf';
    const plainSuffix = '\n\n[tool result truncated: stored first 8KB, not a JSON document]';
    const cap = (text: string) => text.slice(0, 8192 - plainSuffix.length) + plainSuffix;
    const source = JSON.stringify({ _xdt_model_files: [{ url }], log: 'x'.repeat(9000) }) + ' BROKEN';
    expect(files(source)).toEqual([]);
    expect(files(cap(source))).toEqual([]);
    expect(hasVisibleHistoryResult(cap(source))).toBe(false);
  });
  it('lets a root-level empty declaration override the inner one', () => {
    // 合并取根级值:根级空数组是受合并逻辑支持的减法决定,截断侧重登记它之后,
    // 截断读取必须与 live 一致地判为非投递(评审 r4337984071)。
    const url = 'xdt-file:///tmp/report.pdf';
    const source = JSON.stringify({
      ok: true,
      result: { _xdt_model_files: [{ url, name: 'Report' }] },
      _xdt_model_files: [],
    });
    expect(files(source)).toEqual([]);
  });
});
