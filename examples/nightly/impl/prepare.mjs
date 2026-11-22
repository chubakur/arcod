export async function prepare(input, io) {
  const label = String(input.label || 'nightly');
  return { result: await io.insert('Snapshot', { id: io.new(), label, takenAt: new Date().toISOString() }) };
}
