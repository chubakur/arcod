// Reference plugin adapter (B11.4): proves the manifest -> copy -> dispatch
// seam end to end without a network. The generated service imports this file
// and calls createAdapter once; the returned object answers the capability's
// declared signatures.
import { appendFile } from 'node:fs/promises';

export function createAdapter(io) {
  const path = io.env.NOTIFY_PATH || '';
  return {
    async send(to, text) {
      if (path) await appendFile(path, String(to) + '\t' + String(text) + '\n');
      return 'queued:' + to;
    },
  };
}
