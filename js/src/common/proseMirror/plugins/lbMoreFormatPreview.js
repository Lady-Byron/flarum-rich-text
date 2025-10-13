import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const key = new PluginKey('lbMoreFormatPreview');

export default function lbMoreFormatPreview() {
  const SEP = '\n';

  // —— 文本 <-> 位置 映射（与 shim 一致）——
  const textAll = (state) => state.doc.textBetween(0, state.doc.content.size, SEP, SEP);
  const posToChar = (state, pos) => state.doc.textBetween(0, pos, SEP, SEP).length;
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

  // 解析全文，返回 { decos, pairs, singles }
  function buildState(state) {
    const text = textAll(state);
    const decos = [];
    const hideTags = [];
    const pairs = [];   // { openStart, openEnd, closeStart, closeEnd } —— 字符下标
    const singles = []; // { start, end } —— [lb-i]

    // 1) 空白段 [lb-blank][/lb-blank]：生成 widget + 隐藏开闭标签；记录成对范围
    (function applyBlank() {
      const re = /\[lb-blank\]|\[\/lb-blank\]/gi;
      const stack = [];
      let m;
      while ((m = re.exec(text))) {
        const token = m[0];
        const from = m.index;
        const to = from + token.length;
        hideTags.push([from, to]); // 隐藏标签本体

        if (token.toLowerCase() === '[lb-blank]') {
          stack.push({ openStart: from, openEnd: to });
        } else if (stack.length) {
          const { openStart, openEnd } = stack.pop();
          const closeStart = from, closeEnd = to;

          // 记录成对范围（用于一键删除整段）
          pairs.push({ openStart, openEnd, closeStart, closeEnd });

          // widget 放在“开标签结尾”，并 side:-1，利于从右侧退格
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

    // 2) 行首缩进块 [lb-i]：每个一个 widget；记录单个范围
    (function applyInlineIndent() {
      const re = /\[lb-i\]/gi;
      let m;
      while ((m = re.exec(text))) {
        const start = m.index;
        const end = start + m[0].length;
        hideTags.push([start, end]);
        singles.push({ start, end });

        // widget 放在“标签结尾”，side:-1
        const pos = charToPos(state, end);
        decos.push(
          Decoration.widget(
            pos,
            () => {
              const el = document.createElement('span');
              el.className = 'lb-i';
              el.textContent = '\u00A0';
              el.setAttribute('aria-hidden', 'true');
              el.contentEditable = 'false';
              return el;
            },
            { side: -1, ignoreSelection: true }
          )
        );
      }
    })();

    // 把标签本体隐藏（零宽不可见，保留 DOM 参与映射）
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

  // —— 键盘拦截：Backspace / Delete —— //
  function handleKeyDown(view, event) {
    const { state, dispatch } = view;
    const pluginState = key.getState(state);
    if (!pluginState) return false;

    const sel = state.selection;
    if (!sel.empty) return false; // 选区非空，放行默认删除

    const caretChar = posToChar(state, sel.from);
    const isBackspace = event.key === 'Backspace';
    const isDelete = event.key === 'Delete';

    if (!isBackspace && !isDelete) return false;

    // 1) 单个标签 [lb-i]：在标签“末尾”（Backspace）或“开头”（Delete）触发删除
    for (const { start, end } of pluginState.singles) {
      if ((isBackspace && caretChar === end) || (isDelete && caretChar === start)) {
        const s = charToPos(state, start);
        const e = charToPos(state, end);
        dispatch(state.tr.insertText('', s, e));
        event.preventDefault();
        return true;
      }
    }

    // 2) 成对标签 [lb-blank]...[\/lb-blank]：在“闭标签末尾”（Backspace）或“开标签开头”（Delete）触发整段删除
    for (const { openStart, closeEnd } of pluginState.pairs) {
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
        // 文档未变更时，沿用旧 decos/pairs/singles
        return old;
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

