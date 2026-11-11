// The service owns the conversation; the model only turns messages into a
// reply. History is capped so a long thread still fits the model's context.
const CHAT_SYSTEM = 'Ты полезный ассистент. Отвечай кратко и по делу.';
const CHAT_LIMIT = 40;

export async function send(input, io) {
  const text = String(input.text || '').trim();
  if (!text) return { error: 'Invalid' };

  const raw = await io.load(input.id);
  if (!raw) return { error: 'NotFound' };

  let messages = [];
  try {
    const parsed = JSON.parse(raw.b);
    if (parsed && Array.isArray(parsed.messages)) messages = parsed.messages;
  } catch (error) {}

  const clean = messages
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
    .slice(-CHAT_LIMIT);

  const userMessage = { role: 'user', text };
  const history = clean.concat([userMessage]);

  let reply;
  try {
    reply = await io.chat(history.map((item) => ({ role: item.role, content: item.text })), CHAT_SYSTEM);
  } catch (error) {
    // Keep what the user wrote even when the model is unreachable.
    await io.save(input.id, { b: JSON.stringify({ messages: history }), h: raw.h });
    return { error: 'Unavailable' };
  }

  const assistant = { role: 'assistant', text: String(reply.content || '') };
  await io.save(input.id, { b: JSON.stringify({ messages: history.concat([assistant]).slice(-CHAT_LIMIT) }), h: raw.h });
  return { result: assistant };
}
