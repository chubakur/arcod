// Always fails: drives the saga into its compensation path in the tests.
export async function boom(input, io) {
  return { error: 'Invalid' };
}
