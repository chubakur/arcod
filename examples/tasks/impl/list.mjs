// The query travels to the adapter whole: the body never sorts or slices.
export async function list(input, io) {
  const limit = input.limit == null ? 20 : Number(input.limit);
  if (!Number.isFinite(limit) || limit < 1) return { error: 'Invalid' };
  const where = {};
  if (input.status) where.status = String(input.status);
  const page = await io.find('Task', {
    where,
    order: input.sort || 'priority desc, createdAt asc',
    limit,
    cursor: input.cursor || null,
  });
  return { result: page };
}
