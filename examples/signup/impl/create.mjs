// email, website and plan are constrained by the model; the service checks
// them before this body runs, so a typo never reaches the store.
export async function create(input, io) {
  const account = {
    id: io.new(),
    email: input.email,
    website: input.website || null,
    plan: input.plan || 'free',
    createdAt: new Date().toISOString(),
  };
  const stored = await io.insert('Account', account);
  return { result: stored };
}
