/**
 * The co-hosted episodes: two of our own agents interviewing the guest, each
 * speaking in its own voice off the c0mpute speech gateway rather than a hosted
 * vendor.
 *
 * The gateway is faked here the way group.call is faked in show.test.ts: it
 * answers like the real one, and records what was asked of it.
 */
import { describe, expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { createApp } from '../src/server.ts'
import { audioToken, Speech, voiceFor, wavSeconds } from '../src/speech.ts'
import { cohostBrief, COHOSTS } from '../src/variants.ts'

/** A valid 16-bit mono WAV of `samples` frames at 24 kHz, as Kokoro returns. */
function wav(samples = 2400): Uint8Array {
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, text: string) => [...text].forEach((ch, i) => bytes.set([ch.charCodeAt(0)], at + i))
  tag(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, 24000, true) // 24 kHz
  view.setUint16(34, 16, true) // 16-bit
  tag(36, 'data')
  view.setUint32(40, samples * 2, true)
  return bytes
}

/** A fake c0mpute speech gateway: warm sessions, one WAV per `say`. */
function gateway(opts: { loseSessionOnce?: boolean; junk?: boolean; openFails?: boolean } = {}) {
  const calls: { method: string; path: string; body: any }[] = []
  let opened = 0
  let lost = opts.loseSessionOnce ?? false
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/v1/sessions' && method === 'POST') {
      if (opts.openFails) return new Response('no node', { status: 503 })
      opened += 1
      return new Response(JSON.stringify({ session: `s${opened}`, engine: 'kokoro', voice: body.voice, load_ms: 900 }), { status: 201 })
    }
    if (u.pathname === '/v1/sessions' && method === 'GET') return new Response(JSON.stringify({ sessions: [] }))
    if (/^\/v1\/sessions\/[^/]+\/say$/.test(u.pathname) && method === 'POST') {
      if (lost) {
        lost = false
        return new Response('gone', { status: 404 })
      }
      if (opts.junk) return new Response('<html>an error page</html>')
      return new Response(new Blob([wav().buffer as ArrayBuffer]), { headers: { 'x-c0mpute-synth-ms': '1672', 'x-c0mpute-audio-seconds': '0.1' } })
    }
    if (/^\/v1\/sessions\/[^/]+$/.test(u.pathname) && method === 'DELETE') return new Response(JSON.stringify({ closed: true }))
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch, sessionsOpened: () => opened }
}

