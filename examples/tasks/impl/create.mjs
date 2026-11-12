// A task is born open: the store fills nothing in, the body owns the defaults.
export async function create(input, io) {
  const title = String(input.title || '').trim();
  if (!title) return { error: 'Invalid' };
  const priority = Number(input.priority);
  const task = {
    id: io.new(),
    title,
    status: 'open',
    priority: Number.isFinite(priority) ? priority : 0,
    createdAt: new Date().toISOString(),
    dueAt: input.dueAt || null,
    doneAt: null,
  };
  // Throws Conflict when another task already claimed this title.
  await io.insert('Task', task);
  return { result: task };
}
