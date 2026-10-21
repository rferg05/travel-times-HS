# Travel Times

Home Screens module: door-to-door times by **public transit, rideshare and car** for your saved routes (Work, School...) and for upcoming calendar events, each tagged with the family member it's for.

## What it shows

- **Routes**: one card per saved route that's active right now. A route can be limited to certain days and hours ("Work, weekdays 6:00–10:00"), so the wall only shows the commute when it matters, and only looks it up then.
- **Upcoming**: the next timed calendar events that have a real address (Zoom/Teams/Meet links and all-day events are skipped). Each one shows **when to leave** by each mode to arrive a few minutes early.
- **Who it's for**: a route's *Who it's for* name is matched against Settings > Family. An event is tagged with whoever's calendar it came from. The card's left edge and name tag use that person's color.
- **Tiles**, one per mode:
  - **Transit**: door-to-door minutes, including walks; the line(s) to take; when to leave; the next departures after it.
  - **Rideshare**: an estimate for an Uber or Lyft, from the drive time in traffic plus a wait for the car you set (5 minutes by default). Shown with `~`, and no price. Needs no Uber or Lyft account.
  - **Uber / Lyft** (live quotes, off by default): wait for the car plus the ride; price range; how far away the nearest car is. A `~` means the ride length is the drive time standing in, because the service didn't give one.
  - **Drive**: minutes in current traffic and how much traffic adds.
  - **fastest** marks whichever mode gets there first if you leave now. A leave time turns amber within 10 minutes and says *leave now* / *too late* after that.

## Install

In the Home Screens editor, open the Plugin Store, choose **Install from URL**, and paste:

```
https://github.com/rferg05/travel-times-HS/releases/latest/download/travel-times.tar.gz
```

This always points at the newest release. Home Screens doesn't check URL-installed plugins for updates on its own, so to update: Plugin Store > **Installed**, then the download icon on Travel Times, then **Install**.

## Setup

Open Plugin Store > **Installed** > Travel Times and fill in the credentials below. Only Google is required. The live Uber and Lyft tiles are optional and say "not set up" until they're connected; the Rideshare tile works without either.

### 1. Google Maps (transit and driving) — required

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project, enable **Routes API**, and attach billing.
2. APIs & Services > Credentials > **Create credentials > API key**. Restrict it to the Routes API.
3. Paste it into **Google Maps API key**. If the built-in Traffic module already has a key with the Routes API enabled, the same key works.

### 2. Uber (optional, needs Uber's approval)

Live Uber prices and pickup times aren't self-serve. As of October 2026:

