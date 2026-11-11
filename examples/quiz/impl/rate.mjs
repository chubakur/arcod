export async function rate(input, io) {
  const rec = await io.load(String(input.id || ''));
  if (!rec) return { error: 'NotFound' };
  const session = rec.b;
  const token = String(input.token || '');
  if (!session.members[token]) return { error: 'Forbidden' };

  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1 || value > 10) return { error: 'Invalid' };

  const key = String(session.index);
  session.ratings[key] = session.ratings[key] || {};
  session.ratings[key][token] = value;
  await io.save(String(input.id), { b: session, h: rec.h });
  await io.publish('room:' + session.code, { type: 'changed', index: session.index });
  return { result: { ok: true } };
}
