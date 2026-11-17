export async function list(input, io) {
  // io.scan() walks the store: every record holds the note under .b.
  const items = await io.scan();
  const notes = [];
  for (const item of items) {
    const note = item.b;
    if (note && typeof note.text === 'string') notes.push({ id: item.id, text: note.text });
  }
  notes.sort((left, right) => String(left.text).localeCompare(String(right.text)));
  return { result: notes };
}
