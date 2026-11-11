export async function users(input, io) {
  const actor = await io.actor();
  if (!actor) return { error: 'Unauthorized' };
  return { result: await io.users() };
}
