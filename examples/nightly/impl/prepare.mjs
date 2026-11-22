// The first step's body: the snapshot a nightly run works from.
export async function prepare(input, io) {
  return { result: { label: 'nightly' } };
}
