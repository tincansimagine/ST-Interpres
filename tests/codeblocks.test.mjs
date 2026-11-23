import test from 'node:test';
import assert from 'node:assert/strict';
import { fencedBlocks, classifyBlock, sealCodeBlocks, pairBlocks, composeDisplay, stripMarks, togglePick, markIndex, hasFrontendDocument, splitChunks } from '../codeblocks.mjs';
import { sealWith, unsealText } from '../seal.mjs';

const seal = () => {
    const vault = [];
    return { vault, fn: (raw) => { vault.push(raw); return `<seal-${vault.length - 1}/>`; } };
};

test('fences are found by line, including unclosed and tilde fences, and inline backticks are not fences', () => {
    const t = 'a\n```html\n<b>x</b>\n```\nb\n~~~\nplain\n~~~\n```js `no`\n```py\nprint(1)';
    const b = fencedBlocks(t);
    assert.equal(b.length, 3);
    assert.equal(b[0].info, 'html');
    assert.equal(b[1].close, '~~~');
    assert.equal(b[2].close, null, 'an unclosed block runs to the end');
    assert.equal(b[2].info, 'py');
});

test('blocks are classified: real code is kept whole, screens expose only their words', () => {
    const [code, markup, plain, bare] = fencedBlocks('```js\nconst a = 1;\n```\n```\n<div class="hp">HP 30</div>\n```\n```\nMood: happy | Place: dock\n```\n```\nconst x = 1;\nlet y = 2;\nfunction z() {\n}\n```');
    assert.equal(classifyBlock(code), 'code');
    assert.equal(classifyBlock(markup), 'markup');
    assert.equal(classifyBlock(plain), 'plain');
    assert.equal(classifyBlock(bare), 'code', 'unlabelled code is still code');
});

test('markup blocks expose text only; neighbouring tags, styles and scripts share one seal', () => {
    const src = 'Hi.\n\n```html\n<style>.a{color:red}</style>\n<div class="a" title="x > y"><b>Name:</b> Aria</div>\n<script>alert(1)</script>\n```\nBye.';
    const { vault, fn } = seal();
    const out = sealCodeBlocks(src, fn);
    const exposed = out.replace(/<seal-\d+\/>/g, '');
    assert.equal(exposed.replace(/\s+/g, ' ').trim(), 'Hi. Name: Aria Bye.');
    assert.ok(!/color|class=|alert|```/.test(exposed));
    assert.ok(vault.length <= 5, `few seals (${vault.length})`);
    assert.equal(unsealText(out, vault).restored, src, 'sealing is lossless');
});

test('with code block translation off every block is sealed whole, unclosed ones too', () => {
    const src = 'x\n```\n<b>hp</b>\n```\ny\n```\nstill streaming';
    const { vault, fn } = seal();
    const out = sealCodeBlocks(src, fn, { translate: false });
    assert.equal(out, 'x\n<seal-0/>\ny\n<seal-1/>');
    assert.equal(unsealText(out, vault).restored, src);
});

test('code block sealing composes with the other seals (macros, images) and stays lossless', () => {
    const src = '{{char}} smiles.\n```\n<p>{{user}}, look</p><img src="a.png">\n```';
    const vault = [];
    const pre = sealCodeBlocks(src, raw => { vault.push(raw); return `<seal-${vault.length - 1}/>`; });
    const res = sealWith(pre, [/\{\{[^{}\n]*\}\}/g], vault);
    assert.ok(!/\{\{/.test(res.sealed));
    assert.equal(res.vault, vault, 'one vault for both stages');
    assert.equal(unsealText(res.sealed, vault).restored, src);
});

test('display composition: pick blocks back to the original, add marks only to translated blocks', () => {
    const original = 'He said hi.\n```\nHP: full\n```\n```js\nx()\n```\nEnd.';
    const translated = '그가 인사했다.\n```\nHP: 가득\n```\n```js\nx()\n```\n끝.';
    assert.equal(pairBlocks(original, translated).length, 2);
    assert.equal(composeDisplay(original, translated, [0]), '그가 인사했다.\n```\nHP: full\n```\n```js\nx()\n```\n끝.');
    const marked = composeDisplay(original, translated, [], { marks: true });
    assert.equal((marked.match(/ip-cb-/g) || []).length, 1, 'code blocks get no toggle');
    assert.match(marked, /인사했다\.\n\n<div class="ip-cb ip-cb-0"><\/div>\n\n```\nHP: 가득/);
    assert.equal(stripMarks(marked), translated);
    assert.equal(composeDisplay(original, '번역이 펜스를 잃었다'), '번역이 펜스를 잃었다', 'unpairable text is left as is');
    assert.deepEqual(togglePick([0], 0, 2), []);
    assert.deepEqual(togglePick([], 1, 2), [1]);
    assert.deepEqual(togglePick([], 5, 2), []);
    assert.equal(markIndex('custom-ip-cb custom-ip-cb-3'), 3);
    assert.equal(markIndex('other'), -1);
});

test('frontend documents are detected; long text splits on paragraph and line boundaries losslessly', () => {
    assert.equal(hasFrontendDocument('```html\n<!DOCTYPE html><html><body>x</body></html>\n```'), true);
    assert.equal(hasFrontendDocument('```\n<b>hp</b>\n```'), false);
    const text = Array.from({ length: 30 }, (_, i) => `문단 ${i} `.repeat(40)).join('\n\n');
    const chunks = splitChunks(text, 2000);
    assert.ok(chunks.length > 3);
    assert.ok(chunks.every(c => c.length <= 2000));
    assert.equal(chunks.join(''), text);
    const one = 'x'.repeat(100) + '\n' + 'y'.repeat(100);
    assert.equal(splitChunks(one, 120).join(''), one);
    assert.deepEqual(splitChunks('short', 6000), ['short']);
});
