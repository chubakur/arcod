// The whole live state of a room in one answer, so both views poll the same
// operation and never guess what the other side is doing.
export async function state(input, io) {
  const rec = await io.load(String(input.id || ''));
  if (!rec) return { error: 'NotFound' };
  const session = rec.b;
  const token = String(input.token || '');
  if (token !== session.token && !session.members[token]) return { error: 'Forbidden' };

  const key = String(session.index);
  const counts = [];
  for (const value of Object.values(session.votes[key] || {})) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0) continue;
    counts[index] = (counts[index] || 0) + 1;
  }
  const ratings = Object.values(session.ratings[key] || {})
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 10);
  const comments = (session.comments[key] || [])
    .slice(-50)
    .map((item) => ({ name: item.name, text: item.text }));

  return {
    result: {
      index: session.index,
      counts: Array.from({ length: counts.length }, (_, i) => counts[i] || 0),
      average: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null,
      rated: ratings.length,
      comments,
      joined: Object.keys(session.members).length,
    },
  };
}
