import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const key = new PluginKey('lbMoreFormatPreview');

export default function lbMoreFormatPreview() {
  const SEP = '\n';

  // —— 文本 <-> 位置 映射（与 shim 保持一致）——
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
    const hideTags = []; // [fromChar, toChar]

    // 1) 空白段落：[lb-blank][/lb-blank]
    (function applyBlank() {
      const re = /\[lb-blank\]|\[\/lb-blank\]/gi;
      const stack = [];
      let m;
      while ((m = re.exec(text))) {
        const token = m[0];
        const from = m.index;
        const to = from + token.length;
        hideTags.push([from, to]);              // 隐藏标签本体
        if (token.toLowerCase() === '[lb-blank]') {
          // 记录“开标签结尾”的字符下标（注意不是开头）
          stack.push(to);
        } else if (stack.length) {
          const openEndChar = stack.pop();
          // widget 放在“开标签结尾处”，并 side:-1，方便从右侧退格
          const pos = charToPos(state, openEndChar);
          decos.push(
            Decoration.widget(
              pos,
              () => {
                const el = document.createElement('span');
                el.className = 'lb-blank';
                el.setAttribute('aria-hidden', 'true');
                el.contentEditable = 'false';
                return el;
              },
              { side: -1, ignoreSelection: true }
            )
          );
        }
      }
    })();

    // 2) 行首缩进块：[lb-i]（可连写）
    (function applyInlineIndent() {
      const re = /\[lb-i\]/gi;
      let m;
      while ((m = re.exec(text))) {
        const from = m.index;
        const to = from + m[0].length;
        hideTags.push([from, to]);              // 隐藏标签本体
        // widget 放在“标签结尾处”，并 side:-1
        const pos = charToPos(state, to);
        decos.push(
          Decoration.widget(
            pos,
            () => {
              const el = document.createElement('span');
              el.className = 'lb-i';
              el.textContent = '\u00A0';        // 不换行空格
              el.setAttribute('aria-hidden', 'true');
              el.contentEditable = 'false';
              return el;
            },
            { side: -1, ignoreSelection: true }
          )
        );
      }
    })();

    // 统一隐藏标签本体（零宽不可见，保留 DOM 参与映射）
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
      init: (_cfg, state) => buildDecorations(state),
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