/** A fake group.call that knows the show's room and its dial-in number. */
function groupcall(live: { kind: string; name: string }[] = []) {
  const calls: { method: string; path: string; body: any }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
    if (u.pathname === '/api/v1/rooms' && method === 'GET') return json({ rooms: [{ code: '8625', name: 'Off The Record', dial_in: '+15106169327' }] })
    if (u.pathname === '/api/v1/rooms/8625' && method === 'GET') return json({ code: '8625', live })
    if (u.pathname.endsWith('/record')) return json({ record: true, recording: true })
    if (u.pathname.endsWith('/call')) return json({ ringing: true }, 202)
    if (u.pathname.endsWith('/recordings')) return json({ recordings: [] })
    return json({ error: 'not found' }, 404)
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

function speechFor(gw: ReturnType<typeof gateway>, dir?: string) {
  return new Speech({
    baseUrl: 'http://127.0.0.1:8818',
    token: 'gw_token',
    audioDir: dir ?? `${process.env.TMPDIR ?? '/tmp'}/otr-speech-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    secret: 'signing_secret',
    origin: 'https://otr.test',
    fetch: gw.fetch,
    log: () => {},
  })
}

function setup(opts: { live?: { kind: string; name: string }[]; gw?: ReturnType<typeof gateway> } = {}) {
  const gc = groupcall(opts.live ?? [])
  const gw = opts.gw ?? gateway()
  const store = new Store(':memory:')
  const dir = `${process.env.TMPDIR ?? '/tmp'}/otr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const speech = speechFor(gw, dir)
  const { app, show } = createApp({
    store,
    adminKey: 'admin',
    salt: 'salt',
    speech,
    config: {
      origin: 'https://otr.test',
      audioDir: dir,
      groupcallUrl: 'https://gc.test',
      groupcallKey: 'gc_x',
      guestPhone: '+14085550101',
      guestName: 'Anthony',
      hostSip: 'sip:+15106169327@sip.rtc.elevenlabs.io;transport=tcp',
      hostToolSecret: 'tool',
      fetch: gc.fetch,
      retryGapMs: 0,
      ffmpeg: null,
      answerTimeoutMs: 50,
      log: () => {},
    },
  })
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { gc, gw, store, app, show, req, speech }
}

describe('each co-host speaks in the voice its profile names', () => {
  test('riotcoder is am_michael and cha0spunk is af_bella', () => {
    expect(voiceFor('riotcoder')).toBe('am_michael')
    expect(voiceFor('cha0spunk')).toBe('af_bella')
    // Spellings that turn up in headers and CLI flags.
    expect(voiceFor('@RiotCoder')).toBe('am_michael')
    // An agent with no profile voice still gets a voice rather than nothing.
    expect(voiceFor('someone-else')).toBe('am_michael')
  })

  test('the show roster agrees with the voice map', () => {
    for (const c of COHOSTS) expect(voiceFor(c.agent)).toBe(c.voice)
  })
})

describe('rendering a line on c0mpute', () => {
  test('opens one warm session per voice, reuses it, and caches the WAV behind an unguessable path', async () => {
    const gw = gateway()
    const speech = speechFor(gw)
    const first = await speech.say('riotcoder', 'Welcome to Off The Record.', 'ep5-1')
    const second = await speech.say('riotcoder', 'So Anthony, where did this start?', 'ep5-2')
    expect(first?.voice).toBe('am_michael')
    expect(first?.synthMs).toBe(1672)
    // 2400 frames at 24 kHz.
    expect(first?.seconds).toBe(0.1)
    expect(first?.url).toBe(`https://otr.test/speech/${audioToken('ep5-1', 'signing_secret')}.wav`)
    expect(second?.url).not.toBe(first?.url)
    // One session, two utterances: the auction and the model load are paid once.
    expect(gw.sessionsOpened()).toBe(1)
    expect(gw.calls.filter((c) => c.path.endsWith('/say')).length).toBe(2)
    // The cached bytes come back for the URL's token.
    const bytes = await speech.read(audioToken('ep5-1', 'signing_secret'))
    expect(bytes?.length).toBe(44 + 2400 * 2)
  })

  test('the other host gets its own session, so both voices stay warm', async () => {
    const gw = gateway()
    const speech = speechFor(gw)
    await speech.say('riotcoder', 'Over to you.', 'a')
    await speech.say('cha0spunk', 'Thanks, RiotCoder.', 'b')
    expect(gw.sessionsOpened()).toBe(2)
    expect(gw.calls.filter((c) => c.path === '/v1/sessions' && c.method === 'POST').map((c) => c.body.voice)).toEqual(['am_michael', 'af_bella'])
  })

  test('a session the gateway has lost is reopened and the line still gets said', async () => {
    const gw = gateway({ loseSessionOnce: true })
    const speech = speechFor(gw)
    const line = await speech.say('riotcoder', 'Still here.', 'x')
    expect(line?.url).toContain('/speech/')
    expect(gw.sessionsOpened()).toBe(2)
  })

  test('an answer that is not a WAV renders nothing, so the caller can fall back', async () => {
    const speech = speechFor(gateway({ junk: true }))
    expect(await speech.say('riotcoder', 'Hello.', 'y')).toBeNull()
  })

  test('no node to pin renders nothing rather than hanging the call', async () => {
    const speech = speechFor(gateway({ openFails: true }))
    expect(await speech.say('riotcoder', 'Hello.', 'z')).toBeNull()
    expect(await speech.warm(['riotcoder', 'cha0spunk'])).toEqual([])
  })

  test('warming both hosts before an episode pins both voices', async () => {
    const gw = gateway()
    expect(await speechFor(gw).warm(['riotcoder', 'cha0spunk'])).toEqual(['am_michael', 'af_bella'])
    expect(gw.sessionsOpened()).toBe(2)
  })

  test('a path token is stable for a line and unguessable without the secret', () => {
    expect(audioToken('ep5-1', 's')).toBe(audioToken('ep5-1', 's'))
    expect(audioToken('ep5-1', 's')).not.toBe(audioToken('ep5-2', 's'))
    expect(audioToken('ep5-1', 's')).not.toBe(audioToken('ep5-1', 'other'))
    expect(audioToken('ep5-1', 's')).toMatch(/^[0-9a-f]{32}$/)
  })

  test('wavSeconds reads the header rather than guessing', () => {
    expect(wavSeconds(wav(24000))).toBe(1)
    expect(wavSeconds(new Uint8Array(10))).toBe(0)
  })
})

describe('the speech routes', () => {
  test('a rendered line is served to Telnyx without a key, and an unknown token is a 404', async () => {
    const { req, app } = setup()
    const said = await req('POST', '/api/v1/speech/say', { agent: 'cha0spunk', text: 'Thanks for having us.', id: 'ep5-7' })
    expect(said.status).toBe(200)
    const line = (await said.json()) as { url: string; voice: string; seconds: number }
    expect(line.voice).toBe('af_bella')
    // Telnyx's media loader carries none of our credentials: no auth header here.
    const audio = await app.request(new URL(line.url).pathname)
    expect(audio.status).toBe(200)
    expect(audio.headers.get('content-type')).toBe('audio/wav')
    expect((await audio.arrayBuffer()).byteLength).toBe(44 + 2400 * 2)
    expect((await app.request(`/speech/${'0'.repeat(32)}.wav`)).status).toBe(404)
  })

  test('saying a line needs the admin key', async () => {
    const { app } = setup()
    const res = await app.request('/api/v1/speech/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) })
    expect(res.status).toBe(401)
  })

  test('an empty line is refused', async () => {
    const { req } = setup()
    expect((await req('POST', '/api/v1/speech/say', { agent: 'riotcoder', text: '   ' })).status).toBe(400)
  })

  test('warming the hosts pins both voices', async () => {
    const { req } = setup()
    const res = await req('POST', '/api/v1/speech/warm', {})
    expect(await res.json()).toEqual({ warm: ['am_michael', 'af_bella'] })
  })
})

describe('a co-hosted episode', () => {
  test('rings the guest and never dials the SIP host agent', async () => {
    const { gc, store, req } = setup({ live: [{ kind: 'person', name: 'Anthony' }] })
    const res = await req('POST', '/api/v1/episodes', { cohosts: true, topic: 'Two hosts, one guest', variant: 'riff' })
    expect(res.status).toBe(202)
    const ep = (await res.json()) as { n: number; room: string; cohosts?: boolean }
    expect(ep.room).toBe('8625')
    expect(ep.cohosts).toBe(true)
    expect(store.episode(ep.n)!.cohosts).toBe(true)
    // The recording is on and the guest was rung.
    expect(gc.calls.some((c) => c.path === '/api/v1/rooms/8625/record' && c.body?.on === true)).toBe(true)
    const rings = gc.calls.filter((c) => c.path === '/api/v1/rooms/8625/call')
    expect(rings.length).toBeGreaterThan(0)
    // Every call into the room is a phone ring; none is a SIP dial of the host.
    for (const ring of rings) {
      expect(ring.body.phone).toBe('+14085550101')
      expect(ring.body.sip).toBeUndefined()
    }
    await Bun.sleep(120)
    expect(gc.calls.filter((c) => c.path === '/api/v1/rooms/8625/call' && c.body?.sip).length).toBe(0)
    expect(store.episode(ep.n)!.status).toBe('live')
  })

  test('the plan gives both legs, their voices, the room and the number to dial it on', async () => {
    const { req } = setup({ live: [{ kind: 'person', name: 'Anthony' }] })
    const ep = (await (await req('POST', '/api/v1/episodes', { cohosts: true, topic: 'The fleet', variant: 'deep' })).json()) as { n: number }
    const plan = (await (await req('GET', `/api/v1/episodes/${ep.n}/cohosts`)).json()) as any
    expect(plan.room).toBe('8625')
    expect(plan.dialIn).toBe('+15106169327')
    expect(plan.variant).toBe('deep')
    expect(plan.legs.map((l: any) => [l.agent, l.voice])).toEqual([
      ['riotcoder', 'am_michael'],
      ['cha0spunk', 'af_bella'],
    ])
    // A leg outlasts the format a little, so the sign-off is never cut off.
    expect(plan.legs[0].maxMinutes).toBe(95)
    expect(plan.legs[0].brief).toContain('lead host')
    expect(plan.legs[1].brief).toContain('RiotCoder leads')
  })

  test('an opened room is refused for co-hosts: their legs dial in themselves', async () => {
    const { req } = setup()
    const res = await req('POST', '/api/v1/episodes', { cohosts: true, open: true })
    expect(res.status).toBe(400)
  })
})

describe("the co-hosts' brief", () => {
  test('tells each host to interview the guest, not the other host', () => {
    const lead = cohostBrief({ agent: 'riotcoder', episode: 5, topic: 'The fleet', variant: 'riff', guestName: 'Anthony Ettinger' })
    const second = cohostBrief({ agent: 'cha0spunk', episode: 5, topic: 'The fleet', variant: 'riff', guestName: 'Anthony Ettinger' })
    expect(lead).toContain('YOU ARE INTERVIEWING THE GUEST')
    expect(lead).toContain('Do not interview ChaosPunk')
    expect(second).toContain('Do not interview RiotCoder')
    // One host per turn: the other stays quiet rather than answering too.
    expect(second).toContain('PASS')
    // The lead opens and closes the show.
    expect(lead).toContain('This has been Off The Record')
    expect(second).not.toContain('do a ten-second cold open')
    // What is on the record about Anthony travels with the brief.
    expect(lead).toContain('Moshpit')
    expect(lead).toContain('about 60 minutes')
  })

  test("a signed-up guest's brief carries only what they told us", () => {
    const brief = cohostBrief({ agent: 'riotcoder', episode: 9, topic: 'Their stack', variant: 'sprint', guestName: 'Ada Lovelace', about: 'I build a Rust TUI for ops.' })
    expect(brief).toContain('I build a Rust TUI for ops.')
    expect(brief).not.toContain('Moshpit')
    expect(brief).toContain('about 35 minutes')
  })
})
