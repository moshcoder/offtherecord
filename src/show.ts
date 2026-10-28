/**
 * Making an episode, start to finish.
 *
 * 1. `start`: a group.call room that records, ring the guest's phone (he presses
 *    1), and once he is on the line, dial the host in: an ElevenLabs agent over
 *    SIP, told which episode, format, topic and length in X- headers.
 * 2. The host interviews him; it checks `clock` (a tool it calls) to land on time.
 * 3. When the call ends group.call saves the mp3. `tick` finds it, downloads it,
 *    levels the loudness (ffmpeg, when there is one), and writes title and show
 *    notes from the room's speaker-labelled transcript.
 * 4. The episode publishes itself as soon as it is ready (Anthony 2026-10-27:
 *    "that should always happen automatically"); OTR_AUTOPUBLISH=0 holds it as
 *    "ready" for `otr publish`.
 */
import { mkdirSync, renameSync, unlinkSync } from 'node:fs'
import type { Episode, Store } from './db.js'
import { FIRST_MESSAGE, hostPrompt, pickTopic, pickVariant, variant } from './variants.js'


/** Shorter than this, a finished episode waits for `otr publish` instead of going out on its own. */
export const MIN_AUTOPUBLISH_SECS = 8 * 60

/**
 * How long the host holds an opened room for callers before hanging up (Anthony
 * 2026-10-28: "the host should be there first ... host should wait 20 minutes for
 * call ins"). group.call cannot hang one leg up, so the host's own ElevenLabs
 * silence timeout does it: twenty minutes with nobody speaking ends its call.
 */
export const WAIT_MINUTES = 20
/**
 * A host that drops mid-episode while someone is still on is dialled back in, up
 * to three times, at least 30 seconds apart (Anthony 2026-10-28: "please dial back
 * in if you drop do it 3 times ... then wait 30 seconds").
 */
export const MAX_REDIALS = 3
export const REDIAL_GAP_MS = 30_000
/**
 * A guest whose line drops mid-episode (the host still in the room, or both gone
 * without the host signing off) is rung back, up to three times, a minute apart;
 * so is one who does not pick up the first ring. After that the episode is
 * abandoned: what was recorded is kept, held for a person, and the operator is
 * told (Anthony 2026-10-28: "make sure you have error/dropped recovery too ...
 * last time we had to manually restart. do that 3 times before you abandon").
 */
export const MAX_RINGS = 3
export const RING_GAP_MS = 60_000
/** A failed group.call request (start, ring, host dial) is tried this many more times. */
export const RETRIES = 3
/** A recording shorter than this is a stub from a dropped line, not part of the episode. */
const MIN_PART_SECS = 30
const ABANDONED = 'abandoned'
/** The note on an opened episode until its first caller arrives. */
const WAITING = 'waiting for callers'

export type Config = {
  origin: string
  audioDir: string
  groupcallUrl: string
  groupcallKey: string
  /** The default guest's (Anthony's) phone, E.164; signed-up guests bring their own. */
  guestPhone: string
  guestName: string
  /** The host agent's SIP URI, e.g. sip:+15106169327@sip.rtc.elevenlabs.io;transport=tcp */
  hostSip: string
  elevenlabsKey?: string
  agentId?: string
  /** Sent by the host's clock tool, so only it can read the clock. */
  hostToolSecret: string
  geminiKey?: string
  autopublish?: boolean
  ffmpeg?: string | null
  fetch?: typeof fetch
  /** How long to wait for the guest to pick up and press 1. */
  answerTimeoutMs?: number
  log?: (line: string) => void
  /** Tell the operator something went wrong for good (an episode abandoned or failed). */
  notify?: (message: string) => void
  /** Wait between retries of a failed request; 10 s by default. */
  retryGapMs?: number
}

export class ShowError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

const HOST_NAME = 'riotcoder (host)'
const DEFAULT_GUEST = 'Anthony Ettinger'

/** A SIP header value: one line of printable ASCII, short. */
const sipValue = (s: string, max: number) => s.normalize('NFKD').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const ROOM_NAME = 'Off The Record'

