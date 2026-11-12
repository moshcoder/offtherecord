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

/** Voices the gateway's Kokoro engine serves (the fallback). */
export const KOKORO_VOICES = ['af_sarah', 'af_bella', 'af_nicole', 'am_onyx', 'am_michael', 'am_echo'] as const

/** Voices the gateway's Pocket engine serves (the default). */
export const POCKET_VOICES = ['alba', 'anna', 'caro_davy', 'marius', 'javert', 'bill_boerst', 'peter_yearsley', 'stuart_bell'] as const

/**
 * Each agent's DEFAULT voice: Pocket TTS, as c0mpute's speech_profiles.rs
 * names it. Pocket replaced Kokoro on 2026-11-11 (Anthony: "its still
 * computerish. we need to be more human ... use that for default voices
 * everywhere"). Voice presentation is an explicit synthetic choice, not a
 * claim about the agent.
 */
export const AGENT_VOICES: Record<string, string> = {
  riotcoder: 'bill_boerst',
  cha0spunk: 'caro_davy',
  knox: 'stuart_bell',
  rootkey: 'javert',
  coinpay: 'marius',
}

/** The Kokoro voice each agent drops to when no Pocket worker can speak. */
export const FALLBACK_VOICES: Record<string, string> = {
  riotcoder: 'am_michael',
  cha0spunk: 'af_bella',
  knox: 'af_sarah',
  rootkey: 'am_onyx',
  coinpay: 'am_echo',
}

/** Agents with an expressive GPU voice (c0mpute engine "chatterbox", voice = slug). */
export const GPU_VOICES = ['riotcoder', 'cha0spunk', 'rootkey', 'knox', 'coinpay', 'nora', 'quill']

export const DEFAULT_VOICE = 'bill_boerst'
export const DEFAULT_FALLBACK_VOICE = 'am_michael'

const agentKey = (agent: string) => agent.trim().toLowerCase().replace(/^@/, '')

/** The voice an agent speaks in by default (Pocket), falling back to riotcoder's. */
export function voiceFor(agent: string): string {
  const voice = AGENT_VOICES[agentKey(agent)]
  return voice && (POCKET_VOICES as readonly string[]).includes(voice) ? voice : DEFAULT_VOICE
}

/** The agent's Kokoro voice, used when Pocket is unavailable. */
export function fallbackVoiceFor(agent: string): string {
  const voice = FALLBACK_VOICES[agentKey(agent)]
  return voice && (KOKORO_VOICES as readonly string[]).includes(voice) ? voice : DEFAULT_FALLBACK_VOICE
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
  /** How much it was levelled up by, in dB. */
  gainDb?: number
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

/**
 * How hot a line is sent down the phone: peak ceiling and RMS target, in dBFS.
 *
 * Kokoro renders well below the level a hosted TTS sends, and on a conference
 * bridge that is the difference between a host you can hear and one you cannot
 * (Anthony, on air, 2026-11-05: "voice are not loud enough on group call"). So
 * every line is levelled before it is cached: brought up to the RMS a phone
 * expects, and held under the peak ceiling so it never clips.
 */
export const PEAK_CEILING_DBFS = -1
/**
 * Telephony is a loud, compressed medium: a hosted TTS sends a line far hotter
 * than Kokoro renders it, and peak-normalising alone cannot close the gap —
 * speech has a 15 dB crest factor, so the peaks hit the ceiling while the body
 * of the line is still quiet. Hence a target well above where peak
 * normalisation lands, and a soft limiter to pay for it (Anthony, twice, on air:
 * "voice are not loud enough on group call").
 */
export const RMS_TARGET_DBFS = -15
/** Never apply more than this, or quiet passages turn into noise. */
export const MAX_GAIN_DB = 24

const dbToGain = (db: number) => 10 ** (db / 20)

/** Where a WAV's `data` chunk starts and how long it is. */
function dataChunk(wav: Uint8Array): { at: number; length: number } | null {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const tag = (at: number) => String.fromCharCode(wav[at]!, wav[at + 1]!, wav[at + 2]!, wav[at + 3]!)
  let at = 12
  while (at + 8 <= wav.length) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    if (id === 'data') return { at: at + 8, length: Math.min(size, wav.length - at - 8) }
    at += 8 + size + (size % 2)
  }
  return null
}

