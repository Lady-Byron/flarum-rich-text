import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const key = new PluginKey('lbMoreFormatPreview');

export default function lbMoreFormatPreview() {
  const SEP = '\n';

  // 把“字符下标” <-> “PM 位置”互相转换（与 shim 一致，稳定）
  const textAll = (state) => state.doc.textBetween(0, state.doc.content.size, SEP, SEP);
  const charToPos = (state, idx) => {
    const text = textAll(state);
    idx = Math.max(0, Math.min(idx, text.length));
    let lo = 0, hi = state.doc.content.size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const len = state.doc.textBetween(0, mid, SEP, SEP).length;
      if (len < idx) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  function buildDecorations(state) {
    const text = textAll(state);
    const decos = [];
    const hideTags = []; // 收集需要“隐藏/弱化”的标签本体区间

    // 1) 空白段落：[lb-blank][/lb-blank] → 在开标签处插入一个 block widget
    (function applyBlank() {
      const re = /\[lb-blank\]|\[\/lb-blank\]/gi;
      const stack = [];
      let m;
      while ((m = re.exec(text))) {
        const token = m[0];
        const from = m.index;
        const to = from + token.length;
        hideTags.push([from, to]); // 隐藏开/闭标签本体
        const isOpen = token.toLowerCase() === '[lb-blank]';
        if (isOpen) {
          stack.push(from); // 记下“开标签的起点字符下标”
        } else if (stack.length) {
          const openChar = stack.pop();
          const pos = charToPos(state, openChar); // 在开标签位置插入 widget
          decos.push(
            Decoration.widget(
              pos,
              () => {
                const el = document.createElement('span');
                el.className = 'lb-blank';      // 样式见下文 CSS
                el.setAttribute('aria-hidden', 'true');
                el.contentEditable = 'false';
                return el;
              },
              { side: 1, ignoreSelection: true }
            )
          );
        }
      }
    })();

    // 2) 行首缩进块：[lb-i]（可连写，每个等于 1em）
    (function applyInlineIndent() {
      const re = /\[lb-i\]/gi;
      let m;
      while ((m = re.exec(text))) {
        const from = m.index;
        const to = from + m[0].length;
        hideTags.push([from, to]); // 隐藏标签本体
        const pos = charToPos(state, from);
        decos.push(
          Decoration.widget(
            pos,
            () => {
              const el = document.createElement('span');
              el.className = 'lb-i';
              el.textContent = '\u00A0'; // 不换行空格，避免光标卡住
              el.setAttribute('aria-hidden', 'true');
              el.contentEditable = 'false';
              return el;
            },
            { side: 1, ignoreSelection: true }
          )
        );
      }
    })();

    // 把标签本体统一弱化/隐藏
    hideTags.forEach(([a, b]) => {
      const from = charToPos(state, a);
      const to   = charToPos(state, b);
      decos.push(Decoration.inline(from, to, { class: 'lbmf-tag-hidden' }));
    });

    return DecorationSet.create(state.doc, decos);
  }

  return new Plugin({
    key,
    state: {
      init: (_config, state) => buildDecorations(state),
      apply: (tr, old, _oldState, newState) => {
        if (tr.docChanged) return buildDecorations(newState);
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}

