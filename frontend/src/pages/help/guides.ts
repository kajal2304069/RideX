export type Lang = "en" | "hi";
export interface Step { art: string; en: string; hi: string; note?: { en: string; hi: string } }
export interface Guide { id: string; line: "ride" | "rent" | "market" | "repair" | "earn"; icon: string; title: { en: string; hi: string }; intro: { en: string; hi: string }; steps: Step[] }

/** Short sentences, one action per step, everyday words. Hindi is written to be spoken, not translated word for word. */
export const GUIDES: Guide[] = [
  { id: "start", line: "ride", icon: "", title: { en: "Start here: make your account", hi: "यहाँ से शुरू करें: खाता बनाएँ" },
    intro: { en: "You only do this once. You need an email and a password.", hi: "यह सिर्फ़ एक बार करना है। आपको ईमेल और पासवर्ड चाहिए।" },
    steps: [
      { art: "signup", en: "Tap “New to RideX? Create an account”. Type your name, email and a password.", hi: "“New to RideX?” दबाएँ। अपना नाम, ईमेल और पासवर्ड लिखें।", note: { en: "Password: 8 or more letters, with a big letter, a small letter and a number. Example: Ravi2026x", hi: "पासवर्ड: 8 या ज़्यादा अक्षर, एक बड़ा अक्षर, एक छोटा अक्षर और एक अंक। जैसे: Ravi2026x" } },
      { art: "help", en: "Tick what you want to do: ride, drive, sell, repair. You can pick more than one.", hi: "जो करना चाहते हैं उस पर निशान लगाएँ: सवारी, गाड़ी चलाना, बेचना, मरम्मत। एक से ज़्यादा चुन सकते हैं।" },
      { art: "bell", en: "The bell button (Notifications) tells you when something happens, like a driver accepting your ride.", hi: "घंटी (Notifications) बताती है कि कुछ हुआ है, जैसे ड्राइवर ने आपकी सवारी मान ली।" },
    ] },
  { id: "ride", line: "ride", icon: "", title: { en: "Book a ride", hi: "सवारी बुक करें" },
    intro: { en: "Get a bike, auto or car to take you somewhere. You see the price before you book.", hi: "बाइक, ऑटो या कार बुलाएँ। बुक करने से पहले ही किराया दिखता है।" },
    steps: [
      { art: "pickPins", en: "Touch the map where you are. Then touch the map where you want to go.", hi: "नक़्शे पर वहाँ दबाएँ जहाँ आप हैं। फिर वहाँ दबाएँ जहाँ जाना है।", note: { en: "Or press “Use my location as pickup”.", hi: "या “Use my location as pickup” दबाएँ।" } },
      { art: "chooseVehicle", en: "Choose bike, auto or car.", hi: "बाइक, ऑटो या कार चुनें।" },
      { art: "seePrice", en: "Look at the price. It will not change after you book.", hi: "किराया देखें। बुक करने के बाद यह नहीं बदलेगा।" },
      { art: "waiting", en: "Press the yellow Request button. Wait a moment while we find a driver.", hi: "पीला Request बटन दबाएँ। ड्राइवर मिलने तक थोड़ा रुकें।" },
      { art: "carComing", en: "You can watch the driver come to you on the map. The line at the top shows where your ride is.", hi: "नक़्शे पर ड्राइवर को आते देखें। ऊपर की लाइन बताती है कि सवारी कहाँ तक पहुँची।" },
      { art: "pay", en: "When you reach, press Pay and choose how to pay.", hi: "पहुँचने पर Pay दबाएँ और भुगतान का तरीक़ा चुनें।" },
      { art: "rate", en: "Give the driver stars. This helps other riders.", hi: "ड्राइवर को सितारे दें। इससे दूसरों को मदद मिलती है।" },
    ] },
  { id: "rent", line: "rent", icon: "", title: { en: "Rent a vehicle", hi: "गाड़ी किराये पर लें" },
    intro: { en: "Take a bike or car for a few hours or days and drive it yourself.", hi: "कुछ घंटे या दिन के लिए बाइक या कार लें और ख़ुद चलाएँ।" },
    steps: [
      { art: "carKey", en: "Open “Rent” and touch a vehicle you like.", hi: "“Rent” खोलें और पसंद की गाड़ी पर दबाएँ।" },
      { art: "calendar", en: "Choose the day and time to take it and bring it back. The price shows below.", hi: "गाड़ी लेने और लौटाने का दिन और समय चुनें। नीचे किराया दिखेगा।" },
      { art: "pay", en: "Press “Reserve and pay”. We hold the vehicle for you for 15 minutes while you pay.", hi: "“Reserve and pay” दबाएँ। भुगतान तक हम 15 मिनट गाड़ी रोककर रखते हैं।" },
      { art: "deposit", en: "The deposit is extra money kept safe. You get it back after you return the vehicle in good shape.", hi: "डिपॉज़िट सुरक्षा के लिए रखा गया पैसा है। गाड़ी ठीक हालत में लौटाने पर यह वापस मिलता है।", note: { en: "Return late and a small extra fee is taken from it.", hi: "देर से लौटाने पर इसमें से थोड़ा अतिरिक्त शुल्क कटता है।" } },
    ] },
  { id: "buy", line: "market", icon: "", title: { en: "Buy a used vehicle", hi: "पुरानी गाड़ी ख़रीदें" },
    intro: { en: "Find a second-hand vehicle, make an offer, and get it checked by a mechanic first.", hi: "पुरानी गाड़ी खोजें, भाव लगाएँ और ख़रीदने से पहले मैकेनिक से जँचवाएँ।" },
    steps: [
      { art: "search", en: "Open “Buy”. Use the boxes to search by name, price or fuel.", hi: "“Buy” खोलें। नाम, दाम या ईंधन से खोजें।" },
      { art: "offer", en: "Touch a vehicle. Type the price you want to pay and press Send offer.", hi: "गाड़ी पर दबाएँ। जितना देना चाहते हैं वह दाम लिखें और Send offer दबाएँ।" },
      { art: "inspect", en: "Press “Request inspection”. A mechanic checks the engine, brakes and papers and gives a score out of 10.", hi: "“Request inspection” दबाएँ। मैकेनिक इंजन, ब्रेक और काग़ज़ देखकर 10 में से अंक देता है।" },
      { art: "bell", en: "When the seller says yes, you get a notification. Check “Offers & saved” any time.", hi: "विक्रेता हाँ कहे तो सूचना आती है। “Offers & saved” में कभी भी देखें।" },
    ] },
  { id: "repair", line: "repair", icon: "", title: { en: "Fix your vehicle", hi: "गाड़ी ठीक करवाएँ" },
    intro: { en: "Book a garage near you, or call for help if you break down on the road.", hi: "पास का गैराज बुक करें, या रास्ते में गाड़ी बिगड़ जाए तो मदद बुलाएँ।" },
    steps: [
      { art: "garage", en: "Open “Repair”. Garages near you show on the map and in the list.", hi: "“Repair” खोलें। आपके पास के गैराज नक़्शे और सूची में दिखेंगे।" },
      { art: "calendar", en: "Touch a garage, choose the work and the time, then press Request booking.", hi: "गैराज पर दबाएँ, काम और समय चुनें, फिर Request booking दबाएँ।" },
      { art: "pay", en: "When the work is done, open “My services” and pay the bill. You can see every part and charge.", hi: "काम पूरा होने पर “My services” खोलकर बिल भरें। हर पुर्ज़े और शुल्क का हिसाब दिखता है।" },
      { art: "sos", en: "Stuck on the road? Press the red “Breakdown? Get help” button. We send your place to the nearest garage.", hi: "रास्ते में फँस गए? लाल “Breakdown? Get help” बटन दबाएँ। हम आपकी जगह सबसे पास के गैराज को भेज देते हैं।" },
    ] },
  { id: "drive", line: "earn", icon: "", title: { en: "Drive and earn", hi: "गाड़ी चलाएँ और कमाएँ" },
    intro: { en: "For drivers and vehicle owners. Take rides, and take your money out to your bank.", hi: "ड्राइवरों और गाड़ी मालिकों के लिए। सवारी लें और पैसा अपने बैंक में निकालें।" },
    steps: [
      { art: "online", en: "Open “Drive & earn”. Press “Go online”. Now riders near you can find you.", hi: "“Drive & earn” खोलें। “Go online” दबाएँ। अब पास के यात्री आपको पा सकते हैं।", note: { en: "You must be approved first. Add your licence number on the same page.", hi: "पहले मंज़ूरी चाहिए। उसी पन्ने पर अपना लाइसेंस नंबर डालें।" } },
      { art: "accept", en: "A ride request appears. Press Accept to take it.", hi: "सवारी का अनुरोध दिखेगा। लेने के लिए Accept दबाएँ।" },
      { art: "carComing", en: "Follow the steps on the page: Arrived, Start trip, End trip.", hi: "पन्ने पर क्रम से दबाएँ: पहुँच गया, यात्रा शुरू, यात्रा ख़त्म।" },
      { art: "earn", en: "After the rider pays, your share is added to your earnings automatically.", hi: "यात्री के भुगतान के बाद आपका हिस्सा अपने-आप कमाई में जुड़ जाता है।" },
      { art: "wallet", en: "Open “Earnings”, type an amount and press Withdraw to send money to your bank.", hi: "“Earnings” खोलें, रक़म लिखें और Withdraw दबाएँ। पैसा बैंक में जाएगा।" },
    ] },
];
