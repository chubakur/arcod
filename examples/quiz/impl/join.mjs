// A guest gets a personal token: the host token is never shared, and every
// answer is attributed to whoever sent it.
export async function join(input, io) {
  const name = String(input.name || '').trim().slice(0, 40);
  if (!name) return { error: 'Invalid' };
  const code = String(input.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) return { error: 'NotFound' };

  const pointer = await io.load('code:' + code);
  if (!pointer) return { error: 'NotFound' };
  const rec = await io.load(pointer.b.id);
  if (!rec) return { error: 'NotFound' };

  const session = rec.b;
  if (Object.keys(session.members).length >= 500) return { error: 'Invalid' };

  const token = await io.new();
  session.members[token] = { name };
  await io.save(pointer.b.id, { b: session, h: rec.h });
  await io.publish('room:' + code, { type: 'changed', index: session.index });
  return { result: { id: pointer.b.id, token, name } };
}
