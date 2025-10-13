// js/src/common/proseMirror/plugins/lbMoreFormatPreview.js
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const key = new PluginKey('lbMoreFormatPreview');

export default function lbMoreFormatPreview() {
  const SEP = '\n';

  // —— 文本 <-> 位置 映射（与 shim 保持一致）——
  const textAll = (state) => state.doc.textBetween(0, state.doc.content.size, SEP, SEP);
  const posToChar = (state, pos) => state.doc.textBetween(0, pos, SEP, SEP).length;
  const charToPos = (state, idx) => {
    const text = textAll(state);
    const clamped = Math.max(0, Math.min(idx, text.length));
    let lo = 0, hi = state.doc.content.size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const len = state.doc.textBetween(0, mid, SEP, SEP).length;
      if (len < clamped) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  // 解析文档 → decorations + 命中区间（用于删除）
  function buildState(state) {
    const text = textAll(state);
    const decos = [];
    const hideTags = [];
    const pairs = [];   // { openStart, openEnd, closeStart, closeEnd }（字符下标）
    const singles = []; // { start, end }（字符下标） —— [lb-i]

    // 1) 空白段 [lb-blank]...[/lb-blank]
    (function applyBlank() {
      const re = /\[lb-blank\]|\[\/lb-blank\]/gi;
      const stack = [];
      let m;
      while ((m = re.exec(text))) {
        const token = m[0];
        const from = m.index;
        const to = from + token.length;
        hideTags.push([from, to]);

        if (token.toLowerCase() === '[lb-blank]') {
          stack.push({ openStart: from, openEnd: to });
        } else if (stack.length) {
          const { openStart, openEnd } = stack.pop();
          const closeStart = from, closeEnd = to;

          // 记录成对范围：供一次性删除
          pairs.push({ openStart, openEnd, closeStart, closeEnd });

          // 在“开标签结尾”放置 widget，并 side:-1，便于右侧退格
          const pos = charToPos(state, openEnd);
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

    // 2) 行首缩进块 [lb-i]（可连写）
    (function applyInlineIndent() {
      const re = /\[lb-i\]/gi;
      let m;
      while ((m = re.exec(text))) {
        const start = m.index;
        const end = start + m[0].length;
        hideTags.push([start, end]);
        singles.push({ start, end });

        // 主体缩进 widget：放“标签结尾”，side:-1（便于退格命中标签）
        const pos = charToPos(state, end);
        decos.push(
          Decoration.widget(
            pos,
            () => {
              const el = document.createElement('span');
              el.className = 'lb-i';
              el.textContent = '\u00A0'; // 不换行空格，视觉 1em
              el.setAttribute('aria-hidden', 'true');
              el.contentEditable = 'false';
              return el;
            },
            { side: -1, ignoreSelection: true }
          )
        );

        // 末尾光标锚点：段末/文末时追加一个零宽空格，避免“光标飘远”
        const isEndOfParagraph = end >= text.length || text[end] === '\n';
        if (isEndOfParagraph) {
          decos.push(
            Decoration.widget(
              pos,                                      // 与缩进同位置
              () => document.createTextNode('\u200B'),  // ZWSP
              { side: 1 }                               // 在缩进之后
            )
          );
        }
      }
    })();

    // 隐藏标签本体（零宽不可见，保留 DOM 参与映射）
    hideTags.forEach(([a, b]) => {
      const from = charToPos(state, a);
      const to = charToPos(state, b);
      decos.push(Decoration.inline(from, to, { class: 'lbmf-tag-hidden' }));
    });

    return {
      decos: DecorationSet.create(state.doc, decos),
      pairs,
      singles,
    };
  }

  // 拦截 Backspace / Delete：一次性删除标签，不暴露文本
  function handleKeyDown(view, event) {
    const { state, dispatch } = view;
    const ps = key.getState(state);
    if (!ps) return false;

    const sel = state.selection;
    if (!sel.empty) return false;

    const caretChar = posToChar(state, sel.from);
    const isBackspace = event.key === 'Backspace';
    const isDelete = event.key === 'Delete';
    if (!isBackspace && !isDelete) return false;

    // 单个标签 [lb-i]：在“末尾 Backspace”或“开头 Delete”删除
    for (const { start, end } of ps.singles) {
      if ((isBackspace && caretChar === end) || (isDelete && caretChar === start)) {
        const s = charToPos(state, start);
        const e = charToPos(state, end);
        dispatch(state.tr.insertText('', s, e));
        event.preventDefault();
        return true;
      }
    }

    // 成对标签 [lb-blank]...[/lb-blank]：在“闭标签末尾 Backspace”或“开标签开头 Delete”整段删除
    for (const { openStart, closeEnd } of ps.pairs) {
      if ((isBackspace && caretChar === closeEnd) || (isDelete && caretChar === openStart)) {
        const s = charToPos(state, openStart);
        const e = charToPos(state, closeEnd);
        dispatch(state.tr.insertText('', s, e));
        event.preventDefault();
        return true;
      }
    }

    return false;
  }

  return new Plugin({
    key,
    state: {
      init: (_cfg, state) => buildState(state),
      apply: (tr, old, _oldState, newState) => {
        if (tr.docChanged) return buildState(newState);
        return old; // 未变更文档时沿用上一次（无需 remap）
      },
    },
    props: {
      decorations(state) {
        const st = key.getState(state);
        return st ? st.decos : null;
      },
      handleKeyDown,
    },
  });
}
