// `docker info` is the probe both `arcod run` and `arcod run --down` use to
// tell "no docker" from "docker". It had no cap: a daemon that accepts the
// connection and then never answers (a wedged dockerd, a DOCKER_HOST pointing
// at a black-holed address) left the command hanging with no output at all.
import { spawnSync } from 'node:child_process';

/** How long the probe waits before it calls the daemon unresponsive. */
export const DOCKER_PROBE_MS = 15_000;

export type DockerProbe = { ok: true } | { ok: false; message: string };

type ProbeSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number },
) => { status: number | null; error?: (Error & { code?: string }) | undefined };

export function probeDocker(spawn: ProbeSpawn = spawnSync, timeoutMs = DOCKER_PROBE_MS): DockerProbe {
  const child = spawn('docker', ['info'], { stdio: 'ignore', timeout: timeoutMs });
  if (child.status === 0) return { ok: true };
  if (child.error?.code === 'ETIMEDOUT') {
    const waited = timeoutMs % 1000 === 0 ? timeoutMs / 1000 + 's' : timeoutMs + 'ms';
    return { ok: false, message: 'docker is not answering: `docker info` was still running after ' + waited };
  }
  return { ok: false, message: 'docker is not running or unavailable' };
}
