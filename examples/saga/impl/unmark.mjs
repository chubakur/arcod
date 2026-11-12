// Compensation for mark: remove every marker with this label, so the saga's
// partial progress is undone. Runs in reverse order when a later step fails.
export async function unmark(input, io) {
  const label = String(input.label || '').trim();
  const page = await io.find('Marker', { where: { label } });
  const items = page.items || [];
  for (const item of items) await io.remove('Marker', item.id);
  return { result: items.length };
}
