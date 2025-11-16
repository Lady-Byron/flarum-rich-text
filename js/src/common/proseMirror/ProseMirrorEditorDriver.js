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
import lbMoreFormatPreview from './plugins/lbMoreFormatPreview';
// 【修复】移除 "import debounce from 'flarum/common/utils/debounce';"

export default class ProseMirrorEditorDriver {
  constructor(target, attrs) {
    // 【优化】为 debounce 创建一个计时器 ID 存储
    this.debounceTimeout = null;
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
  	// [此部分未更改]
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
      // ... [兼容层 this.el 内部代码未改变，保持原样] ...
  	  // 聚焦
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
  	 	  self.view.dispatch(
  	 	 	self.view.state.tr.insertText(s, 0, self.view.state.doc.content.size)
  	 	  );
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
  	  setRangeText(text, start, end /*, mode */) {
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
  	  dispatchEvent(/* ev */) {
  	 	return true;
  	  },
  	  set contentEditable(_v) {},
  	  get contentEditable() {
  	 	return 'false';
  	  },
  	};
  	// =====================================================


    // 【优化 & 修复】
    // 我们在这里实现一个内联的 debounce，而不是使用外部导入
    this.debouncedOnInput = () => {
        // 清除上一个待执行的计时器
        if (self.debounceTimeout) {
            clearTimeout(self.debounceTimeout);
        }

        // 创建一个新的计时器
        self.debounceTimeout = setTimeout(() => {
            if (!self.view) return; // 确保编辑器未被销毁

            // Bug修复：使用 this.view.state.doc 来获取最新状态
            const newDoc = self.view.state.doc;
            const newDocPlaintext = self.serializeContent(newDoc);
            self.attrs.oninput(newDocPlaintext);

            self.debounceTimeout = null; // 执行完毕，清空ID
        }, 250); // 250ms 延迟
    };


  	const callInputListeners = (e) => {
  	  this.attrs.inputListeners.forEach((listener) => {
  	 	listener.call(target);
  	  });
  	  e.redraw = false;
  	};

  	target.oninput = callInputListeners;
  	target.onclick = callInputListeners;
  	target.onkeyup = callInputListeners;
  }

  buildEditorStateConfig() {
    // ... [此方法未改变] ...
  	return {
  	  doc: this.parseInitialValue(this.attrs.value),
  	  disabled: this.attrs.disabled,
  	  schema: this.schema,
  	  plugins: this.buildPluginItems().toArray(),
  	};
  }

  buildPluginItems() {
  	// [此部分未更改]
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
  	items.add('lbMoreFormatPreview', lbMoreFormatPreview());
  	return items;
  }

  buildEditorProps() {
  	const self = this;

  	// === 仅列表环境下的“全角/宽字符相邻重复去重” ===
  	// [此部分未更改]
  	const isFullWidth = (ch) => {
  	  if (!ch) return false;
  	  const c = ch.charCodeAt(0);
  	  if (c >= 0x3000 && c <= 0x303F) return true; 	// CJK 符号/标点
  	  if (c >= 0xFF01 && c <= 0xFF60) return true; 	// 全角 ASCII 变体
  	  if (c >= 0xFFE0 && c <= 0xFFE6) return true; 	// 全角货币等
  	  if (c === 0x2014 || c === 0x2026 || c === 0x2018 || c === 0x2019 || c === 0x201C || c === 0x201D) return true;
  	  return false;
  	};
  	const inList = (state) => {
  	  const $pos = state.selection.$from;
  	  for (let d = $pos.depth; d >= 0; d--) {
  	 	const name = $pos.node(d)?.type?.name;
  	 	if (name === 'list_item' || name === 'bullet_list' || name === 'ordered_list') return true;
  	  }
  	  return false;
  	};
  	const charLeftOf = (view, from) => {
  	  const s = Math.max(0, from - 2);
  	  const t = view.state.doc.textBetween(s, from, '\n', '\n');
  	  return t.slice(-1);
  	};
  	let lastChar = '';
  	let lastPos = -1;
  	let lastTs = 0;
  	const WINDOW_MS = 250;

  	return {
  	  state: this.state,

  	  handleTextInput(view, from, to, text) {
  	 	// [此部分未更改]
  	 	if (!inList(view.state)) return false;
  	 	if (typeof text !== 'string' || text.length !== 1 || !isFullWidth(text)) return false;

  	 	const now = Date.now();
  	 	const left = charLeftOf(view, from);
  	 	const near = from === lastPos || from === lastPos + 1;
  	 	const fast = now - lastTs <= WINDOW_MS;

  	 	if (left === text && lastChar === text && near && fast) {
  	 	  lastChar = text;
  	 	  lastPos = from;
  	 	  lastTs = now;
  	 	  return true;
  	 	}

  	 	lastChar = text;
  	 	lastPos = from;
  	 	lastTs = now;
  	 	return false;
  	  },

  	  dispatchTransaction(transaction) {
  	 	const newState = this.state.apply(transaction);
        // 立即更新视图状态
  	 	this.updateState(newState); 

        // 【优化】改为调用我们内联的 debounced 函数
        self.debouncedOnInput();
  	  },
  	};
  }

  buildInputRules(schema) {
    // ... [以下所有方法均未改变] ...
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
Such as:    	  trailingNewLines = text.match(/\s+$/)[0].split('\n').length - 1;
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
    // 【优化 & 修复】确保在销毁时清除待处理的计时器
    if (this.debounceTimeout) {
        clearTimeout(this.debounceTimeout);
    }
  	this.view.destroy();
  }

  disabled(disabled) {
  	this.view.dispatch(this.view.state.tr.setMeta('disabled', disabled));
  }
}
