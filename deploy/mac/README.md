# Running it on a Mac

This is the path the app is built around. It runs as a **login agent**, not a
daemon, because it drives a real Chromium and because the analysis agent uses
the account's own Claude credentials. A daemon has neither.

A Mac left switched on at home is a good host for this. The address Instagram
sees is a residential one, and the browser is a genuine macOS Chromium whose
user agent agrees with the machine underneath.

## 1. Node 22, not whatever is current

`better-sqlite3` has no prebuilt binary for Node 26 and will not compile against
its headers, which leaves the app unable to open its own database.

```bash
brew install node@22
```

`run.sh` puts `/opt/homebrew/opt/node@22/bin` first on `PATH` for this reason.
There is no need to make it your default node.

## 2. The app

```bash
git clone <your fork> ~/curated
cd ~/curated
npm ci
npx playwright install chromium
npm run build
```

## 3. A Claude credential

The analysis agent runs through the Claude Agent SDK. On macOS an interactive
login lives in the keychain, which a launchd job cannot read reliably and a
rebooted machine cannot reach at all until someone signs in at the console. So
use a long-lived token instead:

```bash
mkdir -p ~/.curated && chmod 700 ~/.curated
claude setup-token > ~/.curated/claude-token
chmod 600 ~/.curated/claude-token
```

`run.sh` reads that file and exports it. Nothing else reads it, and it is never
committed.

## 4. The login agent

`com.curated.plist` has `REPO` where the checkout goes. Substitute it as you
install:

```bash
sed "s|REPO|$HOME/curated|g" deploy/mac/com.curated.plist \
  > ~/Library/LaunchAgents/com.curated.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.curated.plist
```

To stop it:

```bash
launchctl bootout gui/$(id -u)/com.curated.app
```

It is supervised with `KeepAlive`, so a crash restarts it. `ThrottleInterval`
keeps a boot loop from hammering Instagram. Logs go to `data/curated.log`.

Deploying a change means stopping it, building, and starting it again, in that
order. Building over a running `next start` overwrites the directory it is
serving from.

## 5. Do not let it sleep

The app holds a browser tab open to hear about new messages, and that stops
while the machine sleeps.

```bash
sudo pmset -a sleep 0 disksleep 0 womp 1
```

Letting the display sleep is fine.

## 6. Sign in

Open `http://localhost:3000/setup`, paste the `sessionid` cookie from a browser
already signed in to Instagram, then pick which conversations to follow with
*Refresh conversations*. With nothing ticked, every conversation is read.

## Reaching it from a phone

Put it behind a Cloudflare tunnel with an Access policy on the hostname. The
connector dials out, so nothing is exposed to the LAN and no port is forwarded,
and the policy sits on the hostname rather than the origin, so it survives the
origin moving.

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create curated
# ingress: your-hostname -> http://localhost:3000
```

Give the machine its **own** tunnel rather than adding a second connector to an
existing one. Two connectors on one tunnel are a load-balanced pair, and
Cloudflare will send requests to whichever, so half of them land on a machine
with a different database.

Something has to keep the connector running. `cloudflared service install` is
one answer. [Tunnelbar](https://github.com/marcusadolfsson/tunnelbar) is
another, and is what the author uses. Pick one: two supervisors on a single
connector produce a flapping tunnel.

## The menu bar app

`menubar/` builds a small status app that says whether the server is up, when
it last synced, and whether anyone can reach it. It is optional, and its own
README covers it.
