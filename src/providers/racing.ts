import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';

interface Source { name: string; provider: QobuzProvider }

/**
 * A source is gone when the upstream answers 404 for every route, which is what
 * a decommissioned backend does. Such a source must not poison the race: the
 * remaining sources are still usable.
 */
function isDeadBackend(error: unknown): boolean {
  const candidate = error as { status?: unknown; statusCode?: unknown } | undefined;
  const status = typeof candidate?.statusCode === 'number'
    ? candidate.statusCode
    : typeof candidate?.status === 'number'
      ? candidate.status
      : undefined;
  return status === 404;
}

export class RacingProvider implements QobuzProvider {
  constructor(private readonly sources: Source[]) {}

  async search(query: string, quality: Quality, atmos: string): Promise<QobuzTrack[]> {
    return new Promise((resolve, reject) => {
      let pending = this.sources.length;
      let lastError: unknown;
      for (const source of this.sources) {
        source.provider.search(query, quality, atmos).then(tracks => {
          if (tracks.length > 0) {
            resolve(tracks.map(track => ({ ...track, upstreamId: `${source.name}:${track.upstreamId}` })));
            return;
          }
          pending -= 1;
          if (pending === 0) resolve([]);
        }).catch(error => {
          if (isDeadBackend(error)) {
            // Retired upstream: drop it for this request instead of failing the
            // whole race when a healthy source could still answer.
            lastError = error;
            pending -= 1;
            if (pending === 0) resolve([]);
            return;
          }
          lastError = error;
          pending -= 1;
          if (pending === 0) reject(lastError);
        });
      }
    });
  }

  async getStream(trackId: string, quality: Quality, atmos: string): Promise<QobuzStream | null> {
    const separator = trackId.indexOf(':');
    if (separator <= 0) return null;
    const sourceName = trackId.slice(0, separator);
    const upstreamId = trackId.slice(separator + 1);
    const source = this.sources.find(candidate => candidate.name === sourceName);
    return source ? source.provider.getStream(upstreamId, quality, atmos) : null;
  }
}

/**
 * Builds the racing provider. `lastbabe` is optional: its upstream is currently
 * decommissioned (every route answers 404), so it is no longer part of the
 * default set. Set LASTBABE_BASE_URL to bring it back.
 */
export function createRacingProvider(qobuzdl: QobuzProvider, lastbabe?: QobuzProvider, optional?: QobuzProvider): QobuzProvider {
  const sources: Source[] = [
    { name: 'qobuzdl', provider: qobuzdl },
  ];
  if (optional) sources.unshift({ name: 'optional', provider: optional });
  if (lastbabe) sources.unshift({ name: 'lastbabe', provider: lastbabe });
  return new RacingProvider(sources);
}