/**
 * Level one 16-bit PCM WAV in place and say what gain was applied.
 *
 * Gain is chosen by RMS, not by peak, so the body of the line reaches the
 * target; whatever that sends over the ceiling is rounded off by a tanh
 * saturator rather than clipped square. Speech peaks are sparse, so the
 * saturation is inaudible where plain clipping would buzz.
 *
 * The knee must be continuous. Until 0.4.8 a sample just past 0.7 x ceiling
 * was mapped to ceiling x tanh(0.7) = 0.60 x ceiling, a step DOWN: every loud
 * syllable was folded at the knee, about -20 dB of distortion that listeners
 * heard as static (Anthony 2026-11-11: "this audio is static-ridden").
 * Above the knee the curve now starts at the knee with slope 1 and bends
 * towards the ceiling. Kokoro's output also leans positive (a slow DC skew
 * during speech), which wastes headroom on one side; a first-order high-pass
 * at 60 Hz takes it out before the gain is chosen.
 */
export function levelWav(wav: Uint8Array): number {
  const data = dataChunk(wav)
  if (!data || data.length < 2) return 0
  const samples = new Int16Array(wav.buffer, wav.byteOffset + data.at, Math.floor(data.length / 2))
  if (!samples.length) return 0
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const rate = (wav.length >= 28 && view.getUint32(24, true)) || 24000
  const pcm = highPass(samples, rate)
  let peak = 0
  let sumSquares = 0
  for (const v of pcm) {
    const x = Math.abs(v)
    if (x > peak) peak = x
    sumSquares += x * x
  }
  if (!peak) return 0
  const rms = Math.sqrt(sumSquares / pcm.length)
  const gain = Math.min(Math.max(1, rms > 0 ? dbToGain(RMS_TARGET_DBFS) / rms : 1), dbToGain(MAX_GAIN_DB))
  if (gain <= 1.01) return 0
  for (let i = 0; i < pcm.length; i++) {
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(softLimit(pcm[i]! * gain) * 32768)))
  }
  return Math.round(20 * Math.log10(gain) * 10) / 10
}

/** Where the soft limiter starts bending, as a fraction of the ceiling. */
const KNEE = 0.7

/**
 * Linear below the knee; above it, a tanh that leaves the knee with slope 1 and
 * approaches the ceiling. Continuous and monotonic, so it never folds a peak.
 */
export function softLimit(x: number, ceiling = dbToGain(PEAK_CEILING_DBFS)): number {
  const knee = ceiling * KNEE
  const a = Math.abs(x)
  if (a <= knee) return x
  const room = ceiling - knee
  return Math.sign(x) * (knee + room * Math.tanh((a - knee) / room))
}

