import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeProxyUrl, buildProxyRequest, requestReverseProxy } from '../reverse-proxy.mjs';

const config = (provider = 'openai') => ({ provider, url: 'https://proxy.example.test', key: 'proxy-secret', model: 'test-model', temperature: 0.4 });
test('provider URLs preserve prefixes and remove generation suffixes', () => {
    for (const [url, provider, expected] of [
        ['https://host.test/', 'openai', 'https://host.test/v1'],
        ['https://host.test/prefix/v1/chat/completions/', 'openai', 'https://host.test/prefix/v1'],
        ['https://host.test/anthropic/v1/messages', 'claude', 'https://host.test/anthropic/v1'],
        ['https://host.test/', 'claude', 'https://host.test/v1'],
        ['https://host.test/google/v1beta/', 'makersuite', 'https://host.test/google'],
        ['http://localhost:5000', 'makersuite', 'http://localhost:5000'],
    ]) assert.equal(normalizeProxyUrl(url, provider), expected);
});
test('invalid URL or provider fails before any request', () => {
    for (const url of ['', 'bad', 'file:///etc/test', 'https://user:secret@host.test', 'https://host.test?key=secret', 'https://host.test/#x']) {
        assert.throws(() => normalizeProxyUrl(url, 'openai'));
    }
    assert.throws(() => normalizeProxyUrl('https://host.test', 'unknown'));
    assert.throws(() => normalizeProxyUrl('https://host.test/v1beta/models/gemini:generateContent', 'makersuite'));
    assert.throws(() => buildProxyRequest({ ...config(), model: '' }, 's', 'u', 100));
});
test('all providers build server requests; Claude prefill is not duplicated', () => {
    for (const provider of ['openai', 'claude', 'makersuite']) {
        const body = buildProxyRequest(config(provider), 'system', 'user', 512, 'prefill');
        assert.equal(body.chat_completion_source, provider);
        assert.equal(body.proxy_password, 'proxy-secret');
        assert.equal(body.max_tokens, 512);
        assert.equal(body.stream, false);
        assert.equal(body.messages.length, provider === 'claude' ? 2 : 3);
        if (provider === 'claude') {
            assert.equal(body.assistant_prefill, 'prefill');
            assert.equal(body.use_sysprompt, true);
        }
        const scan = buildProxyRequest(config(provider), 'system', 'user', 512);
        assert.equal(scan.messages.length, 2);
        assert.ok(!scan.assistant_prefill);
    }
});
test('transport uses ST endpoint and CSRF headers, keeping proxy credentials in request body', async () => {
    let calls = 0;
    const result = await requestReverseProxy(config(), 'system', 'user', 512, '', { 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }, async (url, options) => {
        calls++;
        assert.equal(url, '/api/backends/chat-completions/generate');
        assert.equal(options.headers['X-CSRF-Token'], 'csrf');
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(JSON.parse(options.body).proxy_password, 'proxy-secret');
        return { ok: true, json: async () => ({ choices: [{ message: { content: '번역' } }] }) };
    });
    assert.equal(calls, 1);
    assert.equal(result, '번역');
});
test('Claude thinking blocks are omitted and all text blocks preserved', async () => {
    const cfg = config('claude');
    const result = await requestReverseProxy(cfg, 's', 'u', 512, '', {}, async () => {
        cfg.provider = 'openai'; // settings edits during the request must not change response parsing
        return { ok: true, json: async () => ({ content: [
            { type: 'thinking', thinking: 'private thought' },
            { type: 'text', text: '첫째' }, { type: 'text', text: '둘째' },
        ] }) };
    });
    assert.equal(result, '첫째\n둘째');
});
test('HTTP errors, HTTP-200 API errors and empty responses reject', async () => {
    for (const response of [
        { ok: false, status: 401, json: async () => ({ error: { message: 'proxy-secret' } }) },
        { ok: true, status: 200, json: async () => ({ error: true }) },
        { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' } }] }) },
        { ok: false, status: 502, json: async () => { throw new Error('html'); } },
    ]) {
        await assert.rejects(requestReverseProxy(config(), 's', 'u', 512, '', {}, async () => response), error => !error.message.includes('proxy-secret'));
    }
    await assert.rejects(requestReverseProxy(config(), 's', 'u', 512, '', {}, async () => {
        throw Object.assign(new Error('abort'), { name: 'AbortError' });
    }), /대기 시간이 초과/);
});
test('translator routes proxy requests and suppresses prefill for scans and connection tests', async () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = src.indexOf('async function callTranslator(');
    const end = src.indexOf('\n/**', start);
    const calls = [];
    const context = vm.createContext({
        getSettings: () => ({ apiMode: 'proxy', reverseProxy: config(), prefill: 'prefix', responseTokens: 2048 }),
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
        requestReverseProxy: async (...args) => { calls.push(args); return 'OK'; },
    });
    vm.runInContext(src.slice(start, end), context);
    assert.equal(await context.callTranslator('s', 'u'), 'OK');
    assert.equal(calls[0][4], 'prefix');
    await context.callTranslator('s', 'u', { usePrefill: false, maxTokens: 512 });
    assert.equal(calls[1][3], 512);
    assert.equal(calls[1][4], '');
});
