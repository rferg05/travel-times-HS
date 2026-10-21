# Travel Times

Home Screens module: door-to-door times by **public transit, Uber, Lyft and car** for your saved routes (Work, School...) and for upcoming calendar events, each tagged with the family member it's for.

## What it shows

- **Routes**: one card per saved route that's active right now. A route can be limited to certain days and hours ("Work, weekdays 6:00–10:00"), so the wall only shows the commute when it matters, and only looks it up then.
- **Upcoming**: the next timed calendar events that have a real address (Zoom/Teams/Meet links and all-day events are skipped). Each one shows **when to leave** by each mode to arrive a few minutes early.
- **Who it's for**: a route's *Who it's for* name is matched against Settings > Family. An event is tagged with whoever's calendar it came from. The card's left edge and name tag use that person's color.
- **Tiles**, one per mode:
  - **Transit**: door-to-door minutes, including walks; the line(s) to take; when to leave; the next departures after it.
  - **Uber / Lyft**: wait for the car plus the ride; price range; how far away the nearest car is. A `~` means the ride length is the drive time standing in, because the service didn't give one.
  - **Drive**: minutes in current traffic and how much traffic adds.
  - **fastest** marks whichever mode gets there first if you leave now. A leave time turns amber within 10 minutes and says *leave now* / *too late* after that.

## Install

In the Home Screens editor, open the Plugin Store, choose **Install from URL**, and paste:

```
https://github.com/rferg05/travel-times-HS/releases/latest/download/travel-times.tar.gz
```

This always points at the newest release. Home Screens doesn't check URL-installed plugins for updates on its own, so to update: Plugin Store > **Installed**, then the download icon on Travel Times, then **Install**.

## Setup

Open Plugin Store > **Installed** > Travel Times and fill in the credentials below. Only Google is required; Uber and Lyft tiles say "not set up" until they're connected (or turn them off in the module settings).

### 1. Google Maps (transit and driving) — required

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project, enable **Routes API**, and attach billing.
2. APIs & Services > Credentials > **Create credentials > API key**. Restrict it to the Routes API.
3. Paste it into **Google Maps API key**. If the built-in Traffic module already has a key with the Routes API enabled, the same key works.

### 2. Uber

On [developer.uber.com](https://developer.uber.com/dashboard), create an app and choose the **Ride Requests** API suite (the Riders API). Don't pick *Uber for Business*, *Guest Rides* or *Uber Drivers*: those are partner programs for businesses and fleets.

1. In the app's **Auth** tab:
   - Copy the **Client ID** and **Client Secret** into the plugin's Uber fields.
   - Under **Redirect URIs**, add `http://localhost:3000/api/plugins/auth/callback`.
   - Under scopes, tick **profile** and **request**.
2. Connect: the sign-in has to be started from an editor opened at `http://localhost:3000`, because Uber only accepts `https` or `localhost` redirect addresses and the Pi serves plain `http`. Either open the editor in a browser on the Pi itself, or forward the port from another computer:

   ```bash
   ssh -L 3000:localhost:3000 pi@home-screens.local
   ```

   then open `http://localhost:3000` on that computer, go to Plugin Store > Installed > Travel Times, and press **Connect**. Sign in with your own Uber account. The host stores and refreshes the token from then on.

How it gets prices: Uber's price and time estimate endpoints need approval from Uber before a new app can use them. Until then, the module uses Uber's request-estimate endpoint, which the **request** scope allows for the app's own developers without review. Since you're the developer and this is your own display, that's enough; it switches on its own the first time the estimate endpoints refuse. If the tile ever says *Uber access pending*, both were refused: request access to the estimate endpoints from the app's dashboard.

### 3. Lyft

Lyft's public API is mostly closed to new developers: the old `developer.lyft.com` site no longer exists and the developer portal at [lyft.com/developers](https://www.lyft.com/developers) needs a sign-in. If your account can still create an app there:

1. Create an app and copy its **Client ID** and **Client Secret**.
2. The plugin needs them joined as `id:secret` and base64-encoded. In PowerShell:

   ```powershell
   [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('CLIENT_ID:CLIENT_SECRET'))
   ```

3. Paste the result into **Lyft client credentials**.

This uses Lyft's read-only client-credentials token (cost and pickup-time estimates only). The host's one sign-in slot per plugin is Uber's, so this token is requested by the module itself. The client secret still never leaves the Pi, only the day-long read-only token does. If Lyft won't give you credentials, turn the Lyft tile off.

## Settings

| Setting | Default | |
|---|---|---|
| Saved routes | one *Work* route | Name, who it's for, from, to, days, and an optional time window. *From* left blank uses the home address. Addresses or `lat,lon`. |
| Public transit / Uber / Lyft / Drive | all on | Which tiles to show. |
| Transit departures to list | 2 | The first, plus "then 8:12, 8:20". |
| Uber ride type | UberX | Matched by name: Comfort, UberXL, Black... |
| Lyft ride type | Lyft | |
| Upcoming events | on | Needs a **home address**: trips to events start there. |
| Look ahead | 12 h | |
| Events to show | 3 | |
| Uber/Lyft for events starting within | 3 h | Ride prices are only good for now. |
| Arrive early by | 5 min | Built into every leave time. |
| Skip events whose title contains | | e.g. `WFH, Zoom` |
| Check times every | 10 min | |
| Pause lookups | 23:00–05:30 | Shows the last times overnight without asking for new ones. |

## API usage and cost

Each check of one trip is **2 Google requests** (transit and drive), plus 2 to Uber and 2 to Lyft if those are on. Answers are kept between screen rotations, so showing the module on several screens doesn't add requests.

With the defaults (10 minutes, paused 23:00–05:30) a trip that shows all day is about **210 Google requests a day, ~6,300 a month**. A weekday commute limited to 6:00–10:00 is closer to 1,000 a month. Traffic-aware driving and transit are billed under Google's Routes API (Compute Routes); check the [Routes API pricing page](https://developers.google.com/maps/billing-and-pricing/pricing) for the current free monthly allowance and set a budget alert. Time windows on routes and a longer check interval are the two ways to cut usage.

Requests go out one at a time, at most 50 a minute, under the host proxy's 60-a-minute limit.

## Development

```bash
npm install
npm test             # parsers, schedules, events, leave times
npm run preview      # module against mock Google/Uber/Lyft at http://localhost:5175
npm run build        # dist/bundle.js
```

The preview takes `?w=&h=` for the module size, `fs=` for text size, and any config key.

Release tarball:

```bash
mkdir -p release/pkg/travel-times/dist
cp manifest.json release/pkg/travel-times/
cp dist/bundle.js dist/bundle.js.map release/pkg/travel-times/dist/
tar -czf release/travel-times-<version>.tar.gz -C release/pkg travel-times
```

Attach it to a GitHub release tagged `v<version>`, along with a copy named `travel-times.tar.gz` so the `latest/download` URL above keeps working:

```bash
cp release/travel-times-<version>.tar.gz release/travel-times.tar.gz
gh release create v<version> release/travel-times-<version>.tar.gz release/travel-times.tar.gz --title v<version>
```
