'use strict';

/**
 * Montagebericht-HTML → Absätze mit Style-Runs + Bildblöcke.
 * Kein docx, kein pdf-lib — nur strukturierte Daten für den PDF-Renderer.
 */

const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'tr', 'pre',
]);
const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'wbr']);

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/\u00a0/g, ' ');
}

function parseStyle(styleText) {
  const out = {};
  String(styleText || '').split(';').forEach((part) => {
    const idx = part.indexOf(':');
    if (idx <= 0) return;
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

function styleFromTag(tag, styleAttr) {
  const lower = String(tag || '').toLowerCase();
  const css = parseStyle(styleAttr || '');
  const out = { bold: false, italic: false, underline: false };
  if (lower === 'b' || lower === 'strong') out.bold = true;
  if (lower === 'i' || lower === 'em') out.italic = true;
  if (lower === 'u') out.underline = true;
  const weight = String(css['font-weight'] || '').toLowerCase();
  if (weight === 'bold' || weight === 'bolder' || parseInt(weight, 10) >= 600) out.bold = true;
  if (String(css['font-style'] || '').toLowerCase() === 'italic') out.italic = true;
  const deco = String(css['text-decoration'] || '').toLowerCase();
  if (deco.indexOf('underline') >= 0) out.underline = true;
  return out;
}

function mergeStyle(base, extra) {
  return {
    bold: !!(base && base.bold) || !!(extra && extra.bold),
    italic: !!(base && base.italic) || !!(extra && extra.italic),
    underline: !!(base && base.underline) || !!(extra && extra.underline),
  };
}

function sameStyle(a, b) {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline;
}

function flattenTables(html) {
  return String(html || '').replace(/<\/?(table|thead|tbody|tfoot|tr|td|th)\b[^>]*>/gi, (m) => {
    if (/^<\s*\//i.test(m) && (/\/\s*tr\b/i.test(m) || /\/\s*table\b/i.test(m))) return '<br>';
    return '';
  });
}

function parseImgMeta(tag) {
  const srcM = String(tag || '').match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  let widthPct = 100;
  const styleW = String(tag || '').match(/width\s*:\s*([\d.]+)\s*%/i);
  const attrW = String(tag || '').match(/\bwidth\s*=\s*["']([\d.]+)%["']/i);
  if (styleW) widthPct = Math.min(100, Math.max(10, parseFloat(styleW[1]) || 100));
  else if (attrW) widthPct = Math.min(100, Math.max(10, parseFloat(attrW[1]) || 100));
  const src = srcM ? decodeHtmlEntities(srcM[1].trim()) : '';
  return { src, widthPct };
}

function runsHaveText(runs) {
  return (runs || []).some((r) => String(r.text || '').trim());
}

function lastParagraphIsEmpty(paragraphs) {
  if (!paragraphs.length) return false;
  return !runsHaveText(paragraphs[paragraphs.length - 1]);
}

function mergeRunInto(runs, text, style) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && sameStyle(last, style)) {
    last.text += text;
    return;
  }
  runs.push({
    text,
    bold: !!style.bold,
    italic: !!style.italic,
    underline: !!style.underline,
  });
}

/**
 * @param {string} html
 * @param {string} [plainFallback]
 * @returns {Array<{type:'text', paragraphs: Array<Array<{text:string,bold:boolean,italic:boolean,underline:boolean}>>}|{type:'image', src:string, widthPct:number}>}
 */
function htmlToStyledBlocks(html, plainFallback) {
  const rawIn = String(html || '').trim();
  if (!rawIn) {
    const p = String(plainFallback || '').trim();
    if (!p) return [];
    const paragraphs = p.split(/\r?\n/).map((line) => {
      const t = line.replace(/[ \t]+/g, ' ');
      if (!t.trim()) return [];
      return [{ text: t, bold: false, italic: false, underline: false }];
    });
    while (paragraphs.length && !runsHaveText(paragraphs[0])) paragraphs.shift();
    while (paragraphs.length && !runsHaveText(paragraphs[paragraphs.length - 1])) paragraphs.pop();
    return paragraphs.length ? [{ type: 'text', paragraphs }] : [];
  }

  if (!/<[a-z]/i.test(rawIn)) {
    return htmlToStyledBlocks('', decodeHtmlEntities(rawIn));
  }

  const raw = flattenTables(rawIn);
  const tokens = raw
    .replace(/\r\n?/g, '\n')
    .split(/(<[^>]+>)/g)
    .filter(Boolean);

  const blocks = [];
  let paragraphs = [];
  let current = [];
  let styleStack = [{ bold: false, italic: false, underline: false }];

  function flushTextBlock() {
    collapseEmptyParagraphs(paragraphs);
    if (paragraphs.length) {
      blocks.push({ type: 'text', paragraphs });
    }
    paragraphs = [];
    current = [];
  }

  function flushParagraph() {
    if (!runsHaveText(current)) {
      if (!paragraphs.length) {
        current = [];
        return;
      }
      if (lastParagraphIsEmpty(paragraphs)) {
        current = [];
        return;
      }
      paragraphs.push([]);
      current = [];
      return;
    }
    paragraphs.push(current);
    current = [];
  }

  function addText(text) {
    const decoded = decodeHtmlEntities(text).replace(/\n/g, ' ').replace(/[ \t]+/g, ' ');
    if (!decoded) return;
    const st = styleStack[styleStack.length - 1];
    if (!decoded.trim()) {
      if (runsHaveText(current)) mergeRunInto(current, ' ', st);
      return;
    }
    let chunk = decoded;
    if (!runsHaveText(current)) chunk = chunk.replace(/^\s+/, '');
    if (!chunk) return;
    mergeRunInto(current, chunk, st);
  }

  function hardBreak() {
    if (runsHaveText(current)) {
      flushParagraph();
      return;
    }
    if (!paragraphs.length) return;
    if (!lastParagraphIsEmpty(paragraphs)) paragraphs.push([]);
  }

  tokens.forEach((token) => {
    if (token.charAt(0) !== '<') {
      addText(token);
      return;
    }
    const isClose = /^<\s*\//.test(token);
    const nameMatch = token.match(/^<\s*\/?\s*([a-zA-Z0-9]+)/);
    const tag = nameMatch ? nameMatch[1].toLowerCase() : '';
    if (!tag) return;
    const selfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(tag);

    if (isClose) {
      if (tag === 'li' || BLOCK_TAGS.has(tag)) flushParagraph();
      if (styleStack.length > 1) styleStack.pop();
      return;
    }

    if (tag === 'br') {
      hardBreak();
      return;
    }

    if (tag === 'img') {
      if (runsHaveText(current) || paragraphs.length) {
        flushParagraph();
        flushTextBlock();
      } else {
        current = [];
      }
      const meta = parseImgMeta(token);
      if (meta.src) blocks.push({ type: 'image', src: meta.src, widthPct: meta.widthPct });
      return;
    }

    const styleAttrMatch = token.match(/\sstyle\s*=\s*["']([^"']*)["']/i);
    const extra = styleFromTag(tag, styleAttrMatch ? styleAttrMatch[1] : '');
    if (!selfClosing) {
      styleStack.push(mergeStyle(styleStack[styleStack.length - 1], extra));
    }

    if (tag === 'li') {
      if (runsHaveText(current)) flushParagraph();
      mergeRunInto(current, '\u2022 ', styleStack[styleStack.length - 1]);
    } else if (BLOCK_TAGS.has(tag)) {
      if (runsHaveText(current)) flushParagraph();
    }
  });

  flushParagraph();
  flushTextBlock();

  if (!blocks.length && plainFallback) {
    return htmlToStyledBlocks('', plainFallback);
  }
  return blocks;
}

function collapseEmptyParagraphs(paragraphs) {
  while (paragraphs.length && !runsHaveText(paragraphs[0])) paragraphs.shift();
  while (paragraphs.length && !runsHaveText(paragraphs[paragraphs.length - 1])) paragraphs.pop();
  for (let i = paragraphs.length - 2; i >= 0; i -= 1) {
    if (!runsHaveText(paragraphs[i]) && !runsHaveText(paragraphs[i + 1])) {
      paragraphs.splice(i + 1, 1);
    }
  }
}

function styledBlocksToPlain(blocks) {
  return (blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) =>
      (b.paragraphs || [])
        .map((runs) => (runs || []).map((r) => r.text).join(''))
        .join('\n'),
    )
    .join('\n')
    .trim();
}

module.exports = {
  decodeHtmlEntities,
  htmlToStyledBlocks,
  styledBlocksToPlain,
  styleFromTag,
  parseStyle,
};
