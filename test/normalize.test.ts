import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrack, streamResponse, upstreamIdFromPublicId } from '../src/normalize.js';
import { TtlCache } from '../src/cache.js';
import { RacingProvider, createRacingProvider } from '../src/providers/racing.js';
import { UpstreamError } from '../src/providers/http.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../src/types.js';

test('normalizes a track to an opaque stable id', () => {
  const track = normalizeTrack({ upstreamId: '123', title: 'Song', artist: 'Artist', artworkURL: 'https://cdn.example/a.jpg' });
  assert.match(track.id, /^qobuz_[A-Za-z0-9_-]+$/);
  assert.equal(track.title, 'Song');
  assert.equal(upstreamIdFromPublicId(track.id), '123');
});

test('signed IDs reject tampering', () => {
  const id = normalizeTrack({ upstreamId: '123', title: 'Song' }).id;
  assert.equal(upstreamIdFromPublicId(`${id.slice(0, -1)}x`), undefined);
});

test('cache exposes stale values for outage fallback', async () => {
  const cache = new TtlCache<string>(1);
  cache.set('key', 'value');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cache.get('key'), undefined);
  assert.equal(cache.getStale('key'), 'value');
});

test('drops non-absolute artwork URLs', () => {
  assert.equal(normalizeTrack({ upstreamId: '123', title: 'Song', artworkURL: '/cover.jpg' }).artworkURL, undefined);
});

test('rejects encrypted or non-HTTPS streams', () => {
  assert.throws(() => streamResponse({ url: 'https://cdn.example/a.flac', encrypted: true }, 'LOSSLESS'));
  assert.throws(() => streamResponse({ url: 'http://cdn.example/a.flac' }, 'LOSSLESS'));
});

class StubProvider implements QobuzProvider {
  constructor(private readonly tracks: QobuzTrack[] | Error) {}
  async search(): Promise<QobuzTrack[]> {
    if (this.tracks instanceof Error) throw this.tracks;
    return this.tracks;
  }
  async getStream(): Promise<QobuzStream | null> { return null; }
}

test('a decommissioned backend does not fail the race', async () => {
  const provider = new RacingProvider([
    { name: 'dead', provider: new StubProvider(new UpstreamError(404, 'not found')) },
    { name: 'alive', provider: new StubProvider([{ upstreamId: '7', title: 'Song' }]) },
  ]);
  const tracks = await provider.search('song', 'LOSSLESS', 'auto');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].upstreamId, 'alive:7');
});

test('every backend dead resolves empty instead of rejecting', async () => {
  const provider = new RacingProvider([
    { name: 'dead', provider: new StubProvider(new UpstreamError(404, 'not found')) },
  ]);
  assert.deepEqual(await provider.search('song', 'LOSSLESS', 'auto'), []);
});

test('a transient upstream failure still surfaces', async () => {
  const provider = new RacingProvider([
    { name: 'broken', provider: new StubProvider(new UpstreamError(502, 'bad gateway')) },
  ]);
  await assert.rejects(() => provider.search('song', 'LOSSLESS', 'auto'));
});

test('LastBabe is opt-in so the default race stays small', () => {
  const provider = createRacingProvider(new StubProvider([])) as RacingProvider;
  const names = (provider as unknown as { sources: { name: string }[] }).sources.map(s => s.name);
  assert.deepEqual(names, ['qobuzdl']);
});
