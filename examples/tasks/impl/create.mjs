// A task is born open: the schema default (done = false) is applied by the
// store on insert, so the body only sets values it actually decides.
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
  // Throws Conflict when another task already claimed this title. The store
  // returns the record it wrote, defaults included, and that is the response.
  const stored = await io.insert('Task', task);
  return { result: stored };
}
