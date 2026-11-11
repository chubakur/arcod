// OpenAI-compatible chat client, hand-written: the generated service stays
// dependency-free and works with a local model or a cloud endpoint.
export const LLM_SOURCE = `// ---------- llm ----------

let LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://host.docker.internal:11434/v1';
while (LLM_BASE_URL.endsWith('/')) LLM_BASE_URL = LLM_BASE_URL.slice(0, -1);
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5-coder:7b';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180000);

function llmModel() {
  return LLM_MODEL;
}

async function llmChat(messages, system) {
  const list = Array.isArray(messages) ? messages : [];
  const payload = {
    model: LLM_MODEL,
    messages: system
      ? [{ role: 'system', content: String(system) }].concat(list)
      : list,
    stream: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(LLM_BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json' },
        LLM_API_KEY ? { authorization: 'Bearer ' + LLM_API_KEY } : {},
      ),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error('llm: ' + response.status + ' ' + text.slice(0, 300));
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error('llm: invalid json: ' + text.slice(0, 200));
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (typeof content !== 'string') throw new Error('llm: no content in response');
    return { content, model: data.model || LLM_MODEL };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('llm: timeout after ' + LLM_TIMEOUT_MS + 'ms');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
`;
