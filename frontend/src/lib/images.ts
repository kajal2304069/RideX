/**
 * Real photographs, all from Unsplash under the free Unsplash License (commercial use allowed, no permission needed;
 * attribution is appreciated and shown on the Help page). Hot-linked from Unsplash's CDN with a width parameter so phones
 * download small versions. If an image cannot load, <Photo> falls back to a dark gradient so layouts never break.
 */
const u = (id: string) => `https://images.unsplash.com/photo-${id}`;

export interface Pic { id: string; alt: string; credit: string; page: string }

export const PICS = {
  cityTaxi: { id: "1770297345695-f7ca76dfb04d", alt: "A yellow taxi driving down a neon-lit city street at night", credit: "Willian Justen de Vasconcellos", page: "https://unsplash.com/photos/yellow-taxi-drives-through-a-neon-lit-city-street-at-night-TKWnI7hG35U" },
  nightCab: { id: "1617933600405-f1068a6b8583", alt: "A yellow cab on the road at night", credit: "Ali Yasar isgoren", page: "https://unsplash.com/photos/yellow-taxi-cab-on-road-during-night-time-_IB9GHmB7XI" },
  autoRickshaw: { id: "1592639296346-560c37a0f711", alt: "Auto rickshaws on a busy road in New Delhi", credit: "Laurentiu Morariu", page: "https://unsplash.com/photos/auto-rickshaws-on-road-in-new-delhi-8XZTZIfuNrM" },
  suvRoad: { id: "1779112477680-439c2a939dcf", alt: "A red SUV driving on a mountain road", credit: "Jimmy Liu", page: "https://unsplash.com/photos/a-red-suv-drives-on-a-road-with-mountains-P13c6zYtBZM" },
  keys: { id: "1727893512947-8bdc773ceb02", alt: "A person handing a car key to another person", credit: "Mehmet Talha Onuk", page: "https://unsplash.com/photos/a-person-handing-a-car-key-to-another-person-aboFF2GXb_0" },
  carLot: { id: "1685091955352-4bb8796aef12", alt: "A row of cars parked in a lot", credit: "Koons Automotive", page: "https://unsplash.com/photos/a-row-of-parked-cars-in-a-parking-lot-NFz9uZ8CtKM" },
  garage: { id: "1708745427274-d5de5122fd57", alt: "A mechanic working on a car engine in a garage", credit: "Dan Crile", page: "https://unsplash.com/photos/a-man-working-on-a-car-engine-in-a-garage-EJr3XkHdBm0" },
} satisfies Record<string, Pic>;

export const picUrl = (p: Pic, width = 1200) => `${u(p.id)}?w=${width}&q=70&auto=format&fit=crop`;
export const picSrcSet = (p: Pic) => [480, 800, 1200, 1800].map((w) => `${picUrl(p, w)} ${w}w`).join(", ");
