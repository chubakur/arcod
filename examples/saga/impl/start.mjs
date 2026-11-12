export async function start(input, io) {
  const label = String(input.label || '').trim();
  if (!label) return { error: 'Invalid' };
  await io.queuePublish('checkout', { label });
  return { result: 'started' };
}
