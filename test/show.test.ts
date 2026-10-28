import { describe, expect, setSystemTime, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { createApp } from '../src/server.ts'
import { pickVariant } from '../src/variants.ts'

const MP3 = new Uint8Array(1000).map((_, i) => i % 251)

/** A fake group.call: records calls, answers like the real API. */
function groupcall() {
  const calls: { method: string; path: string; body: any }[] = []
  let live: { kind: string; name: string }[] = []
  let recordings: any[] = []
  let roomsList: { code: string; name: string }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
    if (u.pathname === '/api/v1/rooms' && method === 'POST') return json({ code: '4821' }, 201)
    if (u.pathname === '/api/v1/rooms' && method === 'GET') return json({ rooms: roomsList })
    if (u.pathname === '/api/v1/rooms/4821' && method === 'GET') return json({ code: '4821', live })
    if (u.pathname.endsWith('/record')) return json({ record: true, recording: false })
    if (u.pathname.endsWith('/call')) return json({ ringing: true }, 202)
    if (u.pathname.endsWith('/recordings')) return json({ recordings })
    if (u.pathname.endsWith('/transcript')) return json({ lines: [{ who: 'riotcoder (host)', text: 'Welcome.', at: '' }, { who: 'Anthony', text: 'Thanks.', at: '' }] })
    if (u.pathname === '/api/v1/recordings/rec_1.mp3') return new Response(MP3)
    return json({ error: 'not found' }, 404)
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch, setLive: (l: typeof live) => (live = l), setRecordings: (r: any[]) => (recordings = r), setRoomsList: (r: typeof roomsList) => (roomsList = r) }
}

