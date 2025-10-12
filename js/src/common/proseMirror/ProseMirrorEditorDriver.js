import { baseKeymap } from 'tiptap-commands';
import { history } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { EditorState, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';

import ItemList from 'flarum/common/utils/ItemList';
import disabledPlugin from './plugins/disabledPlugin';
import disableBase64PastePlugin from './plugins/disableBase64PastePlugin';
import placeholderPlugin from './plugins/placeholderPlugin';
import menuPlugin from './plugins/menuPlugin';
import toggleSpoiler from './plugins/toggleSpoiler';
import richTextKeymap from './key-bindings';
import buildInputRules from './inputrules';
import MarkdownSerializerBuilder from './markdown/MarkdownSerializerBuilder';
import MarkdownParserBuilder from './markdown/MarkdownParserBuilder';
import SchemaBuilder from './markdown/SchemaBuilder';
import { inputRules } from 'prosemirror-inputrules';

export default class ProseMirrorEditorDriver {
  constructor(target, attrs) {
    this.build(target, attrs);
  }

  build(target, attrs) {
    this.attrs = attrs;
    this.schema = new SchemaBuilder().build();

    this.parser = new MarkdownParserBuilder(this.schema).build();
    this.serializer = new MarkdownSerializerBuilder(this.schema).build();

    this.state = EditorState.create(this.buildEditorStateConfig());
    this.view = new EditorView(target, this.buildEditorProps());

    const cssClasses = attrs.classNames || [];
    cssClasses.forEach((className) => this.view.dom.classList.add(className));

    // ===== textarea 兼容层（完全模拟字符串下标语义）=====
    const self = this;

    // PM 位置 <-> 纯文本字符下标 映射
    const TEXT_SEP = '\n';
    const textAll = () =>
      self.view.state.doc.textBetween(0, self.view.state.doc.content.size, TEXT_SEP, TEXT_SEP);

    const posToCharIdx = (pos) =>
      self.view.state.doc.textBetween(0, pos, TEXT_SEP, TEXT_SEP).length;

    const charIdxToPos = (idx) => {
      // 二分：找最小 pos 使 textBetween(0,pos).length >= idx
      let lo = 0;
      let hi = self.view.state.doc.content.size;
      const total = textAll().length;
      idx = Math.max(0, Math.min(idx, total));
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const len = self.view.state.doc.textBetween(0, mid, TEXT_SEP, TEXT_SEP).length;
        if (len < idx) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    // 供 styleSelectedText / insertText.ts 使用
    this.el = {
      // 聚焦
      focus() {
        self.view.focus();
      },

      // value：字符串 getter + setter（整篇替换）
      get value() {
        return textAll();
      },
      set value(v) {
        const s = String(v);
        try {
          const newDoc = self.parser.parse(s);
          const newState = EditorState.create({
            doc: newDoc,
            schema: self.schema,
            plugins: self.view.state.plugins,
          });
          self.view.updateState(newState);
        } catch (e) {
          self.view.dispatch(
            self.view.state.tr.insertText(s, 0, self.view.state.doc.content.size)
          );
        }
        self.view.focus();
      },

      // selectionStart/End：字符下标语义（含 setter）
      get selectionStart() {
        return posToCharIdx(self.view.state.selection.from);
      },
      set selectionStart(v) {
        const end = this.selectionEnd;
        this.setSelectionRange(Number(v), end);
      },
      get selectionEnd() {
        return posToCharIdx(self.view.state.selection.to);
      },
      set selectionEnd(v) {
        const start = this.selectionStart;
        this.setSelectionRange(start, Number(v));
      },

      // setRangeText：把字符区间映射为 PM 位置后替换
      setRangeText(text, start, end /*, mode */) {
        const s =
          typeof start === 'number' ? charIdxToPos(start) : charIdxToPos(this.selectionStart);
        const e =
          typeof end === 'number' ? charIdxToPos(end) : charIdxToPos(this.selectionEnd);
        self.view.dispatch(self.view.state.tr.insertText(String(text), s, e));
        self.view.focus();
      },

      // setSelectionRange：字符下标 -> PM 位置
      setSelectionRange(start, end) {
        const s = charIdxToPos(start);
        const e = charIdxToPos(end);
        const $s = self.view.state.tr.doc.resolve(s);
        const $e = self.view.state.tr.doc.resolve(e);
        self.view.dispatch(self.view.state.tr.setSelection(new TextSelection($s, $e)));
        self.view.focus();
      },

      // insertText.ts 回退会调这个；no-op 即可
      dispatchEvent(/* ev */) {
        return true;
      },

      // 兼容 insertText.ts 临时设置 contentEditable
      set contentEditable(_v) {},
      get contentEditable() {
        return 'false';
      },
    };
    // =====================================================

    // IME 组合输入状态（可用于统计/调试）
    this._isComposing = false;
    this._compositionEndTs = 0;
  }

  buildEditorStateConfig() {
    return {
      doc: this.parseInitialValue(this.attrs.value),
      disabled: this.attrs.disabled,
      schema: this.schema,
      plugins: this.buildPluginItems().toArray(),
    };
  }

  buildPluginItems() {
    const items = new ItemList();

    items.add('markdownInputrules', inputRules({ rules: this.buildInputRules(this.schema) }));
    items.add('submit', keymap({ 'Mod-Enter': this.attrs.onsubmit }));
    items.add('escape', keymap({ Escape: this.attrs.escape }));
    items.add('richTextKeymap', keymap(richTextKeymap(this.schema)));
    items.add('baseKeymap', keymap(baseKeymap));
    items.add('placeholder', placeholderPlugin(this.attrs.placeholder));
    items.add('history', history());
    items.add('disabled', disabledPlugin());
    items.add('disableBase64Paste', disableBase64PastePlugin());
    items.add('dropCursor', dropCursor());
    items.add('gapCursor', gapCursor());
    items.add('menu', menuPlugin(this.attrs.menuState));
    items.add('toggleSpoiler', toggleSpoiler(this.schema));

    return items;
  }

  buildEditorProps() {
    const self = this;

    // 针对“所有全角/宽字符”的判定
    const isFullWidth = (ch) => {
      if (!ch) return false;
      const c = ch.charCodeAt(0);
      // 1) CJK 符号与标点 U+3000–U+303F（含【】《》〈〉「」『』、。、· 等）
      if (c >= 0x3000 && c <= 0x303F) return true;
      // 2) 全角 ASCII 变体 U+FF01–U+FF60（！＂＃$％＆＇…～）
      if (c >= 0xFF01 && c <= 0xFF60) return true;
      // 3) 全角货币等 U+FFE0–U+FFE6（￠￡￢￣￤￥￦）
      if (c >= 0xFFE0 && c <= 0xFFE6) return true;
      // 4) 常见“宽”西文标点（中文环境等宽）
      if (
        c === 0x2014 /* — */ ||
        c === 0x2026 /* … */ ||
        c === 0x2018 /* ‘ */ ||
        c === 0x2019 /* ’ */ ||
        c === 0x201C /* “ */ ||
        c === 0x201D /* ” */
      )
        return true;
      return false;
    };

    // 最近一次“文本输入”的记录
    let lastChar = '';
    let lastPos = -1;
    let lastTs = 0;

    // 获取 from 左侧 1 个字符（按纯文本语义）
    const charLeftOf = (view, from) => {
      const s = Math.max(0, from - 2);
      const t = view.state.doc.textBetween(s, from, '\n', '\n');
      return t.slice(-1);
    };

    // 去重时窗（毫秒）：避免误伤连续快速真输入
    const WINDOW_MS = 250;

    return {
      state: this.state,

      // 监听 IME 组合事件（可选，仅状态记录）
      handleDOMEvents: {
        compositionstart: () => {
          self._isComposing = true;
          return false;
        },
        compositionend: () => {
          self._isComposing = false;
          self._compositionEndTs = Date.now();
          return false;
        },
      },

      // 事前拦截：在真正改文档前，对“全角/宽字符”的第二次相邻重复直接吞掉
      handleTextInput(view, from, to, text) {
        const now = Date.now();

        // 只处理“单字符插入 + 全角/宽字符”
        if (typeof text === 'string' && text.length === 1 && isFullWidth(text)) {
          const left = charLeftOf(view, from);

          const near = from === lastPos || from === lastPos + 1; // 相同或相邻位置
          const fast = now - lastTs <= WINDOW_MS;                // 短时窗

          // 左侧字符与本次相同，且与上次插入的字符相同，并且位置相同/相邻且时间很近
          if (left === text && lastChar === text && near && fast) {
            // 吞掉这次“重复插入”
            lastChar = text;
            lastPos = from;
            lastTs = now;
            return true; // 已处理，阻止默认插入
          }

          // 记录这次
          lastChar = text;
          lastPos = from;
          lastTs = now;
        } else {
          // 其它情况重置，避免误判
          lastChar = '';
          lastPos = -1;
          lastTs = 0;
        }

        return false; // 交由 PM 默认处理
      },

      // 统一在事务层上报内容（替代早期的 DOM oninput/onkeyup）
      dispatchTransaction(transaction) {
        const newState = this.state.apply(transaction);
        this.updateState(newState);

        const newDocPlaintext = self.serializeContent(this.state.doc, self.schema);
        self.attrs.oninput(newDocPlaintext);
      },
    };
  }

  buildInputRules(schema) {
    return buildInputRules(schema);
  }

  parseInitialValue(text) {
    return this.parser.parse(text);
  }

  serializeContent(doc) {
    return this.serializer.serialize(doc, { tightLists: true });
  }

  // === 以下保留原 API ===
  moveCursorTo(position) {
    this.setSelectionRange(position, position);
  }

  getSelectionRange() {
    return [this.view.state.selection.from, this.view.state.selection.to];
  }

  getLastNChars(n) {
    const lastNode = this.view.state.selection.$from.nodeBefore;
    if (!lastNode || !lastNode.text) return '';
    return lastNode.text.slice(Math.max(0, lastNode.text.length - n));
  }

  insertAtCursor(text, escape) {
    this.insertAt(this.getSelectionRange()[0], text, escape);
    $(this.view.dom).trigger('click');
  }

  insertAt(pos, text, escape) {
    this.insertBetween(pos, pos, text, escape);
  }

  insertBetween(start, end, text, escape = true) {
    let trailingNewLines = 0;
    const OFFSET_TO_REMOVE_PREFIX_NEWLINE = 1;

    if (escape) {
      this.view.dispatch(this.view.state.tr.insertText(text, start, end));
    } else {
      start -= OFFSET_TO_REMOVE_PREFIX_NEWLINE;
      const parsedText = this.parseInitialValue(text);
      this.view.dispatch(this.view.state.tr.replaceRangeWith(start, end, parsedText));
      trailingNewLines = text.match(/\s+$/)[0].split('\n').length - 1;
    }

    this.moveCursorTo(
      Math.min(
        start + text.length + OFFSET_TO_REMOVE_PREFIX_NEWLINE,
        Selection.atEnd(this.view.state.doc).to
      )
    );
    m.redraw();

    if (text.endsWith(' ') && !escape) {
      this.insertAtCursor(' ');
    }

    Array(trailingNewLines)
      .fill(0)
      .forEach(() => {
        baseKeymap['Enter'](this.view.state, this.view.dispatch);
      });
  }

  replaceBeforeCursor(start, text, escape) {
    this.insertBetween(start, this.getSelectionRange()[0], text, escape);
  }

  setSelectionRange(start, end) {
    const $start = this.view.state.tr.doc.resolve(start);
    const $end = this.view.state.tr.doc.resolve(end);
    this.view.dispatch(this.view.state.tr.setSelection(new TextSelection($start, $end)));
    this.focus();
  }

  getCaretCoordinates(position) {
    const viewportCoords = this.view.coordsAtPos(position);
    const editorViewportOffset = this.view.dom.getBoundingClientRect();
    return {
      left: viewportCoords.left - editorViewportOffset.left,
      top: viewportCoords.top - editorViewportOffset.top,
    };
  }

  focus() {
    this.view.focus();
  }
  destroy() {
    this.view.destroy();
  }

  disabled(disabled) {
    this.view.dispatch(this.view.state.tr.setMeta('disabled', disabled));
  }
}
