/**
 * Seed hotspots: real, documented flood/waterlogging locations in Mangaluru.
 *
 * COORDINATES ARE APPROXIMATE (block-level) and MUST be verified against ward
 * maps / a surveyor before any public launch. They are good enough to place
 * pins plausibly on the map and to seed the "route check" + "saved places"
 * features for local testing.
 *
 * Sources (see README for full citations):
 *  - The Hindu, "30 areas prone to floods" (2016): names city hotspots.
 *  - Daijiworld (2025): Malemar–Kottara Chowki, Pumpwell, Jyothi Circle,
 *    Car Street, Bajal & Padil underpasses waterlogging.
 *  - The Times of India (2018): Pumpwell & Padil underpass flooding after rain.
 *  - Mangalore City Corporation "Climate Cross" / drainage masterplan context.
 *
 * `cause` values: tide | drainage | river | lowland | construction | underpass
 */

export const HOTSPOTS = [
  {
    id: 'hs-kottara-chowki',
    name: 'Kottara Chowki',
    area: 'Kottara / Malemar',
    lat: 12.9505, lng: 74.8840,
    cause: 'lowland',
    baseline: 'red',
    source: 'The Hindu 2016; Daijiworld 2025',
    note: 'Synonymous with annual flooding; water enters homes, two-wheelers stall.'
  },
  {
    id: 'hs-malemar',
    name: 'Malemar',
    area: 'Malemar',
    lat: 12.9520, lng: 74.8865,
    cause: 'lowland',
    baseline: 'red',
    source: 'Daijiworld 2025',
    note: 'Flooding for 5+ years; residents wade home, compounds inundated.'
  },
  {
    id: 'hs-pumpwell',
    name: 'Pumpwell Junction',
    area: 'Pumpwell',
    lat: 12.8920, lng: 74.8730,
    cause: 'drainage',
    baseline: 'red',
    source: 'TOI 2018; Daijiworld 2025',
    note: 'Major NH-66 junction; severe waterlogging, no long-term drainage fix.'
  },
  {
    id: 'hs-jyothi-circle',
    name: 'Jyothi Circle',
    area: 'Pumpwell / Jyothi',
    lat: 12.8935, lng: 74.8710,
    cause: 'drainage',
    baseline: 'amber',
    source: 'Daijiworld 2025',
    note: 'Repeated waterlogging on consecutive rain days.'
  },
  {
    id: 'hs-padil-underpass',
    name: 'Padil Underpass',
    area: 'Padil',
    lat: 12.8420, lng: 74.8610,
    cause: 'underpass',
    baseline: 'red',
    source: 'TOI 2018; Daijiworld 2025',
    note: 'Underpass floods fast; impassable to two-wheelers during downpour.'
  },
  {
    id: 'hs-bajal-underpass',
    name: 'Bajal Underpass',
    area: 'Bajal',
    lat: 12.8230, lng: 74.8700,
    cause: 'underpass',
    baseline: 'red',
    source: 'Daijiworld 2025',
    note: 'Railway underpass waterlogging; drainage infrastructure poor.'
  },
  {
    id: 'hs-jeppinamogaru',
    name: 'Jeppinamogaru',
    area: 'Jeppinamogaru',
    lat: 12.8330, lng: 74.8740,
    cause: 'lowland',
    baseline: 'amber',
    source: 'The Hindu 2016',
    note: 'Low-lying residential belt, official flood-prone list.'
  },
  {
    id: 'hs-hoige-bazaar',
    name: 'Hoige Bazaar',
    area: 'Hoige Bazaar / Bunder',
    lat: 12.8700, lng: 74.8400,
    cause: 'tide',
    baseline: 'amber',
    source: 'The Hindu 2016',
    note: 'Coastal market area; tidal backflow + rain compound flooding.'
  },
  {
    id: 'hs-kasba-bengre',
    name: 'Kasba Bengre',
    area: 'Bengre',
    lat: 12.9010, lng: 74.8230,
    cause: 'tide',
    baseline: 'amber',
    source: 'The Hindu 2016',
    note: 'Riverside/coastal settlement; high tide worsens waterlogging.'
  },
  {
    id: 'hs-pandeshwar',
    name: 'Pandeshwar',
    area: 'Pandeshwar',
    lat: 12.8740, lng: 74.8500,
    cause: 'drainage',
    baseline: 'amber',
    source: 'The Hindu 2016',
    note: 'Commercial area on official flood-prone list; drainage overload.'
  },
  {
    id: 'hs-bokkapatna',
    name: 'Bokkapatna',
    area: 'Bokkapatna',
    lat: 12.9600, lng: 74.8010,
    cause: 'river',
    baseline: 'amber',
    source: 'The Hindu 2016',
    note: 'Near river mouth; flooding when Gurupura/Nethravati swell.'
  },
  {
    id: 'hs-bajal-kudpu',
    name: 'Bajal Kudpu',
    area: 'Kudpu',
    lat: 12.8080, lng: 74.8820,
    cause: 'lowland',
    baseline: 'amber',
    source: 'The Hindu 2016',
    note: 'Southern outskirts lowland on official flood-prone list.'
  },
  {
    id: 'hs-car-street',
    name: 'Car Street',
    area: 'Hampankatta',
    lat: 12.8705, lng: 74.8435,
    cause: 'drainage',
    baseline: 'amber',
    source: 'Daijiworld 2025',
    note: 'Busy market street; blocked storm drains cause standing water.'
  },
  {
    id: 'hs-hampankatta-circle',
    name: 'Hampankatta Circle',
    area: 'Hampankatta',
    lat: 12.8720, lng: 74.8430,
    cause: 'drainage',
    baseline: 'green',
    source: 'Daijiworld 2025',
    note: 'City centre; usually passable, occasional surface water.'
  },
  {
    id: 'hs-bejai',
    name: 'Bejai Market Road',
    area: 'Bejai',
    lat: 12.8790, lng: 74.8520,
    cause: 'drainage',
    baseline: 'amber',
    source: 'Front-end prototype; local knowledge',
    note: 'Busy market road; one lane often open during heavy rain.'
  },
  {
    id: 'hs-kadri',
    name: 'Kadri',
    area: 'Kadri',
    lat: 12.8890, lng: 74.8600,
    cause: 'lowland',
    baseline: 'green',
    source: 'Local knowledge',
    note: 'Generally passable; watch low stretches near Kadri Park.'
  },
  {
    id: 'hs-kulur-bridge',
    name: 'Kulur Bridge approach',
    area: 'Kulur',
    lat: 12.9330, lng: 74.8580,
    cause: 'river',
    baseline: 'amber',
    source: 'Local knowledge',
    note: 'Bridge approach over a backwater channel; slow during high tide.'
  },
  {
    id: 'hs-port-road',
    name: 'Port Road',
    area: 'Bunder / Port',
    lat: 12.8830, lng: 74.8320,
    cause: 'tide',
    baseline: 'amber',
    source: 'Local knowledge',
    note: 'Coastal arterial; tidal spray and standing water in bursts.'
  }
];

export default HOTSPOTS;