function setup(extra: Record<string, unknown> = {}) {
  const gc = groupcall()
  const store = new Store(':memory:')
  const dir = `${process.env.TMPDIR ?? '/tmp'}/otr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const { app, show } = createApp({
    store,
    adminKey: 'admin',
    salt: 'salt',
    config: { origin: 'https://otr.test', audioDir: dir, groupcallUrl: 'https://gc.test', groupcallKey: 'gc_x', guestPhone: '+14085550101', guestName: 'Anthony', hostSip: 'sip:+15106169327@sip.rtc.elevenlabs.io;transport=tcp', hostToolSecret: 'tool', fetch: gc.fetch, ffmpeg: null, answerTimeoutMs: 50, log: () => {}, ...extra },
  })
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { gc, store, app, show, req }
}

test('formats alternate between the two arms under test, least used first', () => {
  expect(pickVariant([])).toBe('riff')
  expect(pickVariant([{ variant: 'riff', n: 1 }])).toBe('deep')
  expect(pickVariant([{ variant: 'riff', n: 1 }, { variant: 'deep', n: 2 }])).toBe('riff')
  expect(pickVariant([{ variant: 'deep', n: 1 }, { variant: 'riff', n: 2 }])).toBe('deep')
})

describe('an episode, start to finish', () => {
  test('rings the guest, dials the host in with the episode in X- headers, picks up the mp3, waits for publish', async () => {
    const { gc, store, show, req, app } = setup()
    gc.setLive([{ kind: 'person', name: 'Anthony' }])
    const ep = await show.start({ topic: 'Moshpit', variant: 'deep', wait: true })
    expect(ep.n).toBe(1)
    const paths = gc.calls.map((c) => `${c.method} ${c.path}`)
    expect(paths.slice(0, 4)).toEqual(['GET /api/v1/rooms', 'POST /api/v1/rooms', 'POST /api/v1/rooms/4821/record', 'POST /api/v1/rooms/4821/call'])
    expect(gc.calls[3]!.body).toEqual({ phone: '+14085550101', name: 'Anthony' })
    const host = gc.calls.find((c) => c.body?.sip)!
    expect(host.body.headers).toEqual({ 'X-Otr-Episode': '1', 'X-Otr-Style': 'deep', 'X-Otr-Minutes': '90', 'X-Otr-Topic': 'Moshpit', 'X-Otr-Guest': 'Anthony Ettinger', 'X-Otr-About': 'the show founder', 'X-Otr-Waiting': 'no', 'X-Otr-Hello': 'Hey Anthony Ettinger, riotcoder here. We are recording episode 1 of Off The Record, on Moshpit. Quick word on the format first.' })
    expect(store.episode(1)!.status).toBe('live')

    // A second episode cannot start over a live one.
    expect((await req('POST', '/api/v1/episodes', {})).status).toBe(409)

    gc.setRecordings([{ id: 'rec_1', status: 'ready', mp3: 'https://gc.test/api/v1/recordings/rec_1.mp3', duration_secs: 5400, started_at: new Date().toISOString() }, { id: 'rec_old', status: 'ready', mp3: 'https://gc.test/old.mp3', duration_secs: 9000, started_at: '2020-01-01T00:00:00Z' }])
    await show.tick()
    const ready = store.episode(1)!
    expect(ready.status).toBe('ready')
    expect(ready.durationSecs).toBe(5400)
    expect(ready.transcript).toContain('Anthony: Thanks.')
    // Not public until published.
    expect((await app.request('/audio/1.mp3')).status).toBe(404)
    expect(await (await app.request('/feed.xml')).text()).not.toContain('<item>')

    expect((await req('POST', '/api/v1/episodes/1/publish')).status).toBe(200)
    const feed = await (await app.request('/feed.xml')).text()
    expect(feed).toContain('<enclosure url="https://offtherecord.podcast.pit.world/audio/1.mp3" length="1000" type="audio/mpeg"/>')
    expect(feed).toContain('<itunes:duration>01:30:00</itunes:duration>')

    const whole = await app.request('/audio/1.mp3', { headers: { 'user-agent': 'Overcast/3.0' } })
    expect(whole.status).toBe(200)
    expect(new Uint8Array(await whole.arrayBuffer()).length).toBe(1000)
    const part = await app.request('/audio/1.mp3', { headers: { range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...MP3.slice(10, 20)])
    expect(store.downloadsOf(1)).toBe(1)
    await app.request('/audio/1.mp3', { headers: { 'user-agent': 'Overcast/3.0' } })
    expect(store.downloadsOf(1)).toBe(1)
    expect((await app.request('/e/1')).status).toBe(200)
  })

  test('a guest who never picks up leaves the episode missed, and no host is dialled', async () => {
    const { gc, store, show } = setup()
    await show.start({ wait: true })
    expect(store.episode(1)!.status).toBe('missed')
    expect(gc.calls.some((c) => c.body?.sip)).toBe(false)
  })
})

test("the host's clock says when to wrap up, and only the host can read it", async () => {
  const { store, app, show } = setup()
  const ep = store.addEpisode({ topic: 't', variant: 'sprint' })
  store.update(ep.n, { hostJoinedAt: Date.now() - 32 * 60_000 })
  expect(show.clock(ep.n).advice).toMatch(/Start wrapping up/)
  expect((await app.request(`/api/host/clock?episode=${ep.n}`)).status).toBe(403)
  const r = await app.request(`/api/host/clock?episode=${ep.n}`, { headers: { 'x-otr-secret': 'tool' } })
  expect(((await r.json()) as any).target_minutes).toBe(35)
})

test('otr.podcast redirects to the show; admin needs the key', async () => {
  const { app } = setup()
  const r = await app.request('/e/3', { headers: { host: 'otr.podcast' } })
  expect(r.status).toBe(301)
  expect(r.headers.get('location')).toBe('https://offtherecord.podcast.pit.world/e/3')
  expect((await app.request('/api/v1/episodes')).status).toBe(401)
  expect((await app.request('/')).status).toBe(200)
  expect((await app.request('/stats')).status).toBe(200)
})

describe('guests', () => {
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()
  const post = (app: ReturnType<typeof setup>['app'], fields: Record<string, string>) =>
    app.request('/guest', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(fields) })
  const ok = { name: 'Ada', phone: '(408) 555-0199', about: 'I run a dozen coding agents on a home server.', topic: 'Agents at home', consent: '1' }

  test('signs up from the form, phone made E.164, nothing private on the page', async () => {
    const { app, store } = setup()
    const page = await (await app.request('/guest')).text()
    expect(page).toContain('action="/guest"')
    const res = await post(app, ok)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('You are on the list, Ada.')
    const [g] = store.guests()
    expect(g).toMatchObject({ name: 'Ada', phone: '+14085550199', status: 'new', topic: 'Agents at home' })
    // The same phone again updates the sign-up instead of adding one.
    await post(app, { ...ok, about: 'Updated.' })
    expect(store.guests().length).toBe(1)
    expect(store.guests()[0]!.about).toBe('Updated.')
  })

  test('refuses a bad phone, missing consent, and keeps nothing from a bot', async () => {
    const { app, store } = setup()
    expect((await post(app, { ...ok, phone: '12345' })).status).toBe(400)
    const noConsent = await post(app, { ...ok, consent: '' })
    expect(noConsent.status).toBe(400)
    expect(await noConsent.text()).toContain('value="Ada"')
    expect((await post(app, { ...ok, website: 'http://spam.test' })).status).toBe(200)
    expect(store.guests().length).toBe(0)
  })

  test('an episode with a guest rings their phone and tells the host who they are', async () => {
    const { app, gc, store, req } = setup()
    await post(app, { ...ok, phone: '+44 20 7946 0958', link: 'https://ada.test' })
    const g = store.guests()[0]!
    gc.setLive([{ kind: 'person', name: 'Ada' }])
    const res = await req('POST', '/api/v1/episodes', { guest: g.id, variant: 'sprint' })
    expect(res.status).toBe(202)
    expect(gc.calls.find((c) => c.body?.phone)!.body).toEqual({ phone: '+442079460958', name: 'Ada' })
    await new Promise((ok) => setTimeout(ok, 20))
    const host = gc.calls.find((c) => c.body?.sip)!
    expect(host.body.headers).toMatchObject({ 'X-Otr-Guest': 'Ada', 'X-Otr-Topic': 'Agents at home', 'X-Otr-About': 'I run a dozen coding agents on a home server. https://ada.test' })
    expect(store.guest(g.id)!.status).toBe('booked')
    expect(store.episode(1)!.guestId).toBe(g.id)
    const list = await (await req('GET', '/api/v1/guests')).json()
    expect(list.guests[0].phone).toBe('+442079460958')
    expect((await app.request('/api/v1/guests')).status).toBe(401)
  })
})

test('host briefs the guest on the format before the cold open', async () => {
  const { hostPrompt, FIRST_MESSAGE } = await import('../src/variants.ts')
  expect(hostPrompt()).toContain('brief the guest on this episode\'s format')
  expect(FIRST_MESSAGE).toBe('{{sip_otr_hello}}')
})

test('autopublish holds a call that never got going, and publishes a real one', async () => {
  for (const [secs, published] of [[240, false], [2100, true]] as const) {
    const { gc, store, show } = setup({ autopublish: true })
    gc.setLive([{ kind: 'person', name: 'Anthony' }])
    await show.start({ topic: 'Moshpit', variant: 'sprint', wait: true })
    gc.setRecordings([{ id: 'rec_1', status: 'ready', mp3: 'https://gc.test/api/v1/recordings/rec_1.mp3', duration_secs: secs, started_at: new Date().toISOString() }])
    await show.tick()
    expect(store.episode(1)!.status).toBe(published ? 'published' : 'ready')
  }
})

describe('someone dials the room themselves', () => {
  test('the host is dialled in within a tick, nobody is rung, and only once', async () => {
    const { gc, store, show } = setup()
    gc.setRoomsList([{ code: '4821', name: 'Off The Record' }])
    await show.door()
    expect(store.episodes().length).toBe(0)
    gc.setLive([{ kind: 'person', name: 'a caller' }])
    await show.door()
    expect(store.episode(1)!.status).toBe('live')
    expect(gc.calls.some((c) => c.body?.phone)).toBe(false)
    expect(gc.calls.filter((c) => c.body?.sip).length).toBe(1)
    expect(gc.calls.some((c) => c.path === '/api/v1/rooms/4821/record')).toBe(true)
    gc.setLive([{ kind: 'person', name: 'a caller' }, { kind: 'agent', name: 'riotcoder (host)' }])
    await show.door()
    expect(gc.calls.filter((c) => c.body?.sip).length).toBe(1)
  })
})

describe('the host drops mid-episode', () => {
  test('it is dialled back in up to 3 times, 30 seconds apart, only while a caller is on', async () => {
    const { gc, show } = setup()
    const t0 = Date.now()
    try {
      setSystemTime(t0)
      gc.setLive([{ kind: 'person', name: 'Anthony' }])
      await show.start({ variant: 'deep', wait: true })
      const hosts = () => gc.calls.filter((c) => c.body?.sip)
      expect(hosts().length).toBe(1)
      gc.setLive([{ kind: 'person', name: 'Anthony' }, { kind: 'agent', name: 'riotcoder (host)' }])
      await show.door()
      expect(hosts().length).toBe(1)
      // The host's leg is gone; Anthony is still on.
      gc.setLive([{ kind: 'person', name: 'Anthony' }])
      await show.door()
      expect(hosts().length).toBe(1) // not within 30 s of the last dial
      for (let i = 1; i <= 3; i++) {
        setSystemTime(t0 + i * 31_000)
        await show.door()
        await show.door()
        expect(hosts().length).toBe(1 + i)
      }
      expect(hosts().at(-1)!.body.headers['X-Otr-Hello']).toContain('my line dropped')
      setSystemTime(t0 + 5 * 31_000)
      await show.door()
      expect(hosts().length).toBe(4) // three redials, then it stops
      expect(gc.calls.some((c) => c.body?.phone && c !== gc.calls[3])).toBe(false)
    } finally {
      setSystemTime()
    }
  })

  test('no redial once the caller has gone too', async () => {
    const { gc, show } = setup()
    const t0 = Date.now()
    try {
      gc.setLive([{ kind: 'person', name: 'Anthony' }])
      await show.start({ variant: 'deep', wait: true })
      gc.setLive([])
      setSystemTime(t0 + 60_000)
      await show.door()
      expect(gc.calls.filter((c) => c.body?.sip).length).toBe(1)
    } finally {
      setSystemTime()
    }
  })
})

describe('the host opens the room and waits for callers', () => {
  test('dials the host in first, rings nobody, starts the clock on the first caller', async () => {
    const { gc, store, req } = setup()
    const res = await req('POST', '/api/v1/episodes', { open: true })
    expect(res.status).toBe(202)
    expect(gc.calls.some((c) => c.body?.phone)).toBe(false)
    const host = gc.calls.find((c) => c.body?.sip)!
    expect(host.body.headers['X-Otr-Waiting']).toBe('yes')
    expect(host.body.headers['X-Otr-Hello']).toContain('holding the line')
    const ep = store.episode(1)!
    expect(ep.status).toBe('live')
    expect(ep.hostJoinedAt).toBeNull()
    expect((await req('POST', '/api/v1/episodes', { open: true })).status).toBe(409)
  })

  test('the first caller starts the clock and no second host is dialled', async () => {
    const { gc, store, show } = setup()
    await show.start({ open: true })
    gc.setLive([{ kind: 'agent', name: 'riotcoder (host)' }])
    await show.door()
    expect(store.episode(1)!.hostJoinedAt).toBeNull()
    gc.setLive([{ kind: 'agent', name: 'riotcoder (host)' }, { kind: 'person', name: 'Anthony' }])
    await show.door()
    expect(store.episode(1)!.hostJoinedAt).not.toBeNull()
    expect(store.episode(1)!.note).toBe('')
    expect(gc.calls.filter((c) => c.body?.sip).length).toBe(1)
  })

  test('a host left alone after the callers hung up does not block opening the room again', async () => {
    const { gc, store, show, req } = setup()
    gc.setLive([{ kind: 'person', name: 'Anthony' }])
    await show.start({ variant: 'deep', wait: true })
    expect((await req('POST', '/api/v1/episodes', { open: true })).status).toBe(409)
    gc.setLive([{ kind: 'agent', name: 'riotcoder (host)' }])
    expect((await req('POST', '/api/v1/episodes', { open: true })).status).toBe(202)
    expect(store.episode(1)!.status).toBe('saving')
    expect(store.episode(2)!.status).toBe('live')
    expect(store.episode(2)!.note).toBe('waiting for callers')
  })

  test('nobody called in: the recording is not an episode', async () => {
    const { gc, store, show } = setup({ autopublish: true })
    await show.start({ open: true })
    gc.setRecordings([{ id: 'rec_1', status: 'ready', mp3: 'https://gc.test/api/v1/recordings/rec_1.mp3', duration_secs: 1200, started_at: new Date().toISOString() }])
    await show.tick()
    expect(store.episode(1)!.status).toBe('missed')
    expect(store.episode(1)!.note).toBe('nobody called in')
  })
})
