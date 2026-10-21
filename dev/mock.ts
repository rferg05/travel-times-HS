// Fake Google Routes / Uber / Lyft answers for the preview page, in the
// services' real response shapes, timed off the current clock.
import type { Fetcher } from '../src/providers';

const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

function transit(dest: string, arriveBy?: number) {
  // Shift departures so an arrive-by plan lands just before the event.
  const shift = arriveBy ? Math.max(0, Math.round((arriveBy - Date.now()) / 60_000) - 40) : 0;
  const ride = 18 + (dest.length % 9);
  const option = (wait: number, line: object, walk = 5) => ({
    duration: `${(walk + wait + ride + 4) * 60}s`,
    legs: [{ steps: [
      { travelMode: 'WALK', staticDuration: `${walk * 60}s` },
      { travelMode: 'TRANSIT', staticDuration: `${ride * 60}s`, transitDetails: {
        stopDetails: { departureStop: { name: 'Division' }, departureTime: at(shift + walk + wait), arrivalTime: at(shift + walk + wait + ride) },
        transitLine: line,
      } },
      { travelMode: 'WALK', staticDuration: '240s' },
    ] }],
  });
  const blue = { nameShort: 'Blue', color: '#00a1de', textColor: '#ffffff', vehicle: { type: 'SUBWAY' } };
  const bus = { nameShort: '56', color: '#565a5c', textColor: '#ffffff', vehicle: { type: 'BUS' } };
  return { routes: [option(3, blue), option(9, bus, 2), option(11, blue)] };
}

export const mockFetcher: Fetcher = async (req) => {
  await new Promise((r) => setTimeout(r, 150));
  const body = req.payload ? JSON.parse(req.payload) : {};
  if (req.url.includes('computeRoutes')) {
    const dest = String(body.destination?.address ?? '');
    if (body.travelMode === 'TRANSIT') {
      return { status: 200, body: transit(dest, body.arrivalTime ? Date.parse(body.arrivalTime) : undefined) };
    }
    const clear = 16 + (dest.length % 11);
    return { status: 200, body: { routes: [{
      duration: `${(clear + 6) * 60}s`, staticDuration: `${clear * 60}s`,
      legs: [{ startLocation: { latLng: { latitude: 41.9034, longitude: -87.6665 } }, endLocation: { latLng: { latitude: 41.8786, longitude: -87.6359 } } }],
    }] } };
  }
  if (req.url.includes('/estimates/price')) {
    return { status: 200, body: { prices: [
      { product_id: 'x', display_name: 'UberX', estimate: '$19-24', duration: 1260 },
      { product_id: 'xl', display_name: 'UberXL', estimate: '$29-36', duration: 1260 },
    ] } };
  }
  if (req.url.includes('/estimates/time')) return { status: 200, body: { times: [{ product_id: 'x', estimate: 240 }] } };
  if (req.url.includes('/oauth/token')) return { status: 200, body: { access_token: 'mock', expires_in: 86400 } };
  if (req.url.includes('/v1/cost')) {
    return { status: 200, body: { cost_estimates: [{ ride_type: 'lyft', display_name: 'Lyft', estimated_cost_cents_min: 1700, estimated_cost_cents_max: 2300, estimated_duration_seconds: 1320, currency: 'USD', is_valid_estimate: true }] } };
  }
  if (req.url.includes('/v1/eta')) return { status: 200, body: { eta_estimates: [{ ride_type: 'lyft', display_name: 'Lyft', eta_seconds: 420 }] } };
  return { status: 404, body: {} };
};
