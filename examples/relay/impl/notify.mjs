// The body names a path and a payload; the host comes from the bind. Nothing
// here can spell an absolute URL: the adapter refuses one before the request.
export async function notify(input, io) {
  const receipt = await io.call('hook', 'POST', '/v1/notify', { label: input.label });
  return { result: receipt };
}
