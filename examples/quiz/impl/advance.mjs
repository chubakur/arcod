// Only the host moves the deck. The page sends its own slide count: the deck
// is declared in the model, so the service cannot know how long it is.
export async function advance(input, io) {
  const rec = await io.load(String(input.id || ''));
  if (!rec) return { error: 'NotFound' };
  const session = rec.b;
  if (String(input.token || '') !== session.token) return { error: 'Forbidden' };

  const delta = Number(input.delta);
  const total = Number(input.total);
  if (!Number.isInteger(delta) || delta === 0) return { error: 'Invalid' };
  if (!Number.isInteger(total) || total < 1 || total > 200) return { error: 'Invalid' };

  const next = Math.min(Math.max(session.index + delta, 0), total - 1);
  if (next !== session.index) {
    session.index = next;
    await io.save(String(input.id), { b: session, h: rec.h });
  }
  return { result: { ok: true, index: next } };
}
