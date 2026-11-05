/**
 * The hosts' own voices, synthesized on c0mpute rather than bought from a
 * hosted TTS vendor (Anthony 2026-11-05: "make sure you use c0mpute not eleven
 * labs").
 *
 * Each co-host speaks in the Kokoro voice named in its OpenProfile — riotcoder
 * is am_michael, cha0spunk is af_bella — through the c0mpute speech gateway's
 * warm sessions: `POST /v1/sessions` pins a worker with Kokoro already loaded,
 * and every `say` after that skips both the job auction and the model load. A
 * one-shot `/v1/tts` waits 4 s for auction bids before it even starts, which no
 * conversation can absorb; a warm session renders about half a second of speech
 * per second of wall clock, so a host stays ahead of its own playback.
 *
 * A rendered line lands in a short-lived cache under an HMAC-named path and is
 * served unauthenticated by `/speech/<token>.wav`, because the only thing that
 * ever fetches it is Telnyx's media loader, which carries no credentials of
 * ours. The token comes from a server secret and the line's id, so a path can
 * be neither guessed nor walked, and anything past its TTL is swept on the next
 * write.
 *
 * Everything here is allowed to fail: no gateway, an unreachable node, a synth
 * that dies — each returns null, and the caller falls back to the same Kokoro
 * weights rendered by Telnyx. A host must keep talking even when our own
 * network is having a bad day.
 */
import { createHmac } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Keep a rendered line only as long as a call needs to fetch it. */
export const TTL_MS = 10 * 60 * 1000

/** The longest line we ask a node to read in one go. */
const MAX_CHARS = 2000

/** Voices the gateway's Kokoro engine serves. */
export const KOKORO_VOICES = ['af_sarah', 'af_bella', 'af_nicole', 'am_onyx', 'am_michael', 'am_echo'] as const

/**
 * Each co-host's voice, as its OpenProfile declares it (the same map c0mpute
 * keeps in speech_profiles.rs). Voice presentation is an explicit synthetic
 * choice, not a claim about the agent.
 */
export const AGENT_VOICES: Record<string, string> = {
  riotcoder: 'am_michael',
  cha0spunk: 'af_bella',
  knox: 'af_sarah',
  rootkey: 'am_onyx',
}

export const DEFAULT_VOICE = 'am_michael'

/** The voice an agent speaks in, falling back to riotcoder's. */
export function voiceFor(agent: string): string {
  const voice = AGENT_VOICES[agent.trim().toLowerCase().replace(/^@/, '')]
  return voice && (KOKORO_VOICES as readonly string[]).includes(voice) ? voice : DEFAULT_VOICE
}

export type SpeechConfig = {
  /** The c0mpute speech gateway, e.g. http://127.0.0.1:8818 */
  baseUrl: string
  token: string
  /** Where rendered lines wait to be fetched. Never /tmp: that is quota-bound. */
  audioDir: string
  /** Signs the path token. */
  secret: string
  /** The origin Telnyx fetches from. */
  origin: string
  fetch?: typeof fetch
  log?: (line: string) => void
  /** How long one `say` may take before we give up on our own network. */
  timeoutMs?: number
}

export type SpokenLine = {
  /** The absolute URL to hand Telnyx. */
  url: string
  /** Seconds of audio, so a caller knows how long playback runs. */
  seconds: number
  /** What the node spent rendering it. */
  synthMs: number
  voice: string
}

type Session = { id: string; voice: string; utterances: number }

/** A path token nobody can guess or walk: 32 hex chars, no separators. */
export function audioToken(id: string, secret: string): string {
  return createHmac('sha256', secret).update(id).digest('hex').slice(0, 32)
}

/** How long a 16-bit PCM WAV runs. */
export function wavSeconds(wav: Uint8Array): number {
  if (wav.length < 44) return 0
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const rate = view.getUint32(24, true)
  const channels = view.getUint16(22, true) || 1
  const bits = view.getUint16(34, true) || 16
  const bytesPerFrame = (bits / 8) * channels
  if (!rate || !bytesPerFrame) return 0
  return Math.round(((wav.length - 44) / bytesPerFrame / rate) * 100) / 100
}

/** A WAV, not an error page: RIFF....WAVE, and long enough to be speech. */
function looksLikeSpeech(wav: Uint8Array): boolean {
  if (wav.length < 1024) return false
  const tag = (at: number, text: string) => String.fromCharCode(...wav.subarray(at, at + 4)) === text
  return tag(0, 'RIFF') && tag(8, 'WAVE')
}

export class Speech {
  /** One warm session per voice, reopened whenever the gateway loses it. */
  private sessions = new Map<string, Session>()
  private opening = new Map<string, Promise<Session | null>>()

  constructor(readonly config: SpeechConfig) {
    mkdirSync(this.dir, { recursive: true })
  }

  private get dir(): string {
    return join(this.config.audioDir, 'speech')
  }

  private get fetch(): typeof fetch {
    return this.config.fetch ?? fetch
  }

