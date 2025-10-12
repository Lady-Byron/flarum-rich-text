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
        if (len < idx) lo = mid + 1; else hi = mid;
      }
      return lo;
    };

    // 供 styleSelectedText / insertText.ts 使用
    this.el = {
      focus() { self.view.focus(); },

      get value() { return textAll(); },
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
          self.view.dispatch(self.view.state.tr.insertText(s, 0, self.view.state.doc.content.size));
        }
        self.view.focus();
      },

      get selectionStart() { return posToCharIdx(self.view.state.selection.from); },
      set selectionStart(v) {
        const end = this.selectionEnd;
        this.setSelectionRange(Number(v), end);
      },
      get selectionEnd() { return posToCharIdx(self.view.state.selection.to); },
      set selectionEnd(v) {
        const start = this.selectionStart;
        this.setSelectionRange(start, Number(v));
      },

      setRangeText(text, start, end /*, mode */) {
        const s = typeof start === 'number' ? charIdxToPos(start) : charIdxToPos(this.selectionStart);
        const e = typeof end === 'number' ? charIdxToPos(end) : charIdxToPos(this.selectionEnd);
        self.view.dispatch(self.view.state.tr.insertText(String(text), s, e));
        self.view.focus();
      },

      setSelectionRange(start, end) {
        const s = charIdxToPos(start), e = charIdxToPos(end);
        const $s = self.view.state.tr.doc.resolve(s);
        const $e = self.view.state.tr.doc.resolve(e);
        self.view.dispatch(self.view.state.tr.setSelection(new TextSelection($s, $e)));
        self.view.focus();
      },

      dispatchEvent() { return true; },
      set contentEditable(_v) {},
      get contentEditable() { return 'false'; },
    };
    // =====================================================

    // IME 组合输入状态
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

    // 仅在 IME 结束的瞬间，用一个小型去重规则兜底（针对全角符号等）
    const isFullWidth = (ch) => {
      if (!ch) return false;
      const c = ch.charCodeAt(0);
      return (c >= 0xFF01 && c <= 0xFF5E) // 全角基本符号
          || c === 0x3002 || c === 0x3001 || c === 0xFF0C // 。 、 ，
          || c === 0xFF1A || c === 0xFF1B                  // ： ；
          || c === 0xFF08 || c === 0xFF09                  // （ ）
          || c === 0x2014 || c === 0x2026                  // — …
          || c === 0x2018 || c === 0x2019                  // ‘ ’
          || c === 0x201C || c === 0x201D;                 // “ ”
    };

    return {
      state: this.state,

      // 监听 IME 组合事件，仅做状态标记
      handleDOMEvents: {
        compositionstart: () => { self._isComposing = true; return false; },
        compositionend:   () => { self._isComposing = false; self._compositionEndTs = Date.now(); return false; },
      },

      dispatchTransaction(transaction) {
        const prevState = this.state;
        const prevDoc = prevState.doc;
        const prevText = prevDoc.textBetween(0, prevDoc.content.size, '\n', '\n');

        const candidate = prevState.apply(transaction);
        const nextDoc = candidate.doc;
        const nextText = nextDoc.textBetween(0, nextDoc.content.size, '\n', '\n');

        // —— IME 结束瞬间的“全角符号双写”去重：仅在长度+1、且与前一个字符相同的情况下丢弃 ——
        if (!self._isComposing && Date.now() - self._compositionEndTs <= 200) {
          if (nextText.length === prevText.length + 1) {
            // 找到首个差异位置 i
            let i = 0;
            const lim = Math.min(prevText.length, nextText.length);
            while (i < lim && prevText.charCodeAt(i) === nextText.charCodeAt(i)) i++;

            const insertedChar = nextText[i];
            const prevLeftChar = prevText[i - 1];

            // 典型场景：prev = A！B, next = A！！B  => i 指向第二个“！”
            if (insertedChar && prevLeftChar && insertedChar === prevLeftChar && isFullWidth(insertedChar)) {
              return; // 丢弃这次事务（判定为 IME 结束引发的重复插入）
            }
          }
        }

        this.updateState(candidate);
        const newDocPlaintext = self.serializeContent(nextDoc, self.schema);
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

  focus() { this.view.focus(); }
  destroy() { this.view.destroy(); }

  disabled(disabled) {
    this.view.dispatch(this.view.state.tr.setMeta('disabled', disabled));
  }
}
