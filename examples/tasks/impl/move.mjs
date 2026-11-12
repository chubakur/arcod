export async function move(input, io) {
  const id = String(input.id || '');
  const status = String(input.status || '');
  if (!id || !status) return { error: 'Invalid' };
  const patch = { status };
  if (status === 'done') patch.doneAt = new Date().toISOString();
  // NotFound comes from the adapter when the record is gone.
  const task = await io.update('Task', id, patch);
  return { result: task };
}
