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

    const TEXT_SEP = '\n';
    const textAll = () =>
      self.view.state.doc.textBetween(0, self.view.state.doc.content.size, TEXT_SEP, TEXT_SEP);

    const posToCharIdx = (pos) =>
      self.view.state.doc.textBetween(0, pos, TEXT_SEP, TEXT_SEP).length;

    const charIdxToPos = (idx) => {
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

    this.el = {
      focus() {
        self.view.focus();
      },
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
          self.view.dispatch(self.view.state.tr.insertText(s, 0, self.view.state.doc.content.size));
        }
        self.view.focus();
      },
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
      setRangeText(text, start, end) {
        const s =
          typeof start === 'number' ? charIdxToPos(start) : charIdxToPos(this.selectionStart);
        const e =
          typeof end === 'number' ? charIdxToPos(end) : charIdxToPos(this.selectionEnd);
        self.view.dispatch(self.view.state.tr.insertText(String(text), s, e));
        self.view.focus();
      },
      setSelectionRange(start, end) {
        const s = charIdxToPos(start);
        const e = charIdxToPos(end);
        const $s = self.view.state.tr.doc.resolve(s);
        const $e = self.view.state.tr.doc.resolve(e);
        self.view.dispatch(self.view.state.tr.setSelection(new TextSelection($s, $e)));
        self.view.focus();
      },
      dispatchEvent() {
        return true;
      },
      set contentEditable(_v) {},
      get contentEditable() {
        return 'false';
      },
    };
    // =====================================================

    // IME 组合输入状态
    this._isComposing = false;
    this._suppressOnInput = false;
    this._pendingOnInput = false;
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

    // —— 工具函数 ——
    const isFullWidth = (ch) => {
      if (!ch) return false;
      const c = ch.charCodeAt(0);
      if (c >= 0x3000 && c <= 0x303F) return true;
      if (c >= 0xFF01 && c <= 0xFF60) return true;
      if (c >= 0xFFE0 && c <= 0xFFE6) return true;
      if (c === 0x2014 || c === 0x2026 || c === 0x2018 || c === 0x2019 || c === 0x201C || c === 0x201D) return true;
      return false;
    };

    // 仅 ASCII（用于识别拼音/英文片段）
    const isAsciiLettersDigits = (t) => typeof t === 'string' && /^[a-zA-Z0-9' ]+$/.test(t);

    // 是否处在列表项中（bullet/ordered）
    const inList = (state) => {
      const $pos = state.selection.$from;
      for (let d = $pos.depth; d >= 0; d--) {
        const n = $pos.node(d);
        const name = n && n.type && n.type.name;
        if (name === 'list_item' || name === 'bullet_list' || name === 'ordered_list') return true;
      }
      return false;
    };

    let lastChar = '';
    let lastPos = -1;
    let lastTs = 0;

    const charLeftOf = (view, from) => {
      const s = Math.max(0, from - 2);
      const t = view.state.doc.textBetween(s, from, '\n', '\n');
      return t.slice(-1);
    };

    const WINDOW_MS = 250;

    const FLUSH_AFTER_COMPOSITION_MS = 40;
    const flushOnInput = () => {
      const newDocPlaintext = self.serializeContent(self.view.state.doc, self.schema);
      self.attrs.oninput(newDocPlaintext);
    };

    return {
      state: this.state,

      handleDOMEvents: {
        compositionstart: () => {
          self._isComposing = true;
          self._suppressOnInput = true;
          return false;
        },
        compositionupdate: () => false,
        compositionend: () => {
          self._isComposing = false;
          setTimeout(() => {
            self._suppressOnInput = false;
            const need = self._pendingOnInput;
            self._pendingOnInput = false;
            flushOnInput();
            if (need) ; // 已合并
          }, FLUSH_AFTER_COMPOSITION_MS);
          return false;
        },
        // 关键：在列表环境 + 组合态时，拦截 ASCII（拼音）片段，避免写进文档
        beforeinput: (_view, ev) => {
          try {
            if (!ev) return false;
            const composing = ev.isComposing === true;
            const data = typeof ev.data === 'string' ? ev.data : '';
            const type = ev.inputType || '';
            if (
              composing &&
              inList(self.view.state) &&
              (isAsciiLettersDigits(data) || type === 'insertText') // 某些浏览器 data 为空
            ) {
              // 允许最终中文在 compositionend 落盘；此处只拦拼音
              ev.preventDefault();
              return true;
            }
          } catch (e) {}
          return false;
        },
      },

      // 组合中在列表里出现的 ASCII 文本（拼音）也从这里兜底拦截
      handleTextInput(view, from, to, text) {
        // 1) 组合态 + 列表环境 + ASCII：吞掉（拼音不入文档）
        if (self._isComposing && inList(view.state) && isAsciiLettersDigits(text)) {
          return true;
        }

        // 2) 非组合态：保留“全角重复去重”以修复部分浏览器的重复上屏
        const now = Date.now();
        if (typeof text === 'string' && text.length === 1 && isFullWidth(text)) {
          const left = charLeftOf(view, from);
          const near = from === lastPos || from === lastPos + 1;
          const fast = now - lastTs <= WINDOW_MS;
          if (left === text && lastChar === text && near && fast) {
            lastChar = text; lastPos = from; lastTs = now;
            return true;
          }
          lastChar = text; lastPos = from; lastTs = now;
        } else {
          lastChar = ''; lastPos = -1; lastTs = 0;
        }

        return false;
      },

      dispatchTransaction(transaction) {
        const newState = this.state.apply(transaction);
        this.updateState(newState);

        if (self._suppressOnInput) {
          self._pendingOnInput = true;
          return;
        }
        flushOnInput();
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
