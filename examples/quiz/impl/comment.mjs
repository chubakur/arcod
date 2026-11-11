// Comments are capped per slide: a room of five hundred people must not turn
// one slide into an unbounded list.
export async function comment(input, io) {
  const rec = await io.load(String(input.id || ''));
  if (!rec) return { error: 'NotFound' };
  const session = rec.b;
  const token = String(input.token || '');
  const member = session.members[token];
  if (!member) return { error: 'Forbidden' };

  const text = String(input.text || '').trim();
  if (!text || text.length > 500) return { error: 'Invalid' };

  const key = String(session.index);
  const list = session.comments[key] || (session.comments[key] = []);
  list.push({ name: member.name, text });
  if (list.length > 200) list.splice(0, list.length - 200);
  await io.save(String(input.id), { b: session, h: rec.h });
  await io.publish('room:' + session.code, { type: 'changed', index: session.index });
  return { result: { ok: true } };
}