export class Show {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    mkdirSync(config.audioDir, { recursive: true })
  }

  private get fetch(): typeof fetch {
    return this.config.fetch ?? fetch
  }

  private log(line: string): void {
    ;(this.config.log ?? console.log)(`otr: ${line}`)
  }

  private tell(message: string): void {
    this.log(message)
    try {
      this.config.notify?.(`Off The Record: ${message}`)
    } catch (e) {
      this.log(`notify failed: ${e}`)
    }
  }

  /** Try a group.call request again, RETRIES times, when it fails on their side (or the network's). */
  private async retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn()
      } catch (e) {
        if ((e instanceof ShowError && e.status < 500) || i >= RETRIES) throw e
        this.log(`${what} failed (${e instanceof Error ? e.message : e}); retry ${i + 1}/${RETRIES}`)
        await new Promise((ok) => setTimeout(ok, this.config.retryGapMs ?? 10_000))
      }
    }
  }

  /** group.call's API, as the show's operator account. */
  private async gc<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(this.config.groupcallUrl.replace(/\/+$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${this.config.groupcallKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new ShowError(`group.call: ${data.error ?? res.status}`, 502)
    return data
  }

  // ---- recording ----------------------------------------------------------------

  /**
   * Start an episode: make the room, ring the guest. The host is dialled in by
   * `bringHost` once the guest is on the line (awaited here only in tests).
   */
  async start(opts: { topic?: string; variant?: string; guest?: number; wait?: boolean; dialIn?: boolean; open?: boolean } = {}): Promise<Episode> {
    await this.closeStale()
    if (this.store.inStatus('calling', 'live').length) throw new ShowError('An episode is already being recorded.', 409)
    const guest = opts.guest ? this.store.guest(opts.guest) : null
    if (opts.guest && !guest) throw new ShowError('No such guest.', 404)
    const all = this.store.episodes()
    const v = opts.variant ? variant(opts.variant).key : pickVariant(all.map((e) => ({ variant: e.variant, n: e.n })))
    const topic = (opts.topic ?? guest?.topic ?? '').replace(/\s+/g, ' ').trim().slice(0, 180) || pickTopic(all.map((e) => e.topic))
    const ep = this.store.addEpisode({ topic, variant: v, guestId: guest?.id ?? null })
    try {
      // One room for the show (an account has only a few); recordings are told apart by when they started.
      const room = await this.retry('finding the room', async () => {
        const { rooms } = await this.gc<{ rooms: { code: string; name: string }[] }>('GET', '/api/v1/rooms')
        return rooms.find((r) => r.name === ROOM_NAME) ?? (await this.gc<{ code: string }>('POST', '/api/v1/rooms', { name: ROOM_NAME }))
      })
      this.store.update(ep.n, { room: room.code })
      await this.retry('turning recording on', () => this.gc('POST', `/api/v1/rooms/${room.code}/record`, { on: true }))
      if (opts.open) {
        await this.retry('dialling the host', () => this.dialHost(ep.n, 'waiting'))
        this.store.update(ep.n, { status: 'live', note: WAITING })
        this.log(`episode ${ep.n} (${v}): host is holding room ${room.code} open for ${WAIT_MINUTES} min`)
        return this.store.episode(ep.n)!
      } else if (opts.dialIn) {
        this.log(`episode ${ep.n} (${v}): someone dialled into room ${room.code}`)
      } else {
        await this.retry('ringing the guest', () => this.ringGuest(ep.n))
        this.store.update(ep.n, { rang: true })
        if (guest) this.store.setGuestStatus(guest.id, 'booked')
        this.log(`episode ${ep.n} (${v}): ringing the guest into room ${room.code}`)
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      this.store.update(ep.n, { status: 'failed', note: why })
      this.tell(`episode ${ep.n} could not start after ${RETRIES} retries: ${why}`)
      throw e
    }
    const host = this.bringHost(ep.n)
    if (opts.wait) await host
    else void host.catch((e) => this.log(`episode ${ep.n}: ${e}`))
    return this.store.episode(ep.n)!
  }

  /** Ring the episode's guest (a signed-up guest's phone, or Anthony's). */
  private async ringGuest(n: number): Promise<void> {
    this.store.update(n, { lastRingAt: Date.now() })
    const ep = this.store.episode(n)!
    const guest = ep.guestId ? this.store.guest(ep.guestId) : null
    await this.gc('POST', `/api/v1/rooms/${ep.room}/call`, { phone: guest?.phone ?? this.config.guestPhone, name: guest?.name ?? this.config.guestName })
  }

  /**
   * A live episode whose callers have all gone is over, even if the host's leg is
   * still in the room: a host that freezes on the ElevenLabs side stays connected
   * and silent until its 20-minute silence timeout (episode 6, 2026-10-28: Anthony
   * hung up at 10:40 and `otr open` refused with 409 until the stuck leg was hung
   * up by hand at 10:42). An opened room still waiting for its first caller is not
   * stale. The recording finishes through `tick` as usual.
   */
  private async closeStale(): Promise<void> {
    for (const ep of this.store.inStatus('live')) {
      if (ep.note === WAITING || !ep.room) continue
      const room = await this.gc<{ live?: { kind: string; name: string }[] }>('GET', `/api/v1/rooms/${ep.room}`).catch(() => null)
      if (!room || (room.live ?? []).some((p) => p.kind === 'person')) continue
      this.store.update(ep.n, { status: 'saving', note: 'the callers left' })
      this.log(`episode ${ep.n}: nobody but the host is left in room ${ep.room}; closed it`)
    }
  }

  /**
   * Called every few seconds: anyone who dials the show's room themselves gets the
   * host, no ring needed (Anthony 2026-10-28: "nobody in room ... the host should be
   * there first"). The host joins seconds after the first person, so it never sits
   * alone burning agent minutes.
   */
  async door(): Promise<void> {
    const waiting = this.store.inStatus('live').find((e) => e.note === WAITING)
    if (waiting) return this.arrived(waiting)
    const live = this.store.inStatus('live')[0]
    if (live) return this.recover(live)
    // A ring whose watcher died with the process (a restart mid-ring): pick it back up.
    const calling = this.store.inStatus('calling').find((e) => !this.bringing.has(e.n) && e.room && Date.now() - e.createdAt > 10_000)
    if (calling) return void this.bringHost(calling.n).catch((e) => this.log(`episode ${calling.n}: ${e}`))
    if (this.opening || this.store.inStatus('calling', 'live').length) return
    this.opening = true
    try {
      await this.openDoor()
    } finally {
      this.opening = false
    }
  }
  private opening = false
  private async openDoor(): Promise<void> {
    if (!this.roomCode) {
      const { rooms } = await this.gc<{ rooms: { code: string; name: string }[] }>('GET', '/api/v1/rooms')
      this.roomCode = rooms.find((r) => r.name === ROOM_NAME)?.code
      if (!this.roomCode) return
    }
    const room = await this.gc<{ live?: { kind: string; name: string }[] }>('GET', `/api/v1/rooms/${this.roomCode}`)
    const live = room.live ?? []
    if (!live.some((p) => p.kind === 'person') || live.some((p) => p.name === HOST_NAME)) return
    await this.start({ dialIn: true, wait: true })
  }
  private roomCode?: string

  /** An opened room's first caller is on: the episode's clock starts now. */
  private async arrived(ep: Episode): Promise<void> {
    const room = await this.gc<{ live?: { kind: string; name: string }[] }>('GET', `/api/v1/rooms/${ep.room}`)
    if (!(room.live ?? []).some((p) => p.kind === 'person')) return
    this.store.update(ep.n, { hostJoinedAt: Date.now(), note: '' })
    this.log(`episode ${ep.n}: first caller is on`)
  }

  /**
   * A live episode lost someone before its time was up: bring them back.
   * - the host dropped, a caller is still on: dial the host in again (MAX_REDIALS,
   *   REDIAL_GAP_MS apart);
   * - the guest dropped (the host waiting in the room, or both gone): ring the
   *   guest again (MAX_RINGS, RING_GAP_MS apart), if this episode rang them;
   * unless the host signed off with end_call: then the show is over and the rest
   * just hang up (episode 4, 2026-10-28: the host signed off at 47 min of a 60-min
   * riff with Anthony still on, and the old redial tried to dial it back 3 times).
   * Out of tries, the episode is abandoned: kept, held, and the operator is told.
   */
  private async recover(ep: Episode): Promise<void> {
    if (!ep.room || !ep.hostJoinedAt || ep.note.startsWith(ABANDONED)) return
    // Past the format's length the host hung up on purpose.
    if (Date.now() - ep.hostJoinedAt >= variant(ep.variant).minutes * 60_000) return
    const room = await this.gc<{ live?: { kind: string; name: string }[] }>('GET', `/api/v1/rooms/${ep.room}`)
    const live = room.live ?? []
    const caller = live.some((p) => p.kind === 'person')
    const host = live.some((p) => p.name === HOST_NAME)
    if (caller && host) {
      this.missing.delete(ep.n)
      return
    }
    if (!caller && !ep.rang) return // a dial-in: nobody to ring back
    const now = Date.now()
    if (caller) {
      if (now - ep.lastDialAt < REDIAL_GAP_MS) return
    } else if (now - ep.lastRingAt < RING_GAP_MS) return
    // The host gone: was that a goodbye? (With the host still in the room, it was not.)
    if (!host) {
      const off = await this.hostSignedOff(ep)
      if (off === 'yes') return
      // ElevenLabs has not closed the host's conversation yet: give it a minute to say why it ended.
      if (!this.missing.has(ep.n)) this.missing.set(ep.n, now)
      if (off === 'pending' && now - this.missing.get(ep.n)! < 60_000) return
      if (off === 'unknown' && !caller) return // cannot tell a drop from a goodbye: leave it
    }
    if (caller) {
      if (ep.hostRedials >= MAX_REDIALS) return this.abandon(ep, `the host dropped and did not come back after ${MAX_REDIALS} redials`)
      this.store.update(ep.n, { hostRedials: ep.hostRedials + 1 })
      try {
        await this.dialHost(ep.n, 'rejoin')
        this.log(`episode ${ep.n}: the host dropped with a caller still on; redialled (${ep.hostRedials + 1}/${MAX_REDIALS})`)
      } catch (e) {
        this.log(`episode ${ep.n}: host redial ${ep.hostRedials + 1}/${MAX_REDIALS} failed: ${e instanceof Error ? e.message : e}`)
      }
      return
    }
    if (ep.guestRings >= MAX_RINGS) return this.abandon(ep, `the guest dropped and did not pick up ${MAX_RINGS} rings back`)
    this.store.update(ep.n, { guestRings: ep.guestRings + 1 })
    try {
      await this.ringGuest(ep.n)
      this.log(`episode ${ep.n}: the guest dropped; ringing them back (${ep.guestRings + 1}/${MAX_RINGS})`)
    } catch (e) {
      this.log(`episode ${ep.n}: re-ring ${ep.guestRings + 1}/${MAX_RINGS} failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  /** When a leg first went missing with ElevenLabs still saying the call is on. */
  private missing = new Map<number, number>()

  /** Out of tries: keep what was recorded, hold it for a person, and say so. */
  private abandon(ep: Episode, why: string): void {
    this.store.update(ep.n, { status: 'saving', note: `${ABANDONED}: ${why}` })
    this.tell(`episode ${ep.n} abandoned: ${why}. What was recorded is kept and held (not published).`)
  }

  /**
   * Did the host end its last call on purpose (end_call), per ElevenLabs? 'pending'
   * while its conversation is still open, 'unknown' without a key or an answer.
   */
  async hostSignedOff(ep: Episode): Promise<'yes' | 'no' | 'pending' | 'unknown'> {
    const { elevenlabsKey: key, agentId } = this.config
    if (!key || !agentId) return 'unknown'
    try {
      const res = await this.fetch(`https://api.elevenlabs.io/v1/convai/conversations?agent_id=${encodeURIComponent(agentId)}&page_size=5`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return 'unknown'
      const { conversations = [] } = (await res.json()) as { conversations?: { start_time_unix_secs: number; status: string; termination_reason?: string | null }[] }
      const last = conversations.filter((c) => c.start_time_unix_secs * 1000 >= ep.createdAt - 60_000).sort((a, b) => b.start_time_unix_secs - a.start_time_unix_secs)[0]
      if (!last) return 'no'
      if (/end_call/i.test(last.termination_reason ?? '')) return 'yes'
      return last.status === 'done' || last.status === 'failed' ? 'no' : 'pending'
    } catch {
      return 'unknown'
    }
  }

  /** Wait for the guest to be on the line, then dial the host in. */
  async bringHost(n: number): Promise<void> {
    if (this.bringing.has(n)) return
    this.bringing.add(n)
    try {
      await this.waitAndDial(n)
    } finally {
      this.bringing.delete(n)
    }
  }
  private bringing = new Set<number>()

  /** Unanswered rings are rung again (MAX_RINGS); a host dial that keeps failing is left to `recover`. */
  private async waitAndDial(n: number): Promise<void> {
    const ep = this.store.episode(n)!
    const wait = this.config.answerTimeoutMs ?? 120_000
    let until = Date.now() + wait
    for (;;) {
      const room = await this.gc<{ live?: { kind: string; name: string }[] }>('GET', `/api/v1/rooms/${ep.room}`).catch(() => null)
      if (room?.live?.some((p) => p.kind === 'person')) {
        this.store.update(n, { status: 'live', hostJoinedAt: Date.now() })
        try {
          await this.retry('dialling the host', () => this.dialHost(n, 'start'))
          this.log(`episode ${n}: the guest is on; host dialled in`)
        } catch (e) {
          // Live with no host: `recover` keeps redialling it every 30 s.
          this.log(`episode ${n}: the guest is on but the host could not be dialled (${e instanceof Error ? e.message : e}); recovery takes over`)
        }
        return
      }
      if (Date.now() >= until) {
        const now = this.store.episode(n)!
        if (!now.rang || now.guestRings >= MAX_RINGS) break
        this.store.update(n, { guestRings: now.guestRings + 1 })
        this.log(`episode ${n}: no answer; ringing again (${now.guestRings + 1}/${MAX_RINGS})`)
        await this.ringGuest(n).catch((e) => this.log(`episode ${n}: ring failed: ${e instanceof Error ? e.message : e}`))
        until = Date.now() + wait
      }
      await new Promise((ok) => setTimeout(ok, Math.min(3000, wait)))
    }
    this.store.update(n, { status: 'missed', note: 'the guest did not pick up' })
    if (ep.guestId) this.store.setGuestStatus(ep.guestId, 'new')
    this.tell(`episode ${n}: the guest did not pick up after ${MAX_RINGS + 1} rings; abandoned`)
  }

  /**
   * Dial the host agent into the episode's room over SIP, told the episode in X-
   * headers. `waiting`: nobody is on yet, so it greets the empty line briefly and
   * keeps quiet until someone speaks. `rejoin`: its leg dropped mid-episode.
   */
  private async dialHost(n: number, mode: 'start' | 'waiting' | 'rejoin'): Promise<void> {
    this.store.update(n, { lastDialAt: Date.now() })
    const waiting = mode === 'waiting'
    const ep = this.store.episode(n)!
    const v = variant(ep.variant)
    const guest = ep.guestId ? this.store.guest(ep.guestId) : null
    const guestName = sipValue(guest?.name ?? DEFAULT_GUEST, 80) || 'our guest'
    const topic = sipValue(ep.topic, 180)
    await this.gc('POST', `/api/v1/rooms/${ep.room}/call`, {
      sip: this.config.hostSip,
      name: HOST_NAME,
      headers: {
        'X-Otr-Episode': String(ep.n),
        'X-Otr-Style': v.key,
        'X-Otr-Minutes': String(v.minutes),
        'X-Otr-Topic': topic,
        'X-Otr-Guest': guestName,
        'X-Otr-About': guest ? sipValue([guest.about, guest.link].filter(Boolean).join(' '), 600) || 'nothing yet' : 'the show founder',
        'X-Otr-Waiting': waiting ? 'yes' : 'no',
        'X-Otr-Hello': sipValue(waiting ? `riotcoder here, holding the line for episode ${ep.n} of Off The Record. Say hello when you are on.` : mode === 'rejoin' ? `riotcoder back, sorry, my line dropped. Let's pick up where we left off on ${topic}.` : `Hey ${guestName}, riotcoder here. We are recording episode ${ep.n} of Off The Record, on ${topic}. Quick word on the format first.`, 300),
      },
    })
  }

  /** For the host's check_clock tool: how far in, and whether to wrap up. */
  clock(n: number, now = Date.now()) {
    const ep = this.store.episode(n)
    if (!ep) return { error: 'no such episode' }
    const target = variant(ep.variant).minutes
    const elapsed = ep.hostJoinedAt ? (now - ep.hostJoinedAt) / 60_000 : 0
    const remaining = target - elapsed
    const advice =
      remaining <= 0
        ? 'Time is up. Wrap up now: one closing question, thank them, sign off, end the call.'
        : remaining <= 5
          ? 'About five minutes left. Start wrapping up: closing question next.'
          : remaining <= 15
            ? 'Final stretch. No new big topics; go deeper on the current one.'
            : 'Plenty of time. Keep going.'
    return { elapsed_minutes: Math.round(elapsed), target_minutes: target, remaining_minutes: Math.max(0, Math.round(remaining)), advice }
  }

  // ---- after the call -------------------------------------------------------------

  /** Called every minute: pick up finished recordings. */
  async tick(): Promise<void> {
    for (const ep of this.store.inStatus('live', 'saving')) {
      try {
        await this.collect(ep)
      } catch (e) {
        this.log(`episode ${ep.n}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  private async collect(ep: Episode): Promise<void> {
    const { recordings } = await this.gc<{ recordings: { id: string; status: string; mp3: string | null; duration_secs: number | null; started_at: string }[] }>('GET', `/api/v1/rooms/${ep.room}/recordings`)
    // This episode's: started after it was, in the show's shared room. The longest
    // one, since a dropped and re-dialled call can leave a short stub first.
    const mine = recordings.filter((r) => Date.parse(r.started_at) >= ep.createdAt - 60_000 || !r.started_at)
    // Still recording (a re-rung guest or a redialled host started a new part): not over yet.
    if (mine.some((r) => r.status === 'recording')) return
    // Everybody dropped before time and the guest is being rung back: wait for them.
    if (ep.status === 'live' && (await this.mayRecover(ep))) return
    const parts = mine.filter((r) => r.status === 'ready' && r.mp3).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
    const ready = parts.slice().sort((a, b) => (b.duration_secs ?? 0) - (a.duration_secs ?? 0))[0]
    if (!ready) {
      if (mine.some((r) => r.status === 'failed') && !mine.some((r) => r.status === 'recording' || r.status === 'saving')) this.store.update(ep.n, { status: 'failed', note: 'group.call could not save the recording' })
      else if (ep.status === 'live' && mine.length && !mine.some((r) => r.status === 'recording')) this.store.update(ep.n, { status: 'saving' })
      return
    }
    // An opened room nobody called into: twenty minutes of the host waiting, not an episode.
    if (ep.note === WAITING) {
      this.store.update(ep.n, { status: 'missed', recordingId: ready.id, endedAt: Date.now(), note: 'nobody called in' })
      this.log(`episode ${ep.n}: nobody called in`)
      return
    }
    this.store.update(ep.n, { status: 'saving', recordingId: ready.id, endedAt: Date.now() })
    const raw = `${this.config.audioDir}/${ep.n}.raw.mp3`
    const out = `${this.config.audioDir}/${ep.n}.mp3`
    // A call that dropped and was brought back is several recordings: join them in order.
    const keep = parts.filter((r) => (r.duration_secs ?? MIN_PART_SECS) >= MIN_PART_SECS)
    const files: string[] = []
    for (const [i, r] of (keep.length > 1 && this.config.ffmpeg ? keep : [ready]).entries()) {
      const res = await this.fetch(r.mp3!, { headers: { authorization: `Bearer ${this.config.groupcallKey}` } })
      if (!res.ok) throw new Error(`mp3 download ${res.status}`)
      const f = `${this.config.audioDir}/${ep.n}.part${i}.mp3`
      await Bun.write(f, await res.arrayBuffer())
      files.push(f)
    }
    await this.join(files, raw)
    await this.master(raw, out)
    const durationSecs = (await this.probe(out)) ?? ready.duration_secs
    const lines = await this.gc<{ lines: { who: string; text: string; at: string }[] }>('GET', `/api/v1/rooms/${ep.room}/transcript?limit=5000`).catch(() => ({ lines: [] }))
    const transcript = lines.lines.map((l) => `${l.who}: ${l.text}`).join('\n')
    const { title, notes } = await this.writeNotes(ep, transcript)
    this.store.update(ep.n, { status: 'ready', audioPath: out, audioBytes: Bun.file(out).size, durationSecs: durationSecs ?? null, transcript, title, notes })
    if (ep.guestId) this.store.setGuestStatus(ep.guestId, 'recorded')
    this.log(`episode ${ep.n} is ready: ${title}`)
    if (!this.config.autopublish) return
    if (ep.note.startsWith(ABANDONED)) {
      this.log(`episode ${ep.n}: held, it was abandoned; publish by hand with otr publish ${ep.n}`)
      return
    }
    // A call that never got going (guest muted, line dead, host gave up) is a few
    // minutes of the host saying "still with me?": hold it for a person to look at.
    if ((durationSecs ?? 0) < MIN_AUTOPUBLISH_SECS) {
      this.log(`episode ${ep.n}: held, only ${Math.round((durationSecs ?? 0) / 60)} min; publish by hand with otr publish ${ep.n}`)
      return
    }
    this.publish(ep.n)
  }

  /** Could `recover` still bring the guest back? Only then is an empty room not the end. */
  private async mayRecover(ep: Episode): Promise<boolean> {
    if (!ep.rang || !ep.hostJoinedAt || ep.note.startsWith(ABANDONED) || ep.guestRings >= MAX_RINGS) return false
    if (Date.now() - ep.hostJoinedAt >= variant(ep.variant).minutes * 60_000) return false
    const off = await this.hostSignedOff(ep)
    return off === 'no' || off === 'pending'
  }

  /** One file from the parts of a call, in order (ffmpeg concat); a single part is just renamed. */
  private async join(files: string[], out: string): Promise<void> {
    if (files.length === 1) return renameSync(files[0]!, out)
    const p = Bun.spawn([this.config.ffmpeg!, '-hide_banner', '-loglevel', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `${files.map((_, i) => `[${i}:a]`).join('')}concat=n=${files.length}:v=0:a=1[a]`, '-map', '[a]', out], { stderr: 'pipe' })
    if ((await p.exited) !== 0) throw new Error(`ffmpeg concat failed: ${(await new Response(p.stderr).text()).slice(0, 200)}`)
    for (const f of files) unlinkSync(f)
  }

  /**
   * Level the loudness to podcast norm (-16 LUFS, the Apple/Spotify target), trim
   * the silence before anybody speaks, and mono 64 kbps: it is a phone call.
   * Without ffmpeg the call's own mp3 is used as it is.
   */
  private async master(raw: string, out: string): Promise<void> {
    const ff = this.config.ffmpeg
    if (ff) {
      const p = Bun.spawn([ff, '-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,loudnorm=I=-16:TP=-1.5:LRA=11', '-ac', '1', '-ar', '44100', '-b:a', '64k', `${out}.tmp.mp3`], { stderr: 'pipe' })
      if ((await p.exited) === 0) {
        renameSync(`${out}.tmp.mp3`, out)
        unlinkSync(raw)
        return
      }
      this.log(`ffmpeg failed (${(await new Response(p.stderr).text()).slice(0, 200)}); keeping the raw call audio`)
    }
    renameSync(raw, out)
  }

  private async probe(path: string): Promise<number | null> {
    const ff = this.config.ffmpeg
    if (!ff) return null
    const p = Bun.spawn([ff.replace(/ffmpeg$/, 'ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { stdout: 'pipe', stderr: 'ignore' })
    const out = (await new Response(p.stdout).text()).trim()
    return (await p.exited) === 0 && Number.isFinite(Number(out)) ? Math.round(Number(out)) : null
  }

  /** A title and show notes from the transcript (Gemini); plain fallbacks without it. */
  async writeNotes(ep: Episode, transcript: string): Promise<{ title: string; notes: string }> {
    const guest = (ep.guestId ? this.store.guest(ep.guestId)?.name : null) ?? DEFAULT_GUEST
    const fallback = { title: ep.topic, notes: `${variant(ep.variant).name}: ${guest} on ${ep.topic}.` }
    if (!this.config.geminiKey || transcript.length < 200) return fallback
    const prompt = `You write titles and show notes for "Off The Record", a podcast where the AI host riotcoder interviews builders about fleet engineering, agentic coding bots and building a new internet. This episode's guest is ${guest}${guest === DEFAULT_GUEST ? ' (founder of Profullstack, the show\'s founder)' : ''}.

From this transcript (machine-transcribed, so fix obvious mishearings of names), write JSON: {"title": a specific, curious title under 70 characters, no clickbait, no episode number, "notes": 3 to 5 short paragraphs of plain-text show notes: what was discussed, the best story or quote, and what listeners will take away. No markdown, no emoji, no em dashes.}

Topic: ${ep.topic}
Transcript:
${transcript.slice(0, 120_000)}`
    try {
      const res = await this.fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.geminiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
        signal: AbortSignal.timeout(90_000),
      })
      const data = (await res.json()) as any
      const parsed = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}')
      const title = String(parsed.title ?? '').trim().slice(0, 100)
      const notes = String(parsed.notes ?? '').trim().slice(0, 5000)
      return title && notes ? { title, notes } : fallback
    } catch {
      return fallback
    }
  }

  publish(n: number): Episode {
    const ep = this.store.episode(n)
    if (!ep) throw new ShowError('No such episode.', 404)
    if (ep.status !== 'ready' && ep.status !== 'published') throw new ShowError(`Episode ${n} is ${ep.status}, not ready.`, 409)
    return this.store.update(n, { status: 'published', publishedAt: ep.publishedAt ?? Date.now() })
  }

  unpublish(n: number): Episode {
    const ep = this.store.episode(n)
    if (!ep) throw new ShowError('No such episode.', 404)
    return this.store.update(n, { status: ep.audioPath ? 'ready' : ep.status })
  }

  // ---- the host agent -------------------------------------------------------------

  /**
   * Push the host's prompt, voice, tools and limits to its ElevenLabs agent. Run
   * after changing variants.ts; the agent is otherwise left alone.
   */
  async syncHost(): Promise<{ agent_id: string }> {
    const { elevenlabsKey: key, agentId } = this.config
    if (!key || !agentId) throw new ShowError('ELEVENLABS_API_KEY and OTR_AGENT_ID are needed.', 503)
    const placeholders = { sip_otr_waiting: 'no', sip_otr_hello: 'riotcoder here, welcome to Off The Record.', sip_otr_episode: '0', sip_otr_style: 'riff', sip_otr_minutes: '60', sip_otr_topic: 'building with AI agents', sip_otr_guest: DEFAULT_GUEST, sip_otr_about: 'the show founder' }
    const body = {
      name: 'Off The Record host',
      conversation_config: {
        agent: {
          first_message: FIRST_MESSAGE,
          language: 'en',
          dynamic_variables: { dynamic_variable_placeholders: placeholders },
          prompt: {
            prompt: hostPrompt(),
            llm: 'claude-sonnet-5-5',
            temperature: 0.7,
            // System tools live in the same list as webhook tools: sending only the webhook
            // one here would delete end_call, and the host could never hang up.
            tools: [
              { type: 'system', name: 'end_call', description: 'End the call once the episode is signed off, or when the guest asks to stop.', params: { system_tool_type: 'end_call' } },
              { type: 'system', name: 'skip_turn', description: 'Stay silent this turn: use it while holding an empty line for callers.', params: { system_tool_type: 'skip_turn' } },
              {
                type: 'webhook',
                name: 'check_clock',
                description: 'How far into the episode you are, the target length, and whether to wrap up. Call about every ten minutes.',
                response_timeout_secs: 10,
                api_schema: {
                  url: `${this.config.origin}/api/host/clock`,
                  method: 'GET',
                  query_params_schema: { properties: { episode: { type: 'string', dynamic_variable: 'sip_otr_episode' } }, required: ['episode'] },
                  request_headers: { 'x-otr-secret': this.config.hostToolSecret },
                },
              },
            ],
          },
        },
        tts: { voice_id: 'iP95p4xoKVk53GoZ742B', model_id: 'eleven_flash_v2' },
        // Silence ends the call: long enough to hold an opened room for callers.
        turn: { turn_timeout: 20, silence_end_call_timeout: WAIT_MINUTES * 60 },
        // ElevenLabs' ceiling, and the show's: two hours.
        conversation: { max_duration_seconds: 7200 },
      },
    }
    const res = await this.fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new ShowError(`ElevenLabs: ${res.status} ${(await res.text()).slice(0, 600)}`, 502)
    return { agent_id: agentId }
  }
}
