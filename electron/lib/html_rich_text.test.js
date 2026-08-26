'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { htmlToStyledBlocks, styledBlocksToPlain } = require('./html_rich_text');

function textBlocks(html) {
  return htmlToStyledBlocks(html).filter((b) => b.type === 'text');
}

function paragraphTexts(html) {
  const blocks = textBlocks(html);
  assert.equal(blocks.length, 1);
  return blocks[0].paragraphs.map((runs) => runs.map((r) => r.text).join(''));
}

describe('htmlToStyledBlocks', () => {
  it('marks <b> / <strong> as bold', () => {
    const paras = textBlocks('<p>Hallo <b>Fettwort</b> Ende</p>')[0].paragraphs;
    assert.equal(paras.length, 1);
    const bold = paras[0].filter((r) => r.bold).map((r) => r.text);
    assert.deepEqual(bold, ['Fettwort']);
    assert.equal(styledBlocksToPlain(htmlToStyledBlocks('<p>Hallo <b>Fettwort</b> Ende</p>')), 'Hallo Fettwort Ende');
  });

  it('marks font-weight:bold spans as bold', () => {
    const paras = textBlocks(
      '<div>x <span style="font-weight: bold">FettCss</span> y</div>',
    )[0].paragraphs;
    const bold = paras[0].filter((r) => r.bold).map((r) => r.text.trim());
    assert.deepEqual(bold, ['FettCss']);
  });

  it('marks italic and underline', () => {
    const runs = textBlocks('<p><i>Kursivwort</i> <u>Unterwort</u></p>')[0].paragraphs[0];
    const italic = runs.find((r) => r.italic);
    const under = runs.find((r) => r.underline);
    assert.equal(italic && italic.text.trim(), 'Kursivwort');
    assert.equal(under && under.text.trim(), 'Unterwort');
  });

  it('does not insert spaces when stripping tags', () => {
    const texts = paragraphTexts('<p>foo<b>bar</b>baz</p>');
    assert.deepEqual(texts, ['foobarbaz']);
  });

  it('keeps a single break for <br>', () => {
    const texts = paragraphTexts('<p>oben<br>unten</p>');
    assert.deepEqual(texts, ['oben', 'unten']);
  });

  it('does not double-break Chromium <div><br></div>', () => {
    const texts = paragraphTexts('<div>Zeile</div><div><br></div><div>nächste</div>');
    assert.deepEqual(texts, ['Zeile', '', 'nächste']);
  });

  it('does not create extra paragraphs for nested spans', () => {
    const texts = paragraphTexts('<div>Hello <span>world</span> <span style="font-weight:bold">bold</span></div>');
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Hello world/);
  });

  it('splits <p>a</p><p>b</p> into two paragraphs without junk spaces', () => {
    const texts = paragraphTexts('<p>a</p><p>b</p>');
    assert.deepEqual(texts, ['a', 'b']);
  });

  it('prefixes list items with a bullet', () => {
    const texts = paragraphTexts('<ul><li>Eins</li><li>Zwei</li></ul>');
    assert.equal(texts.length, 2);
    assert.ok(texts[0].indexOf('\u2022') === 0);
    assert.match(texts[0], /Eins/);
    assert.match(texts[1], /Zwei/);
  });

  it('keeps images as separate blocks', () => {
    const blocks = htmlToStyledBlocks(
      '<p>vorher</p><img src="data:image/png;base64,aaa" style="width:50%"><p>nachher</p>',
    );
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[1].type, 'image');
    assert.equal(blocks[1].widthPct, 50);
    assert.equal(blocks[2].type, 'text');
  });
});
