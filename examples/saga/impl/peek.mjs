export async function peek(input, io) {
  const label = String(input.label || '').trim();
  const page = await io.find('Marker', { where: { label } });
  return { result: (page.items || []).length };
}
