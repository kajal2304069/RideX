/**
 * What the assistant knows about using RideX. Used two ways:
 *  1. grounding text for the AI model (so it explains OUR app, not taxis in general), and
 *  2. a no-AI fallback: the best-matching entry is read out as is (English and Hindi only).
 * Keep answers short and in spoken style: they are read aloud.
 */
export interface Faq { id: string; keywords: string[]; en: string; hi: string }

export const FAQS: Faq[] = [
  { id: "account", keywords: ["account", "sign up", "signup", "register", "create", "join", "password", "खाता", "रजिस्टर", "साइन", "पासवर्ड"],
    en: "To start, open the sign in page and tap Create an account. Type your name, email and a password with at least eight letters, one capital letter, one small letter and one number. Then tick what you want to do, like ride, drive, sell or repair.",
    hi: "शुरू करने के लिए साइन इन पन्ने पर Create an account दबाएँ। अपना नाम, ईमेल और पासवर्ड लिखें। पासवर्ड में कम से कम आठ अक्षर, एक बड़ा अक्षर, एक छोटा अक्षर और एक अंक हो। फिर चुनें कि आप क्या करना चाहते हैं, जैसे सवारी, गाड़ी चलाना, बेचना या मरम्मत।" },
  { id: "ride", keywords: ["ride", "book", "taxi", "cab", "auto", "bike", "trip", "go", "travel", "सवारी", "बुक", "टैक्सी", "ऑटो", "बाइक", "जाना", "यात्रा"],
    en: "To book a ride, open Ride. Touch the map where you are, then touch where you want to go. Choose a bike, auto or car and look at the price. Then press the yellow Request button and wait while we find a driver. You can watch the driver come to you on the map.",
    hi: "सवारी बुक करने के लिए Ride खोलें। नक़्शे पर वहाँ दबाएँ जहाँ आप हैं, फिर वहाँ जहाँ जाना है। बाइक, ऑटो या कार चुनें और किराया देखें। फिर पीला Request बटन दबाएँ और ड्राइवर मिलने तक रुकें। आप नक़्शे पर ड्राइवर को अपनी तरफ़ आते देख सकते हैं।" },
  { id: "price", keywords: ["price", "fare", "cost", "charge", "cheap", "surge", "how much", "किराया", "दाम", "कीमत", "पैसा", "कितना"],
    en: "You see the price before you book, and it does not change after you book. The price depends on distance, time and how busy it is. When many people need rides at once, the price can go up a little, and we show that to you first.",
    hi: "बुक करने से पहले ही किराया दिखता है और बुक करने के बाद बदलता नहीं। किराया दूरी, समय और भीड़ पर निर्भर करता है। जब एक साथ बहुत लोग सवारी माँगते हैं तो किराया थोड़ा बढ़ सकता है, और यह हम पहले ही दिखा देते हैं।" },
  { id: "pay", keywords: ["pay", "payment", "card", "money", "upi", "wallet", "refund", "भुगतान", "पैसे", "कार्ड", "रिफंड", "वापस"],
    en: "When your trip or service is finished, press Pay and choose how to pay. Pressing twice by mistake will never charge you twice. If a payment fails, nothing is taken, and you can try again. Refunds go back to the way you paid.",
    hi: "यात्रा या सेवा पूरी होने पर Pay दबाएँ और भुगतान का तरीक़ा चुनें। ग़लती से दो बार दबाने पर भी दो बार पैसे नहीं कटेंगे। भुगतान न हो पाए तो पैसे नहीं कटते, आप फिर कोशिश कर सकते हैं। रिफंड उसी तरीक़े से वापस आता है जिससे आपने भुगतान किया।" },
  { id: "cancel", keywords: ["cancel", "stop", "change mind", "रद्द", "कैंसल", "रोकना"],
    en: "To cancel a ride, open your trip and press Cancel ride. You can cancel before the trip starts. A rental or a repair booking can be cancelled from its own page, My rentals or My services.",
    hi: "सवारी रद्द करने के लिए अपनी यात्रा खोलें और Cancel ride दबाएँ। यात्रा शुरू होने से पहले रद्द कर सकते हैं। किराये या मरम्मत की बुकिंग उसके अपने पन्ने, My rentals या My services से रद्द होती है।" },
  { id: "rent", keywords: ["rent", "hire", "rental", "deposit", "borrow", "किराये", "रेंट", "डिपॉज़िट", "डिपोजिट", "भाड़े"],
    en: "To rent a vehicle, open Rent and touch one you like. Choose when to take it and when to bring it back, and the price shows below. Press Reserve and pay. We hold it for you for fifteen minutes while you pay. The deposit is kept safe and comes back after you return the vehicle in good shape. Returning late costs a small extra fee.",
    hi: "गाड़ी किराये पर लेने के लिए Rent खोलें और पसंद की गाड़ी चुनें। लेने और लौटाने का समय चुनें, किराया नीचे दिखेगा। Reserve and pay दबाएँ। भुगतान के लिए हम गाड़ी पंद्रह मिनट रोकते हैं। डिपॉज़िट सुरक्षित रहता है और गाड़ी ठीक हालत में लौटाने पर वापस मिलता है। देर से लौटाने पर थोड़ा अतिरिक्त शुल्क लगता है।" },
  { id: "buy", keywords: ["buy", "purchase", "used", "second hand", "secondhand", "offer", "inspection", "ख़रीद", "खरीद", "पुरानी", "भाव", "जाँच", "निरीक्षण"],
    en: "To buy a used vehicle, open Buy and search. Touch a vehicle, type the price you want to pay and press Send offer. You can also press Request inspection, and a mechanic will check the engine, brakes and papers and give a score out of ten. You get a notification when the seller answers.",
    hi: "पुरानी गाड़ी ख़रीदने के लिए Buy खोलें और खोजें। गाड़ी पर दबाएँ, जितना देना चाहते हैं वह दाम लिखें और Send offer दबाएँ। आप Request inspection भी दबा सकते हैं, तब मैकेनिक इंजन, ब्रेक और काग़ज़ देखकर दस में से अंक देगा। विक्रेता के जवाब पर आपको सूचना मिलती है।" },
  { id: "sell", keywords: ["sell", "list", "listing", "seller", "बेच", "बेचना", "विक्रेता"],
    en: "To sell a vehicle, sign up with the Sell option ticked, then open Sell and press New listing. Fill in the vehicle details, the price and where it is, and add a photo link. Buyers will send offers, and you can accept or reject each one from the Offers button.",
    hi: "गाड़ी बेचने के लिए बेचना वाला विकल्प चुनकर खाता बनाएँ, फिर Sell खोलकर New listing दबाएँ। गाड़ी की जानकारी, दाम, जगह भरें और फ़ोटो का लिंक जोड़ें। ख़रीदार भाव भेजेंगे, और आप Offers बटन से हर भाव मान या ठुकरा सकते हैं।" },
  { id: "repair", keywords: ["repair", "garage", "mechanic", "service", "fix", "broken", "workshop", "मरम्मत", "गैराज", "मैकेनिक", "ठीक", "सर्विस"],
    en: "To fix your vehicle, open Repair. Garages near you show on the map. Touch one, choose the work and the time, and press Request booking. When the work is done, open My services and pay the bill. You can see every part and charge.",
    hi: "गाड़ी ठीक करवाने के लिए Repair खोलें। पास के गैराज नक़्शे पर दिखेंगे। एक चुनें, काम और समय चुनें और Request booking दबाएँ। काम पूरा होने पर My services खोलकर बिल भरें। हर पुर्ज़े और शुल्क का हिसाब दिखता है।" },
  { id: "breakdown", keywords: ["breakdown", "broke down", "emergency", "stuck", "puncture", "flat", "help me", "road", "खराब", "ख़राब", "फँस", "पंचर", "आपातकाल", "इमरजेंसी"],
    en: "If your vehicle breaks down on the road, open Repair and press the red Breakdown, Get help button. We send your place to the nearest garage that does emergency repair. If anyone is in danger, please call your local emergency number first.",
    hi: "रास्ते में गाड़ी बिगड़ जाए तो Repair खोलें और लाल Breakdown, Get help बटन दबाएँ। हम आपकी जगह सबसे पास के इमरजेंसी मरम्मत वाले गैराज को भेज देते हैं। अगर किसी की जान को ख़तरा है तो पहले अपने स्थानीय आपातकालीन नंबर पर फ़ोन करें।" },
  { id: "drive", keywords: ["drive", "driver", "earn", "online", "accept", "licence", "license", "चलाना", "ड्राइवर", "कमाई", "कमाना", "लाइसेंस"],
    en: "To drive and earn, sign up with the Drive option and open Drive and earn. Add your licence number and wait to be approved. Then press Go online. When a ride request appears, press Accept, and follow the buttons: arrived, start trip, end trip. After the rider pays, your share is added to your earnings.",
    hi: "गाड़ी चलाकर कमाने के लिए Drive विकल्प के साथ खाता बनाएँ और Drive and earn खोलें। अपना लाइसेंस नंबर डालें और मंज़ूरी का इंतज़ार करें। फिर Go online दबाएँ। सवारी का अनुरोध आए तो Accept दबाएँ और बटन क्रम से दबाएँ: पहुँच गया, यात्रा शुरू, यात्रा ख़त्म। यात्री के भुगतान के बाद आपका हिस्सा कमाई में जुड़ जाता है।" },
  { id: "withdraw", keywords: ["withdraw", "to my bank", "take my money", "cash out", "money out", "bank", "earnings", "payout", "transfer", "निकाल", "बैंक", "निकालना"],
    en: "To take your money out, open Earnings, type an amount and press Withdraw. The money goes to your bank. There is a small minimum amount, and you can see every payout in the same page.",
    hi: "अपना पैसा निकालने के लिए Earnings खोलें, रक़म लिखें और Withdraw दबाएँ। पैसा आपके बैंक में जाएगा। एक छोटी न्यूनतम रक़म है, और हर भुगतान उसी पन्ने पर दिखता है।" },
  { id: "owner", keywords: ["owner", "my vehicle", "assign", "commission", "own", "मालिक", "अपनी गाड़ी", "कमीशन"],
    en: "If you own a vehicle, open Drive and earn, then My vehicles. Add your vehicle, then either assign it to a driver using their email, or list it for rent. You choose how the earnings are shared, and you see the split before you confirm.",
    hi: "अगर आपके पास गाड़ी है तो Drive and earn में My vehicles खोलें। गाड़ी जोड़ें, फिर ईमेल से किसी ड्राइवर को दें, या किराये पर लगाएँ। कमाई कैसे बँटे यह आप तय करते हैं, और पक्का करने से पहले बँटवारा दिखता है।" },
  { id: "notify", keywords: ["notification", "bell", "alert", "message", "सूचना", "घंटी", "संदेश"],
    en: "The Notifications button tells you when something happens, like a driver accepting your ride or a seller answering your offer. A number on the button shows how many you have not read.",
    hi: "Notifications बटन बताता है कि कुछ हुआ है, जैसे ड्राइवर ने आपकी सवारी मान ली या विक्रेता ने आपके भाव का जवाब दिया। बटन पर लिखा अंक बताता है कि कितनी सूचनाएँ पढ़ी नहीं गईं।" },
  { id: "safety", keywords: ["safe", "safety", "secure", "trust", "rating", "rate", "सुरक्षित", "सुरक्षा", "रेटिंग"],
    en: "After every trip you can give the driver stars, and drivers can rate riders too. Only verified drivers can take rides. Please never share your password or card details with anyone, including drivers. RideX will never ask for them by phone.",
    hi: "हर यात्रा के बाद आप ड्राइवर को सितारे दे सकते हैं, और ड्राइवर भी यात्री को रेटिंग देते हैं। सिर्फ़ जाँचे हुए ड्राइवर ही सवारी ले सकते हैं। अपना पासवर्ड या कार्ड की जानकारी किसी को न बताएँ, ड्राइवर को भी नहीं। RideX फ़ोन पर यह कभी नहीं माँगता।" },
  { id: "location", keywords: ["location", "gps", "where am i", "allow location", "my location", "nearby", "near me", "direction", "directions", "navigate", "जगह", "लोकेशन", "मेरी जगह", "पास", "नज़दीक", "रास्ता"],
    en: "RideX uses your phone's location so a driver can find you and you can see your driver on the map. When your browser asks, tap Allow. If you said no by mistake, tap the lock next to the web address and allow location, then press Try again. You can always search for a place or tap the map instead. Drivers can also open Mechanics near you to find garages close to them, with distance and directions.",
    hi: "RideX आपके फ़ोन की लोकेशन इस्तेमाल करता है ताकि ड्राइवर आपको ढूँढ सके और आप नक़्शे पर अपना ड्राइवर देख सकें। ब्राउज़र पूछे तो Allow दबाएँ। अगर ग़लती से मना कर दिया, तो वेब पते के पास ताला दबाकर लोकेशन की अनुमति दें और Try again दबाएँ। आप जगह खोज सकते हैं या नक़्शे पर दबा सकते हैं। ड्राइवर Mechanics near you खोलकर अपने पास के गैराज, दूरी और रास्ते के साथ देख सकते हैं।" },
  { id: "newvehicle", keywords: ["new vehicle", "brand new", "new car", "new bike", "showroom", "dealer", "नई गाड़ी", "नई कार", "नई बाइक", "शोरूम"],
    en: "In Buy you can choose the Condition filter. Pick New for brand-new vehicles, or Excellent, Good and Fair for second-hand ones. Sellers and dealers choose the condition when they list a vehicle.",
    hi: "Buy में Condition फ़िल्टर चुनें। बिल्कुल नई गाड़ी के लिए New चुनें, और पुरानी गाड़ी के लिए Excellent, Good या Fair। बेचने वाले गाड़ी डालते समय उसकी हालत ख़ुद चुनते हैं।" },
  { id: "language", keywords: ["language", "hindi", "english", "भाषा", "हिंदी", "हिन्दी", "अंग्रेज़ी"],
    en: "You can talk to me in many languages. Choose your language in the box at the top of this assistant, then press the microphone and speak. The pictured guide in the Help page is in English and Hindi.",
    hi: "आप मुझसे कई भाषाओं में बात कर सकते हैं। इस सहायक के ऊपर वाले डिब्बे में अपनी भाषा चुनें, फिर माइक दबाकर बोलें। Help पन्ने की तस्वीरों वाली गाइड अंग्रेज़ी और हिन्दी में है।" },
];

export const FALLBACK = {
  en: "I can help you book a ride, rent or buy a vehicle, fix your vehicle, or earn by driving. Try asking, for example, how do I book a ride.",
  hi: "मैं सवारी बुक करने, गाड़ी किराये पर लेने या ख़रीदने, गाड़ी ठीक करवाने और गाड़ी चलाकर कमाने में मदद कर सकता हूँ। जैसे पूछें: सवारी कैसे बुक करूँ।",
};

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Best entry by keyword hits (phrases count more than single words). Null when nothing matches. */
export function bestFaq(question: string): Faq | null {
  const q = ` ${norm(question)} `;
  let best: Faq | null = null; let bestScore = 0;
  for (const f of FAQS) {
    let score = 0;
    for (const k of f.keywords) {
      const kk = norm(k);
      if (!kk) continue;
      if (q.includes(` ${kk} `) || (kk.length > 3 && q.includes(kk))) score += kk.includes(" ") ? 3 : 2;
    }
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best;
}

export const knowledgeText = () => FAQS.map((f) => `- ${f.en}`).join("\n");
