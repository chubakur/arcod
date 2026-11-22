export async function render(input, io) {
  const stored = await io.fetch('Snapshot', input.snapshot.id);
  if (!stored) return { error: 'NotFound' };
  return { result: { rows: stored.label.length, snapshot: stored.id } };
}
