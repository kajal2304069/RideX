import { Role } from "@/store/auth";

type Pair = { en: string; hi: string };
const q = (en: string, hi: string): Pair => ({ en, hi });

const BY_PAGE: Record<string, Pair[]> = {
  ride: [q("How do I set my pickup?", "पिकअप कैसे चुनूँ?"), q("How do I allow my location?", "लोकेशन की अनुमति कैसे दूँ?"), q("How is the price worked out?", "किराया कैसे तय होता है?"), q("How do I cancel a ride?", "सवारी रद्द कैसे करूँ?")],
  drive: [q("How do I go online?", "ऑनलाइन कैसे जाऊँ?"), q("How do I find a mechanic near me?", "पास का मैकेनिक कैसे खोजूँ?"), q("How do I allow my location?", "लोकेशन की अनुमति कैसे दूँ?"), q("How do I take my money out?", "पैसे बैंक में कैसे निकालूँ?")],
  earnings: [q("How do I take my money out?", "पैसे बैंक में कैसे निकालूँ?"), q("How do I earn by driving?", "गाड़ी चलाकर कैसे कमाऊँ?")],
  buy: [q("How do I buy a new vehicle?", "नई गाड़ी कैसे ख़रीदूँ?"), q("How do I make an offer?", "भाव कैसे लगाऊँ?"), q("How do I get a used vehicle checked?", "पुरानी गाड़ी की जाँच कैसे करवाऊँ?")],
  sell: [q("How do I sell my vehicle?", "अपनी गाड़ी कैसे बेचूँ?"), q("How do I list a new vehicle?", "नई गाड़ी कैसे डालूँ?")],
  rent: [q("How do I rent a vehicle?", "गाड़ी किराये पर कैसे लूँ?"), q("What is the deposit?", "डिपॉज़िट क्या है?")],
  repair: [q("How do I find a garage near me?", "पास का गैराज कैसे खोजूँ?"), q("My vehicle broke down", "मेरी गाड़ी ख़राब हो गई"), q("How do I allow my location?", "लोकेशन की अनुमति कैसे दूँ?")],
  payments: [q("How do I pay?", "भुगतान कैसे करूँ?"), q("How do I get a refund?", "पैसे वापस कैसे पाऊँ?")],
};
const BY_ROLE: Partial<Record<Role, Pair[]>> = {
  RIDER: [q("How do I book a ride?", "सवारी कैसे बुक करूँ?"), q("How do I pay?", "भुगतान कैसे करूँ?")],
  DRIVER: [q("How do I go online?", "ऑनलाइन कैसे जाऊँ?"), q("How do I find a mechanic near me?", "पास का मैकेनिक कैसे खोजूँ?")],
  BUYER: [q("How do I buy a new vehicle?", "नई गाड़ी कैसे ख़रीदूँ?"), q("How do I make an offer?", "भाव कैसे लगाऊँ?")],
  SELLER: [q("How do I sell my vehicle?", "अपनी गाड़ी कैसे बेचूँ?")],
  VEHICLE_OWNER: [q("How do I rent out my vehicle?", "अपनी गाड़ी किराये पर कैसे दूँ?")],
  GARAGE_OWNER: [q("How do I get repair bookings?", "मरम्मत की बुकिंग कैसे मिलेगी?")],
};
const VISITOR: Pair[] = [q("How do I create an account?", "खाता कैसे बनाऊँ?"), q("How do I book a ride?", "सवारी कैसे बुक करूँ?"), q("How do I earn by driving?", "गाड़ी चलाकर कैसे कमाऊँ?"), q("How do I buy a new vehicle?", "नई गाड़ी कैसे ख़रीदूँ?")];

/** Up to four questions that make sense right now: for someone who is not signed in, for the page they are on, then for their role. */
export function suggestionsFor(o: { signedIn: boolean; roles: Role[]; page: string; hi: boolean }): string[] {
  const out: Pair[] = [];
  if (!o.signedIn) out.push(...VISITOR);
  else {
    out.push(...(BY_PAGE[o.page] ?? []));
    for (const r of o.roles) out.push(...(BY_ROLE[r] ?? []));
  }
  const seen = new Set<string>();
  return out.filter((p) => !seen.has(p.en) && seen.add(p.en)).slice(0, 4).map((p) => (o.hi ? p.hi : p.en));
}

export const ROLE_NAME: Record<string, Pair> = {
  RIDER: q("a rider", "यात्री"), DRIVER: q("a driver", "ड्राइवर"), VEHICLE_OWNER: q("a vehicle owner", "गाड़ी मालिक"), GARAGE_OWNER: q("a garage owner", "गैराज मालिक"),
  SELLER: q("a seller", "विक्रेता"), BUYER: q("a buyer", "ख़रीदार"), ADMIN: q("an admin", "एडमिन"), MECHANIC: q("a mechanic", "मैकेनिक"),
};

export function greeting(o: { signedIn: boolean; first?: string; roles: Role[]; hi: boolean }): string {
  if (!o.signedIn) return o.hi ? "आप साइन इन नहीं हैं। मैं बता सकता हूँ कि RideX कैसे चलता है और आपके लिए कौन सा खाता ठीक रहेगा।" : "You are not signed in yet. I can explain how RideX works and help you pick the right account.";
  const r = o.roles.map((x) => ROLE_NAME[x]?.[o.hi ? "hi" : "en"]).filter(Boolean).slice(0, 2).join(o.hi ? " और " : " and ");
  return o.hi ? `नमस्ते ${o.first ?? ""}। आप ${r} के रूप में साइन इन हैं। इस पन्ने पर जो करना है, पूछिए।` : `Hi ${o.first ?? "there"}. You are signed in as ${r}. Ask me anything about what you can do on this page.`;
}
