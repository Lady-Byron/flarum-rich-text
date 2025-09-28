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

    // ===== textarea 兼容层（供 styleSelectedText 使用） =====
    const self = this;
    this.el = {
      focus() {
        self.view.focus();
      },
      // 返回整个文档的纯文本；styleSelectedText 期望这是“字符串”
      get value() {
        const doc = self.view.state.doc;
        return doc.textBetween(0, doc.content.size, '\n', '\n');
      },
      get selectionStart() {
        return self.view.state.selection.from;
      },
      get selectionEnd() {
        return self.view.state.selection.to;
      },
      setRangeText(text, start, end /*, mode */) {
        const s = typeof start === 'number' ? start : self.view.state.selection.from;
        const e = typeof end === 'number' ? end : self.view.state.selection.to;
        self.view.dispatch(self.view.state.tr.insertText(text, s, e));
        self.view.focus();
      },
      setSelectionRange(start, end) {
        const $s = self.view.state.tr.doc.resolve(start);
        const $e = self.view.state.tr.doc.resolve(end);
        self.view.dispatch(self.view.state.tr.setSelection(new TextSelection($s, $e)));
        self.view.focus();
      },
    };
    // =======================================================

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

    return {
      state: this.state,
      dispatchTransaction(transaction) {
        let newState = this.state.apply(transaction);
        this.updateState(newState);

        const newDoc = this.state.doc;
        const newDocPlaintext = self.serializeContent(newDoc, self.schema);
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

  // External Control Stuff

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
      Math.min(start + text.length + OFFSET_TO_REMOVE_PREFIX_NEWLINE, Selection.atEnd(this.view.state.doc).to)
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