/** A first-order 60 Hz high-pass: removes DC and the slow skew Kokoro adds. */
function highPass(samples: Int16Array, rate: number): Float64Array {
  const r = Math.exp((-2 * Math.PI * 60) / rate)
  const out = new Float64Array(samples.length)
  let prevX = 0
  let prevY = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]! / 32768
    prevY = x - prevX + r * prevY
    prevX = x
    out[i] = prevY
  }
  return out
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
  /** Voices whose session would not open, and when to try them again. */
  private unavailable = new Map<string, number>()
  /** GPU misses in a row; one bad sample must not cost the GPU for 5 minutes. */
  private gpuMisses = 0
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
    // A node without Pocket refuses at once; do not ask again for every line.
    if ((this.unavailable.get(voice) ?? 0) > Date.now()) return null
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
        this.unavailable.delete(voice)
        const session: Session = { id: body.session, voice, utterances: 0 }
        this.sessions.set(voice, session)
        return session
      } catch (e) {
        this.log(`could not open a ${voice} session: ${e instanceof Error ? e.message : e}`)
        this.unavailable.set(voice, Date.now() + 5 * 60 * 1000)
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
      for (const voice of [voiceFor(agent), fallbackVoiceFor(agent)]) {
        if ((this.sessions.get(voice) ?? (await this.open(voice))) !== null) {
          ready.push(voice)
          break
        }
      }
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
   * `level: false` skips the phone levelling and returns the raw render.
   */
  /**
   * The best voice the network has: the agent's expressive Chatterbox voice on
   * a GPU node (Anthony 2026-11-11: "add best qualitiy on gpus and lower
   * quality for cpus"), else the warm Pocket/Kokoro path. One-shot and
   * auctioned, so it suits file renders, not a live phone turn.
   */
  async sayBest(agent: string, text: string, id: string, opts: { level?: boolean; exaggeration?: number } = {}): Promise<SpokenLine | null> {
    const line = text.trim()
    const voice = agentKey(agent)
    if (this.config.baseUrl && this.config.token && line && line.length <= MAX_CHARS && GPU_VOICES.includes(voice) && (this.unavailable.get('gpu') ?? 0) <= Date.now()) {
      try {
        const began = Date.now()
        const res = await this.fetch(this.url('/v1/tts'), {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ text: line, engine: 'chatterbox', voice, exaggeration: opts.exaggeration ?? 0.6 }),
          signal: AbortSignal.timeout(900_000), // a busy GPU queues the job; wait our turn instead of losing it
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`)
        const wav = new Uint8Array(await res.arrayBuffer())
        if (!looksLikeSpeech(wav)) throw new Error('not a WAV')
        const cached = await this.cache(id, wav, opts.level, `chatterbox:${voice}`, Date.now() - began)
        if (cached) {
          this.gpuMisses = 0
          return cached
        }
      } catch (e) {
        this.gpuMisses += 1
        this.log(`GPU voice for ${voice} failed (${this.gpuMisses} in a row), using the CPU voice: ${e instanceof Error ? e.message : e}`)
        if (this.gpuMisses >= 3) {
          this.unavailable.set('gpu', Date.now() + 5 * 60 * 1000)
          this.gpuMisses = 0
        }
      }
    }
    return this.say(agent, text, id, opts)
  }

  /** Level (unless asked not to) and cache a rendered line behind its HMAC path. */
  private async cache(id: string, wav: Uint8Array, level: boolean | undefined, voice: string, synthMs: number): Promise<SpokenLine | null> {
    const gainDb = level === false ? 0 : levelWav(wav)
    const token = audioToken(id, this.config.secret)
    try {
      await writeFile(join(this.dir, `${token}.wav`), wav)
    } catch (e) {
      this.log(`could not cache ${token}: ${e instanceof Error ? e.message : e}`)
      return null
    }
    void this.sweep()
    return {
      url: `${this.config.origin.replace(/\/+$/, '')}/speech/${token}.wav`,
      seconds: wavSeconds(wav),
      synthMs,
      voice,
      ...(gainDb ? { gainDb } : {}),
    }
  }

  async say(agent: string, text: string, id: string, opts: { level?: boolean } = {}): Promise<SpokenLine | null> {
    const line = text.trim()
    if (!this.config.baseUrl || !this.config.token || !line || line.length > MAX_CHARS) return null

    // Pocket first; the agent's Kokoro voice when no Pocket worker can speak.
    let voice = ''
    let session: Session | null = null
    let said: { wav: Uint8Array; synthMs: number } | 'gone' | null = null
    for (const candidate of [voiceFor(agent), fallbackVoiceFor(agent)]) {
      voice = candidate
      session = this.sessions.get(voice) ?? (await this.open(voice))
      if (!session) continue
      said = await this.sayOnce(session, line)
      if (said === 'gone') {
        this.sessions.delete(voice)
        session = await this.open(voice)
        said = session ? await this.sayOnce(session, line) : null
      }
      if (session && said && said !== 'gone' && looksLikeSpeech(said.wav)) break
      said = null
    }
    if (!session || !said) return null
    session.utterances += 1
    // A phone leg wants the line levelled; a file render (TUI Weekly) masters
    // the whole episode itself and wants Kokoro exactly as it rendered.
    const gainDb = opts.level === false ? 0 : levelWav(said.wav)

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
      ...(gainDb ? { gainDb } : {}),
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
