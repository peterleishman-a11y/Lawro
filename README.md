# Lawro

[![tests](https://github.com/peterleishman-a11y/Lawro/actions/workflows/test.yml/badge.svg)](https://github.com/peterleishman-a11y/Lawro/actions/workflows/test.yml)

A score-prediction league for the **Lawro** WhatsApp group. Players sign in on
their phone, tap in ten scores, and the table works itself out.

Built because forty people replying to a WhatsApp message in twelve different
formats is not a spreadsheet, it's a hostage situation.

## The rules it implements

| | |
|---|---|
| Correct score | **40 points** |
| Correct result | **10 points** |
| Entry | **€25** |
| Season winner | **80%** of the pot |
| Best single round | **20%** of the pot |
| Miss a round | credited with **Chris Sutton's** picks, result only — never a 40 |

All six are settings, not constants. Change them in **Admin → League settings**.

## How it works

**Players** pick their name from a dropdown, enter a 4-digit PIN, and get a
list of the week's fixtures with a plus/minus stepper on each team. Predictions
save whenever they like and can be edited right up to the deadline. After the
deadline the round locks, everyone's picks become visible, and the table opens.

**The organiser** creates a round by pasting the fixture list — the same text
sent to the group, nicknames and all. `B'mouth`, `Liverpoo`, `NottsForest`,
`Cry Palace` and friends all resolve to real clubs. Then results go in by hand
or straight from the BBC, and the tables update.

Nobody sees anybody else's picks before the deadline.

## Anyone still replying in WhatsApp

**Admin → a round → Import from WhatsApp** takes a chat export and files
everyone's picks into that round. It was built against a real export and
copes with what people actually send:

```
Arsenal 2-0 Coventry        Arsenal v Coventry 3-0      Arsenal 3 v 0 Coventry
Ars-Cov 2:0                 Man City v B'mouth  3- 1     Brentford v Spurs 0'2
Hull 0-3Man Utd             Newcastle  1v 2 Liverpool    Fulham v Chelsea 1 - 3
```

as well as emoji in team names (`Hull🐅`), curly apostrophes, en-dashes, teams
written the wrong way round, fixtures listed out of order, a fixture split over
two lines, people who send twice, and one-line corrections after the fact
(*"forgot Bri-Villa hence did I 2:1 please and sorry"*).

The fixture list is worked out from what most people submitted rather than
from one organiser message, so it survives a reworded or missing post.

Anything it had to interpret is listed after the import so it can be checked.

## The BBC

**Results** and **Chris Sutton's predictions** can be pulled from the BBC.

Be aware of what this is: the BBC publishes no supported public API for either.
The results feed is the internal JSON its own site calls, and the predictions
come out of a weekly article. Both can change without warning. Two things stop
that from becoming a problem:

- **Both URLs are settings.** When the BBC moves something, change the address
  in **Admin → League settings** rather than the code.
- **Nothing depends on it.** Every fetch has a manual equivalent — paste the
  article text, or type the ten results in. If the BBC changes shape mid-season
  the league carries on.

The results parser walks the JSON looking for anything fixture-shaped instead
of following a fixed path, so it tolerates a fair amount of reshuffling.

Check the live endpoints from a machine with web access:

```
node src/bbc.js results
node src/bbc.js predictions "https://www.bbc.co.uk/sport/football/articles/..."
```

## Sign-in

Pick a name, type a 4-digit PIN. First time in, you choose the PIN and the name
is yours.

A 4-digit PIN is only 10,000 possibilities, so on its own it is weak — that is
the nature of a 4-digit PIN, not an oversight. What makes it sound enough for a
football sweepstake is everything round it:

- PINs are never stored, only **scrypt** hashes with a per-player salt
- comparison is timing-safe, and an unknown name costs the same time as a wrong PIN
- **5 wrong tries locks the account**, backing off 1, 2, 4… minutes up to an hour
- a per-IP throttle stops one PIN being sprayed across every name
- the most guessable PINs (`0000`, `1234`, years) are refused
- sessions are 32 random bytes, stored server-side, in an httpOnly cookie

Nothing here protects real money or personal data beyond names and football
scores. Don't reuse a PIN that matters.

Forgotten PIN: an admin clears it in **Admin → Players → Reset PIN**, and the
player picks a new one next time they sign in.

## Running it

```bash
npm install
cp .env.example .env        # set ADMIN_NAME, and ADMIN_PIN for the first login
npm start                   # http://localhost:3000
```

Bootstrap a league from an existing WhatsApp export:

```bash
node src/seed.js path/to/_chat.txt "Week 1"
```

That creates the admin, adds Chris Sutton as the pundit, creates the round with
its fixtures, adds every player it finds, and files their picks. Players claim
their own name with a PIN the first time they sign in. It's safe to re-run — it
never overwrites an existing player or PIN.

```bash
npm test                    # 38 tests, no network needed
```

### Deploying

It's a plain Node server with a SQLite file, so it needs a host with a **real
persistent disk**. Config for two is committed:

| | Render | Fly.io |
|---|---|---|
| Config | `render.yaml` | `fly.toml` + `Dockerfile` |
| Setup | Connect repo in dashboard | `fly launch --no-deploy` then `fly deploy` |
| Disk | 1 GB at `/var/data` | 1 GB volume at `/data` |
| Scale to zero | No | Yes (`auto_stop_machines`) |

**Render** — New → Blueprint, point at this repo, it reads `render.yaml`. Note
that Render disks require a paid instance type; free instances get no disk, and
without one the league resets on every deploy.

**Fly** — needs the volume created before the first deploy:

```
fly launch --no-deploy
fly volumes create lawro_data --size 1 --region lhr
fly deploy
```

Then set the first admin, and clear the variables once you've logged in:

```
fly secrets set ADMIN_NAME="Your Name" ADMIN_PIN=1234   # or the Render dashboard
```

**Serverless hosts do not work.** Vercel, Netlify Functions, Cloudflare Workers
and Lambda all have ephemeral filesystems: the SQLite file is recreated empty on
every cold start and isn't shared between invocations, so the app boots, looks
fine, and silently loses every prediction. Going serverless means replacing the
storage layer first — see below.

**Never run more than one instance.** SQLite is one file on one disk, so exactly
one process may write to it. Both configs pin a single machine.

Whatever the host:

- **`DATABASE_PATH` must point at the mounted disk**, not the container filesystem.
- **Set `SECURE_COOKIES=1`** once it's behind HTTPS.
- **`/api/health`** touches the database, so a passing probe means the disk is
  genuinely reachable rather than just Node being up.

Every database call is in `src/db.js` and nothing else touches SQLite. Moving to
a hosted database means rewriting that file — but note `better-sqlite3` is
*synchronous* and hosted clients are *async*, so the ~99 call sites in
`server.js`, `auth.js` and `seed.js` need `await` too. Turso (libSQL) keeps the
SQL identical; Postgres also changes the dialect.

## Layout

```
src/
  server.js    HTTP routes and access rules
  db.js        schema and every SQL query
  auth.js      PIN hashing, sessions, lockout
  scoring.js   points, tables, prize pot
  parser.js    WhatsApp export -> fixtures and picks
  bbc.js       BBC results and Sutton's predictions
  seed.js      bootstrap a league
public/        the mobile-first front end
test/          38 tests
```

## Privacy

Player names and predictions live in your own SQLite file and go nowhere else.
`data/` is gitignored, so nothing about who plays or what they picked is ever
committed. There is no analytics, no third-party script, and the only outbound
requests are the BBC fetches you trigger.
