// @arcod generated: op list · prompt 32493405e30c · model qwen2.5-coder:7b
export async function list(input, io) {
  const { status } = input;
  const actor = await io.actor();
  if (!actor) return { error: 'Unauthorized' };

  let items = await io.scan();
  items = items.filter(item => item.b && item.b.owner === actor.id);
  if (status) items = items.filter(item => item.b.status === status);
  items = items.map(item => item.b);

  return { result: items };
}