  private log(line: string): void {
    ;(this.config.log ?? console.log)(`otr: speech: ${line}`)
  }

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' }
  }

  private url(path: string): string {
    return this.config.baseUrl.replace(/\/+$/, '') + path
  }

  /** Pin a warm worker for `voice`, or null when the network cannot give us one. */
  private async open(voice: string): Promise<Session | null> {
    const pending = this.opening.get(voice)
    if (pending) return pending
    const attempt = (async () => {
      try {
        const res = await this.fetch(this.url('/v1/sessions'), {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ voice }),
          signal: AbortSignal.timeout(60_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { session?: string; load_ms?: number }
        if (!body.session) throw new Error('no session id')
        this.log(`warm session for ${voice} in ${body.load_ms ?? '?'} ms`)
        const session: Session = { id: body.session, voice, utterances: 0 }
        this.sessions.set(voice, session)
        return session
      } catch (e) {
        this.log(`could not open a ${voice} session: ${e instanceof Error ? e.message : e}`)
        return null
      } finally {
        this.opening.delete(voice)
      }
    })()
    this.opening.set(voice, attempt)
    return attempt
  }

  /** Warm both hosts' voices before an episode, so the first line is not the slow one. */
  async warm(agents: string[]): Promise<string[]> {
    const ready: string[] = []
    for (const agent of agents) {
      const voice = voiceFor(agent)
      if ((this.sessions.get(voice) ?? (await this.open(voice))) !== null) ready.push(voice)
    }
    return ready
  }

  /** Ask the pinned worker to read one line; null when it could not. */
  private async sayOnce(session: Session, text: string): Promise<{ wav: Uint8Array; synthMs: number } | 'gone' | null> {
    try {
      const res = await this.fetch(this.url(`/v1/sessions/${encodeURIComponent(session.id)}/say`), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
      })
      // The gateway restarted, or swept an idle session: open a new one and retry.
      if (res.status === 404 || res.status === 410) return 'gone'
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const wav = new Uint8Array(await res.arrayBuffer())
      return { wav, synthMs: Number(res.headers.get('x-c0mpute-synth-ms')) || 0 }
    } catch (e) {
      this.log(`say failed on ${session.voice}: ${e instanceof Error ? e.message : e}`)
      return null
    }
  }

  /**
   * Render `text` in `agent`'s own voice and cache it for Telnyx to fetch.
   *
   * `id` names the cache entry; the caller makes it unique per line (the call id
   * and a counter do nicely). Returns null whenever our own network cannot do
   * it, which is never an error: the caller speaks the line another way.
   */
  async say(agent: string, text: string, id: string): Promise<SpokenLine | null> {
    const line = text.trim()
    const voice = voiceFor(agent)
    if (!this.config.baseUrl || !this.config.token || !line || line.length > MAX_CHARS) return null

    let session = this.sessions.get(voice) ?? (await this.open(voice))
    if (!session) return null
    let said = await this.sayOnce(session, line)
    if (said === 'gone') {
      this.sessions.delete(voice)
      session = await this.open(voice)
      said = session ? await this.sayOnce(session, line) : null
    }
    if (!session || !said || said === 'gone' || !looksLikeSpeech(said.wav)) return null
    session.utterances += 1

    const token = audioToken(id, this.config.secret)
    try {
      await writeFile(join(this.dir, `${token}.wav`), said.wav)
    } catch (e) {
      this.log(`could not cache ${token}: ${e instanceof Error ? e.message : e}`)
      return null
    }
    void this.sweep()
    return {
      url: `${this.config.origin.replace(/\/+$/, '')}/speech/${token}.wav`,
      seconds: wavSeconds(said.wav),
      synthMs: said.synthMs,
      voice,
    }
  }

  /** Read a cached line back out, by the token in its URL. */
  async read(token: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{32}$/.test(token)) return null
    try {
      const bytes = new Uint8Array(await readFile(join(this.dir, `${token}.wav`)))
      return bytes.length > 44 ? bytes : null
    } catch {
      return null
    }
  }

  /** Drop rendered lines past their TTL, so the cache cannot grow without bound. */
  async sweep(now = Date.now()): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith('.wav'))
        .map(async (name) => {
          const path = join(this.dir, name)
          try {
            const info = await stat(path)
            if (now - info.mtimeMs > TTL_MS) await unlink(path)
          } catch {
            // Someone else swept it, or it is being written. Either is fine.
          }
        }),
    )
  }

  /** What is pinned right now, for `otr voices`. */
  async list(): Promise<unknown> {
    try {
      const res = await this.fetch(this.url('/v1/sessions'), { headers: this.headers, signal: AbortSignal.timeout(15_000) })
      return await res.json()
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Let the pinned workers go when an episode is over. */
  async close(): Promise<void> {
    for (const [voice, session] of [...this.sessions]) {
      this.sessions.delete(voice)
      await this.fetch(this.url(`/v1/sessions/${encodeURIComponent(session.id)}`), { method: 'DELETE', headers: this.headers }).catch(() => {})
    }
  }
}
