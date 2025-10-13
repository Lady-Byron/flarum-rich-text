import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const key = new PluginKey('lbMoreFormatPreview');

export default function lbMoreFormatPreview() {
  // —— 工具：把“字符下标”与 PM 位置互相映射（与 shim 一致）——
  const sep = '\n';
  const textAll = (state) => state.doc.textBetween(0, state.doc.content.size, sep, sep);
  const posToChar = (state, pos) => state.doc.textBetween(0, pos, sep, sep).length;
  const charToPos = (state, idx) => {
    const text = textAll(state);
    idx = Math.max(0, Math.min(idx, text.length));
    let lo = 0, hi = state.doc.content.size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const len = state.doc.textBetween(0, mid, sep, sep).length;
      if (len < idx) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  // —— 根据全文字符串构造 decorations —— //
  function buildDecorations(state) {
    const text = textAll(state);
    const decos = [];
    const hideTags = []; // [fromChar, toChar]

    // 1) 成对外包标签： [center]...[/center] / [right]...[/right]
    function applyPair(name, className) {
      const re = new RegExp(`\\[${name}\\]|\\[\\/${name}\\]`, 'gi');
      const stack = [];
      let m;
      while ((m = re.exec(text))) {
        const token = m[0];
        const a = m.index, b = a + token.length;
        hideTags.push([a, b]); // 标签本体隐藏/弱化
        const isOpen = token.toLowerCase() === `[${name}]`;
        if (isOpen) {
          stack.push(b); // 内容从“开标签结束处”开始
        } else if (stack.length) {
          const fromChar = stack.pop();
          const toChar = a; // 到“闭标签开始处”为止
          if (toChar > fromChar) {
            const from = charToPos(state, fromChar);
            const to = charToPos(state, toChar);
            decos.push(Decoration.inline(from, to, { class: `lbmf-align ${className}` }));
          }
        }
      }
    }
    applyPair('center', 'lbmf-center');
    applyPair('right',  'lbmf-right');

    // 2) 兼容老式首行缩进 [lb-indent]...[/lb-indent]（可选）
    (function applyIndentBlock() {
      const re = /\[lb-indent\]|\[\/lb-indent\]/gi;
      const stack = [];
      let m;
      while ((m = re.exec(text))) {
        const t = m[0];
        const a = m.index, b = a + t.length;
        hideTags.push([a, b]);
        const isOpen = t.toLowerCase() === '[lb-indent]';
        if (isOpen) stack.push(b);
        else if (stack.length) {
          const fromChar = stack.pop();
          const toChar = a;
          if (toChar > fromChar) {
            const from = charToPos(state, fromChar);
            const to = charToPos(state, toChar);
            decos.push(Decoration.inline(from, to, { class: 'lbmf-first-indent' })); // text-indent:2em
          }
        }
      }
    })();

    // 3) 空白段：[lb-blank][/lb-blank]  → 用 widget 占位
    (function applyBlank() {
      const re = /\[lb-blank\]|\[\/lb-blank\]/gi;
      const stack = [];
      let m;
      while ((m = re.exec(text))) {
        const t = m[0];
        const a = m.index, b = a + t.length;
        hideTags.push([a, b]);
        const isOpen = t.toLowerCase() === '[lb-blank]';
        if (isOpen) stack.push(a); // 记下“开标签起点”，用于插 widget
        else if (stack.length) {
          const openChar = stack.pop();
          const pos = charToPos(state, openChar);
          decos.push(
            Decoration.widget(
              pos,
              () => {
                const el = document.createElement('span');
                el.className = 'lb-blank';
                el.contentEditable = 'false';
                return el;
              },
              { side: 1, ignoreSelection: true }
            )
          );
        }
      }
    })();

    // 4) 新式缩进标记：[lb-i]（可连写，1 个 = 1em） → 用 widget 呈现空格块
    (function applyInlineIndent() {
      const re = /\[lb-i\]/gi;
      let m;
      while ((m = re.exec(text))) {
        const a = m.index, b = a + m[0].length;
        hideTags.push([a, b]);
        const pos = charToPos(state, a);
        decos.push(
          Decoration.widget(
            pos,
            () => {
              const el = document.createElement('span');
              el.className = 'lb-i';
              el.textContent = '\u00A0'; // 一个不可断行空格
              el.contentEditable = 'false';
              return el;
            },
            { side: 1, ignoreSelection: true }
          )
        );
      }
    })();

    // 统一把标签本体隐藏/弱化
    hideTags.forEach(([fromChar, toChar]) => {
      const from = charToPos(state, fromChar);
      const to = charToPos(state, toChar);
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
