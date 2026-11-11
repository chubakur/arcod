// One answer per member per slide: a changed mind overwrites the previous
// choice instead of stacking up. Counts are computed on read.
export async function vote(input, io) {
  const rec = await io.load(String(input.id || ''));
  if (!rec) return { error: 'NotFound' };
  const session = rec.b;
  const token = String(input.token || '');
  if (!session.members[token]) return { error: 'Forbidden' };

  const choice = Number(input.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice > 20) return { error: 'Invalid' };

  const key = String(session.index);
  session.votes[key] = session.votes[key] || {};
  session.votes[key][token] = choice;
  await io.save(String(input.id), { b: session, h: rec.h });
  await io.publish('room:' + session.code, { type: 'changed', index: session.index });
  return { result: { ok: true } };
}
