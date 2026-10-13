// @vitest-environment jsdom

/**
 * 「引用目录」系统项(cindy-library: 槽)文案必须跟随界面语言。
 *
 * 回归背景(issue #5929):系统项文案曾在 extraDirDisplayLabel 里硬编码为
 * 简体中文「Mivo 作品库（只读）」,en / ja / ko / zh-TW 界面下同一行显示同一
 * 中文串;该面板其它文案都已本地化,只有这一行脱离 i18n。
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import i18n from '@/i18n';
import { AtMentionPanel } from '@/components/new-chat/AtMentionPanel';

const LIBRARY_SLOT = 'cindy-library:/tmp/mivo-library';
/** 修复前的硬编码串——非简中界面下不应再出现。 */
const HARDCODED_LEGACY_LABEL = 'Mivo 作品库（只读）';

function renderPanelWithLibrarySlot() {
  return render(
    <AtMentionPanel
      query=""
      state={{ kind: 'ready', items: [], truncated: false }}
      entries={[]}
      focusedIndex={0}
      onFocusedIndexChange={() => {}}
      onSelect={() => {}}
      onClose={() => {}}
      onRetry={() => {}}
      referenceDirs={{ dirs: [LIBRARY_SLOT], onRemove: () => {} }}
      writableDirs={null}
    />,
  );
}

afterEach(async () => {
  cleanup();
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

describe('composer 引用目录系统项文案跟随界面语言', () => {
  for (const locale of ['en', 'zh-TW', 'ja', 'ko', 'zh-CN'] as const) {
    it(`${locale}: 系统项显示本语言文案`, async () => {
      await act(async () => {
        await i18n.changeLanguage(locale);
      });
      const expected = i18n.t('extraDirs.libraryReadOnlyLabel');
      renderPanelWithLibrarySlot();
      expect(screen.getByText(expected)).toBeTruthy();
      if (locale !== 'zh-CN') {
        expect(screen.queryByText(HARDCODED_LEGACY_LABEL)).toBeNull();
      }
    });
  }
});
