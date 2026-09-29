export function normalizeProxyUrl(value, provider) {
    if (!['openai', 'claude', 'makersuite'].includes(provider)) throw new Error('지원하지 않는 프록시 API 형식입니다.');
    let url;
    try { url = new URL(String(value || '').trim()); }
    catch { throw new Error('리버스 프록시의 올바른 http(s) 주소를 입력하세요.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('프록시 주소에는 http(s) 기본 URL을 입력하세요. 인증값은 별도 입력란을 사용하세요.');
    }
    let path = url.pathname.replace(/\/+$/, '');
    if (provider === 'openai') path = path.replace(/\/chat\/completions$/, '');
    if (provider === 'claude') path = path.replace(/\/messages$/, '');
    if (provider === 'makersuite') {
        if (/\/models\//.test(path)) throw new Error('Gemini는 모델별 요청 주소 대신 프록시 기본 URL을 입력하세요.');
        path = path.replace(/\/v1(?:beta)?$/, '');
    } else if (!path) path = '/v1';
    url.pathname = path;
    return url.toString().replace(/\/$/, '');
}

export function buildProxyRequest(cfg, systemPrompt, userPrompt, tokens, prefill = '') {
    const reverse_proxy = normalizeProxyUrl(cfg.url, cfg.provider);
    const model = String(cfg.model || '').trim();
    if (!model) throw new Error('프록시에서 사용할 모델명을 입력하세요.');
    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }];
    // Claude's server adapter handles its own assistant prefill.
    if (prefill.trim() && cfg.provider !== 'claude') messages.push({ role: 'assistant', content: prefill });
    return {
        chat_completion_source: cfg.provider,
        reverse_proxy, proxy_password: String(cfg.key || ''), model, messages,
        max_tokens: tokens, stream: false,
        temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.3,
        ...(cfg.provider === 'claude' ? { use_sysprompt: true, assistant_prefill: prefill } : {}),
    };
}

export async function requestReverseProxy(cfg, systemPrompt, userPrompt, tokens, prefill, headers, fetchFn = fetch) {
    cfg = { ...cfg };
    const body = buildProxyRequest(cfg, systemPrompt, userPrompt, tokens, prefill);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(10, Number(cfg.timeoutSec) || 120) * 1000);
    try {
        const response = await fetchFn('/api/backends/chat-completions/generate', {
            method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body),
        });
        let data;
        try { data = await response.json(); }
        catch { throw new Error(`프록시 응답을 읽지 못했습니다 (HTTP ${response.status}). SillyTavern 서버 로그와 프록시 주소를 확인하세요.`); }
        if (!response.ok || data?.error) {
            // Do not echo a provider error body: it may contain credentials or prompts.
            throw new Error(`리버스 프록시 요청 실패 (HTTP ${response.status}). API 형식·주소·인증값·모델명을 확인하세요. 자세한 원인은 SillyTavern 서버 로그에서 확인할 수 있습니다.`);
        }
        // Claude can return thinking blocks before text; ST also preserves the original blocks.
        const content = cfg.provider === 'claude' && Array.isArray(data.content)
            ? data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
            : data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
            throw new Error('프록시가 번역 본문 없이 응답했습니다. 응답 토큰 한도와 모델의 추론 설정을 확인하세요.');
        }
        return content;
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('프록시 응답 대기 시간이 초과되었습니다. 잠시 후 다시 시도하세요.');
        throw e;
    } finally { clearTimeout(timeout); }
}
