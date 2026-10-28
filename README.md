# Off The Record

**How a Silicon Valley veteran programmer uses fleet engineering and agentic coding bots to build out a new internet.**

A long-form podcast: riotcoder, an AI host (an ElevenLabs agent), interviews Anthony Ettinger of Profullstack over a phone line, recorded on [group.call](https://group.call.pit.world). Listen at **https://offtherecord.podcast.pit.world** (feed: `/feed.xml`). Moshpit names: `offtherecord.podcast`, and `otr.podcast`, which redirects.

## How an episode is made

1. `otr record` makes a group.call room that records, and rings Anthony (press 1).
2. When he is on the line, the room dials the host in over SIP
   (`sip:+15106169327@sip.rtc.elevenlabs.io`), with `X-Otr-Episode`, `X-Otr-Style`,
   `X-Otr-Minutes` and `X-Otr-Topic` headers. ElevenLabs hands those to the agent as
   `{{sip_otr_*}}` dynamic variables, so one agent plays every format.
3. The host calls `check_clock` (`GET /api/host/clock`) to land on time, then `end_call`.
4. When the call ends, group.call saves the mp3. Every minute the server picks it up,
   levels it to -16 LUFS with ffmpeg, and writes a title and show notes from the
   speaker-labelled transcript (Gemini).
5. It publishes itself as soon as it is ready (set `OTR_AUTOPUBLISH=0` to hold it as `ready` for `otr publish <n>`).

## Drops and errors

Nothing needs a manual restart. Every 5 seconds the server checks the live room:

- **Host dropped**, guest still on: the host is dialled back in, up to 3 times, 30 s apart.
- **Guest dropped** (host waiting, or both gone): the guest is rung back, up to 3 times, a
  minute apart. An unanswered first ring is rung again the same way.
- **Host signed off** (`end_call`, read from the ElevenLabs conversation): no redial, no re-ring.
- **group.call errors** on start, ring or host dial are retried 3 times, 10 s apart.
- A ring left behind by a restart is picked back up; the counters live in the database.
- Out of tries, the episode is **abandoned**: what was recorded is kept (split recordings
  are joined in order) and held as `ready`, never autopublished, and `OTR_NOTIFY_CMD` (a
  shell command, the message on stdin) tells the operator.

## Guests

Anyone can sign up at **/guest** (free): name, phone, who they are, a topic, a link, and
consent to be recorded and published. `otr guests` lists sign-ups; `otr record --guest <id>`
rings that guest instead of Anthony, and the host gets `X-Otr-Guest` and `X-Otr-About`
(`{{sip_otr_guest}}`, `{{sip_otr_about}}`) so it interviews them, not him. A guest moves
`new` -> `booked` -> `recorded` (back to `new` on a missed call); `otr guest <id> decline`.
Phone numbers and emails only leave through the admin API.

## Formats (A/B)

Four formats in `src/variants.ts`: **riff** (Rogan-style hang, 60 min), **deep** (Fridman-style,
90), **sprint** (35), **marathon** (about 2 h). Two are tested at a time (`ACTIVE_ARMS`), and
the next episode takes whichever has fewer. `/stats` shows plays per episode in each
episode's first 7 days and web listen-through. After editing a format: `otr host sync`.

## CLI

```
OTR_ADMIN_KEY=... bun bin/otr record [--topic "..."] [--variant deep] [--guest <id>]
otr guests | guest <id> decline|new
otr episodes | show <n> | publish <n> | unpublish <n> | title <n> <title> | stats | host sync
```

## Run it

Bun + Hono + bun:sqlite. Settings in `$OTR_STATE/app.env` (see `bin/install.conf`);
deploy on dev2 with `./bin/install.sh`. Port 8814.
