// The last step hands the report over; v0.1 has no delivery adapter here, so
// the receipt is the step's own word that the call ran. A string result on a
// POST is wrapped by the service into {id, expiresIn} (B60), which is not the
// declared type — a bool keeps the demo's contract and its response equal.
export async function send(input, io) {
  return { result: true };
}