- Uber's developer dashboard no longer offers the Riders API ("Ride Requests") as an API suite. New apps start in a sandbox with only the scopes their suite grants, and the rider suites available (e.g. *Rider3PLTesting*) grant partner-loyalty scopes, not ride estimates.
- The [price](https://developer.uber.com/docs/riders/references/api/v1.2/estimates-price-get) and time estimate endpoints say access "requires approval from Uber" through an Uber business-development contact.
- The older "Limited Access" for an app's own developers doesn't apply: a new app's sign-in request for even the basic `profile` scope comes back `invalid_scope`.

So the Uber tile is off by default and the **Rideshare** tile stands in for it. If Uber does approve an app for ride estimates:

1. In that app's settings, add the redirect URI `http://localhost:3000/api/plugins/auth/callback`, and copy its **Client ID** and **Client Secret** into the plugin's Uber fields.
2. Connect from an editor opened at `http://localhost:3000`, because Uber only accepts `https` or `localhost` redirect addresses and the Pi serves plain `http`. Either use a browser on the Pi itself, or forward the port from another computer:

   ```bash
   ssh -L 3000:localhost:3000 pi@home-screens.local
   ```

   then open `http://localhost:3000`, go to Plugin Store > Installed > Travel Times, and press **Connect**.
3. Turn on **Uber (live quotes)** in the module settings.

The module asks for the `profile` and `request` scopes and uses the v1.2 estimate endpoints, falling back to the request-estimate endpoint if those refuse. An approved app may come with different endpoints or scopes; if so, the Uber code in `src/providers.ts` needs updating to match.

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
| Public transit / Rideshare / Drive | on | Which tiles to show. |
| Wait for a car | 5 min | Added to the drive time on the Rideshare tile. |
| Uber (live quotes) / Lyft | Uber off, Lyft on | Need credentials; see Setup. |
| Transit departures to list | 2 | The first, plus "then 8:12, 8:20". |
| Uber ride type | UberX | Matched by name: Comfort, UberXL, Black... |
| Lyft ride type | Lyft | |
| Upcoming events | on | Needs a **home address**: trips to events start there. |
| Look ahead | 12 h | |
| Events to show | 3 | |
| Uber/Lyft for events starting within | 3 h | Live quotes only; prices are only good for now. The Rideshare tile shows for every event. |
| Arrive early by | 5 min | Built into every leave time. |
| Skip events whose title contains | | e.g. `WFH, Zoom` |
| Check times every | 11 min | Routes, far-away events, and nearby events from 90 minutes before. |
| Google requests per month | 10,000 | Hard limit, counted per display. Lookups stop for the rest of the month once it's reached. |
| Warn at | 80% | A notice on the module from 8,000 requests, and a warning in the Home Screens log. |
| Pause lookups | 23:00–05:30 | Shows the last times overnight without asking for new ones. |

## API usage and cost

**Per check:** one trip is **2 Google requests** (transit and drive), plus 2 to Uber and 2 to Lyft if those are on. The Rideshare tile reuses the drive lookup and costs nothing extra. Answers are kept between screen rotations, so showing the module on several screens of one display doesn't add requests. Addresses typed in the editor are looked up only after they stop changing for 2 seconds.

**When:**
- **Routes** refresh every 11 minutes while they're showing, paused 23:00–05:30. That's about 95 checks, **~190 Google requests a day** per route. A weekday route is about 4,200 a month, or about 950 if it's limited to 6:00–10:00.
- **Events within 50 miles of home** aren't looked up until **3 hours before they start**. They get one look then, and refresh every 11 minutes from **90 minutes before**. That's about 10 checks, **~20 requests per event**. Until the first look the card shows "Travel times from 2:15p".
- **Events 50 miles or more away** refresh like routes for as long as they're in the look-ahead, since a long trip needs its leave time early.

Distance to an event is the straight line from home, which is the household location in Settings, or the module's home address if none is set. The event's address is placed with OpenStreetMap's free [Nominatim](https://nominatim.org/) geocoder, not Google, and each address is remembered for a month. An event whose address can't be placed is treated as nearby.

**Monthly limit:** the module counts every Google request it sends and stops at **10,000 per calendar month**. When the next one would go over, it keeps showing the last times and says *Monthly limit reached* until the 1st. From **80% (8,000)** it shows the count on the module and writes a warning to the Home Screens log. Two weekday commutes plus an event a day is roughly 9,000 a month, about 300 a day on weekdays. At that pace, the last 2,000 requests after the warning last about a week, which is time to trim a route's hours before lookups stop.

The count is kept in the display's browser storage, so it survives reboots. It's **per display**: a second display, or the editor open on a laptop, counts separately. For a limit that covers everything, also set one on Google's side:

1. **Quota:** Google Cloud Console > APIs & Services > Routes API > **Quotas**, and set *Compute Routes requests per day* to **320**. That's 10,000 / 31, so a whole month can't pass 10,000.
2. **Budget alert:** Billing > **Budgets & alerts** > Create budget for the project, with alerts at 50%, 80% and 100%. A budget only emails you; it doesn't stop requests. The quota does that.

Routes API pricing and its monthly free allowance are on Google's [pricing page](https://developers.google.com/maps/billing-and-pricing/pricing).

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
