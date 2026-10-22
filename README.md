# Travel Times

Home Screens module: door-to-door times by **CTA/public transit, Uber, Lyft and car**, with estimated ride prices, for your saved routes (Work, School...) and for upcoming calendar events, each tagged with the family member it's for.

## What it shows

- **Routes**: one card per saved route that's active right now. A route can be limited to certain days and hours ("Work, weekdays 6:00–10:00"), so the wall only shows the commute when it matters, and only looks it up then.
- **Upcoming**: the next timed calendar events that have a real address (Zoom/Teams/Meet links and all-day events are skipped). Each one shows **when to leave** by each mode to arrive a few minutes early.
- **Layout**: the cards and tiles arrange themselves to the module's shape. A wide, short strip puts trip cards side by side; a tall column stacks them, with tiles wrapping into rows. The module measures how wide its tiles' contents are, tries each arrangement, and uses the one that allows the largest text. There's no title row: each card's one-line header gives the route (or event and time) and destination, and the small footer gives the last update time. *Trip cards side by side* in the settings can fix the number of cards across.
- **Who it's for**: a route's *Who it's for* name is matched against Settings > Family (full or first name). An event is tagged with whoever's calendar it came from. Each card is colored from that person's Family color: a thick bar down its left edge, a disc with their Family icon (any of the 12 member icons Settings > Family offers, or an emoji typed there; otherwise their initial), a dark surface and tiles in the same hue, a lighter rim, and a light tint of it on the *fastest* tile. Text on the color is white, or near-black on light colors like yellow. You can tell whose trip it is from across the room without a name on the card. A route whose *Who it's for* matches nobody in the family gets a gray disc with their initial. An event on several people's calendars gets a striped bar and one disc each. Everyone in Settings > Family counts, whether or not they have a calendar linked.
- **Tiles**, one per mode:
  - **Transit**, one tile per route (the CTA roundel for CTA lines, a train icon and the agency's name otherwise): *Transit routes to show* sets how many different ways are listed, e.g. the Blue Line and the 56 bus. Each shows door-to-door minutes, including walks; the line(s) to take; when to leave home; and *Next - 12:56pm*, the leave-home times for the departures after it on the same line. A departure is dropped 90 seconds after its leave time and the next one moves up; once all of them have gone, the times are looked up again.
  - **Uber** and **Lyft** (their wordmarks, each turned on separately): an estimated door-to-door time, marked `~`: the drive in traffic plus the expected wait for a car (see [Pickup wait](#pickup-wait)). Below it, a price for each ride type picked. With one type, its wait sits in the tile's bottom-right corner (*Wait: ~5 min*). With several, each type's wait follows its price (*UberX $18-$23 (5 min)*, *Black $43-$55 (9 min)*) and the big time uses the median of their waits, following [Ridewise's method](https://getridewise.com/methodology); see [Ride price estimates](#ride-price-estimates). An amber *rush ×1.25* means the rush-hour adjustment is in the prices.
  - **Drive**: minutes in current traffic and how much traffic adds. Hidden on routes marked *Work / office route*, unless *Drive time on work routes* is on.
  - **fastest** marks whichever tile gets there first if you leave now (one badge when tiles tie, e.g. Uber and Lyft). A leave time turns amber within 10 minutes and says *leave now* / *too late* after that.

## Install

In the Home Screens editor, open the Plugin Store, choose **Install from URL**, and paste:

```
https://github.com/rferg05/travel-times-HS/releases/latest/download/travel-times.tar.gz
```

This always points at the newest release. Home Screens doesn't check URL-installed plugins for updates on its own, so to update: Plugin Store > **Installed**, then the download icon on Travel Times, then **Install**.

## Setup

1. Open Plugin Store > **Installed** > Travel Times and enter your Google Maps key (below). It's the only credential: the Uber and Lyft tiles are estimates and need no Uber or Lyft account.
2. In the module's settings, under **Routes**, set **Home address**. Routes with a blank *From* start there, and so do trips to calendar events. Left blank, the household location from Settings > Location is used.
3. Add your routes. Mark commutes as **Work / office route** to leave their Drive tile off.

### 1. Google Maps (transit and driving) — required

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project, enable **Routes API**, and attach billing.
2. APIs & Services > Credentials > **Create credentials > API key**. Restrict it to the Routes API.
3. Paste it into **Google Maps API key**. If the built-in Traffic module already has a key with the Routes API enabled, the same key works.

### Why there are no live Uber or Lyft quotes

Uber's developer dashboard no longer offers self-serve ride estimates: new apps get only the scopes of their API suite (partner-loyalty for *Rider3PLTesting*, none for *Others*), and the [estimate endpoints](https://developer.uber.com/docs/riders/references/api/v1.2/estimates-price-get) need approval through an Uber business-development contact. Lyft's public developer site is gone. So the plugin uses estimates only (see [Ride price estimates](#ride-price-estimates)); earlier versions' Uber sign-in and Lyft credential fields were removed in 1.4.0.

## Settings

| Setting | Default | |
|---|---|---|
| Home address | blank | Start of routes with a blank *From*, and of trips to events. Blank uses the household location from Settings. |
| Saved routes | one *Work* route | Name, who it's for, from, to, days, an optional time window, and *Work / office route*. Addresses or `lat,lon`. |
| Public transit / Uber estimates / Lyft estimates / Drive | on | Which tiles to show. |
| Transit routes to show | 2 | Different ways by transit, each its own tile. Fewer show when Google finds fewer. |
| Price region | nearest to home | A Ridewise region name, e.g. `Chicago Metro`. Also sets the expected wait for a car. |
| Rush-hour pricing / multiplier | on / ×1.25 | See [Ride price estimates](#ride-price-estimates). |
| Departures per transit route | 2 | The first, plus "Next - 12:56pm" for the rest. |
| Uber ride types | UberX | Any of UberX, Comfort, UberXL, Black: each gets its own price. |
| Lyft ride types | Lyft | Any of Lyft, Lyft XL, Lux. |
| Drive time on work routes | off | Shows the Drive tile on routes marked *Work / office route*. |
| Upcoming events | on | Trips start from the home address, or the household location. |
| Look ahead | 12 h | |
| Events to show | 3 | |
| Arrive early by | 5 min | Built into every leave time. |
| Skip events whose title contains | | e.g. `WFH, Zoom` |
| Check times every | 11 min | Routes, far-away events, and nearby events from 90 minutes before. |
| Google requests per month | 10,000 | Hard limit, counted per display. Lookups stop for the rest of the month once it's reached. |
| Warn at | 80% | A notice on the module from 8,000 requests, and a warning in the Home Screens log. |
| Trip cards side by side | Auto | Auto picks from the module's shape; or 1–4. |
| Scale with module size | on | Grow text, logos and numbers with the module, as the CTA module does. |
| Pause lookups | 23:00–05:30 | Shows the last times overnight without asking for new ones. |

## Ride price estimates

Prices are estimated the way [Ridewise](https://getridewise.com/methodology) does it:

> fare = base fare + per-mile rate × distance + per-minute rate × time + booking fee, at least the minimum fare

shown as a range from 12% under to 12% over, matching Ridewise's stated "typically within 10–15%".

- **Rates:** Ridewise's published rate cards (`getridewise.com/data/ridewise-rate-cards.csv`), covering 27 US regions plus a US Default, for UberX, Comfort, XL and Black, and Lyft, Lyft XL and Lux. The module downloads the file at runtime, at most once a day, and keeps it in the display's browser storage. Ridewise reviews the cards monthly, so updates arrive on their own. If their site can't be reached, the last copy is used. The rate data is Ridewise's. Their methodology page calls it free to cite with attribution, and the module credits them on screen whenever estimates show.
- **Region:** the nearest Ridewise region within 60 miles of home (the household location in Settings, or the home address), else US Default. *Price region* in the settings overrides it.
- **Distance and time:** the road distance and the drive time in traffic, both from the same Google driving lookup the Drive tile uses.
- **Ride types:** each type picked under *Uber ride types* / *Lyft ride types* is priced from its own rate card.
- **Rush hour (this plugin's guess, not Ridewise's):** Ridewise models surge from historical demand but doesn't publish it. With *Rush-hour pricing* on, estimates are multiplied by ×1.25 (adjustable) on weekdays 7:00–9:30 and 16:00–19:00, and on Friday and Saturday nights 22:00–03:00. The half hour either side of a weekday rush gets half the extra. For an event, it's priced at the leave time.
- **Not included:** live surge, airport surcharges, Chicago's per-ride ground transportation tax and downtown congestion charge, tolls, tips, promotions and memberships (Uber One, Lyft Pink).

## Pickup wait

Ridewise publishes fares, not how long a car takes to come, so the wait is this plugin's own estimate, made the same way as its rush-hour guess:

| | Wait |
|---|---|
| UberX, Lyft | 5 min |
| Comfort | 6 min |
| UberXL, Lyft XL | 7 min |
| Black, Lux | 9 min |
| Outside Ridewise's metro regions (US Default) | +3 min |
| Weekday rush hours (7:00–9:30, 16:00–19:00) | +2 min |
| Friday and Saturday 22:00–03:00 | +3 min |
| 1:00–5:00 other nights | +4 min |

For an event, the wait (like the price) is for when you'd call the car: the leave time. A tile pricing several ride types uses the median of their waits for its big time, its *fastest* comparison and its leave time: with UberX (5 min) and Black (9 min), that's 7.

These waits are starting guesses, not measured: they'll be calibrated against pickup times read from the Uber and Lyft apps.

## Sizing for a wall display

As with the CTA module: on a 32" 1080p screen read from about 5 feet, the travel times need to be roughly 30 px or larger. With *Scale with module size* on, everything grows with the module's area (against its 640×520 reference), then grows up to 1.8× more while the cards still fit. More trips on screen means smaller type. Measured in the preview at default Text size:

| Module size (1080p) | Showing | Layout | Travel times |
|---|---|---|---|
| Strip, 1700×275 | 2 commutes | 2 cards across, 4 tiles a row | 27 px |
| 893×676 | 2 commutes | cards stacked, 3 tiles a row | 34 px |
| Half screen, 940×1030 | 2 commutes | cards stacked | 52 px |

For reading across the room, give it at least half the screen. Limiting routes to the hours they matter, and fewer *Events to show*, keep the type large.

## API usage and cost

**Per check:** one trip is **2 Google requests** (transit and drive). The drive lookup runs even on a work route with its Drive tile hidden, because the Uber and Lyft estimates reuse the drive lookup (its distance and time) and cost no extra Google requests. Ridewise's rate file is downloaded at most once a day. Answers are kept between screen rotations, so showing the module on several screens of one display doesn't add requests. Addresses typed in the editor are looked up only after they stop changing for 2 seconds.

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
npm run preview      # module against mock Google, Ridewise, geocoder and Family list at http://localhost:5175
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
