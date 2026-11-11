export async function users(input, io) {
  // Anonymous callers were rejected by the runtime guard (401).
  return { result: await io.users() };
}
