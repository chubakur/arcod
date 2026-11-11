export async function history(input, io) {
  const raw = await io.load(input.id);
  if (!raw) return { error: 'NotFound' };
  try {
    const parsed = JSON.parse(raw.b);
    return { result: parsed && Array.isArray(parsed.messages) ? parsed.messages : [] };
  } catch (error) {
    return { result: [] };
  }
}
