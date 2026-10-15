import type { Config } from '../config.js';
import type { QobuzProvider, QobuzStream, QobuzTrack, Quality } from '../types.js';
import { UpstreamError } from './http.js';

type JsonRecord = Record<string, unknown>;

/** Adapter for the public Qobuz-DL-compatible JSON API. */
export class QobuzDlProvider implements QobuzProvider {
  constructor(private readonly config: Config) {}

  async search(query: string, _quality: Quality, _atmos: string): Promise<QobuzTrack[]> {
    const body = await this.request('/api/get-music', { q: query, offset: '0' });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const tracks = data && isRecord(data.tracks) && Array.isArray(data.tracks.items) ? data.tracks.items : [];
    return tracks.filter(isRecord).map(toTrack).filter((track): track is QobuzTrack => track !== null);
  }

  async getStream(trackId: string, quality: Quality, _atmos: string): Promise<QobuzStream | null> {
    const body = await this.request('/api/download-music', { track_id: trackId, quality: qualityId(quality) });
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    const url = data && typeof data.url === 'string' ? data.url : undefined;
    if (!url || !/^https:\/\//i.test(url)) return null;
    // Forced to MP3 id 5 for mobile reliability: report truthful format/quality
    // so streamResponse does not infer FLAC from the requested LOSSLESS.
    return { url, manifest: 'none', encrypted: false, format: 'mp3', quality: 'HIGH' };
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.config.apiBaseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.upstreamRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
        let body: unknown;
        try { body = await response.json(); } catch { throw new UpstreamError(502, 'Qobuz-DL provider returned invalid JSON'); }
        if (!response.ok) {
          const error = new UpstreamError(retryableStatus(response.status) ? 502 : response.status === 404 ? 404 : 400, upstreamMessage(body));
          if (!retryableStatus(response.status) || attempt >= this.config.upstreamRetries) throw error;
          lastError = error;
        } else if (isRecord(body) && body.success === false) {
          const error = new UpstreamError(502, upstreamMessage(body));
          if (attempt >= this.config.upstreamRetries) throw error;
          lastError = error;
        } else return body;
      } catch (error) {
        if (error instanceof UpstreamError) {
          if (error.status !== 502 || attempt >= this.config.upstreamRetries) throw error;
        }
        lastError = error;
      } finally { clearTimeout(timeout); }
      await delay(200 * 2 ** attempt);
    }
    throw lastError instanceof UpstreamError ? lastError : new UpstreamError(502, 'Qobuz-DL provider request failed');
  }
}

function retryableStatus(status: number): boolean { return status === 408 || status === 425 || status === 429 || status >= 500; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function qualityId(_quality: Quality): string {
  // Echo 1.4.3 has no addon settings UI and always requests LOSSLESS.
  // The LOSSLESS rendition (id 27) is ~133MB per track and fails on mobile
  // with ExoPlayer IO_NETWORK_CONNECTION_FAILED / unexpected end of stream.
  // Force MP3 (id 5, ~15MB) for reliable mobile playback.
  return '5';
}

function toTrack(raw: JsonRecord): QobuzTrack | null {
  const id = raw.id;
  const title = raw.title;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof title !== 'string' || !title.trim()) return null;
  const album = isRecord(raw.album) ? raw.album : undefined;
  const performer = isRecord(raw.performer) ? raw.performer : undefined;
  const image = album && isRecord(album.image) ? album.image : undefined;
  const artworkURL = image && typeof image.large === 'string' ? image.large : undefined;
  const maxBitDepth = typeof raw.maximum_bit_depth === 'number' ? raw.maximum_bit_depth : undefined;
  return {
    upstreamId: String(id), title: title.trim(),
    artist: performer && typeof performer.name === 'string' ? performer.name : undefined,
    album: album && typeof album.title === 'string' ? album.title : undefined,
    duration: typeof raw.duration === 'number' ? raw.duration : undefined,
    artworkURL, format: maxBitDepth ? 'flac' : undefined,
    audioQuality: maxBitDepth ? 'LOSSLESS' : undefined,
  };
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null; }
function upstreamMessage(body: unknown): string {
  if (isRecord(body) && typeof body.error === 'string') return `Qobuz-DL upstream error: ${body.error}`;
  return 'Qobuz-DL upstream request failed';
}
