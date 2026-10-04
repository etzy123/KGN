# KGN Offerte

Offerte-app voor KGN Totaalservice. Installeerbaar op iPhone en Android, met inspreken, AI-herkenning en PDF delen via WhatsApp of mail.

## Wat er in zit
- `public/` de app (PWA): offerte invullen, inspreken, voorbeeld, PDF.
- `server.js` kleine server: pincode, gedeelde prijzen en offertenummer, spraak naar tekst (Groq Whisper), tekst naar offerteregels (Groq taalmodel), PDF maken.
- `Dockerfile` voor Railway (inclusief Chromium voor de PDF).

## Op Railway zetten
1. Maak een gratis Groq-account op console.groq.com en maak een API key aan.
2. Zet deze map in een (privé) GitHub-repository.
3. Railway: New Project > Deploy from GitHub repo > kies de repository. Railway gebruikt automatisch de Dockerfile.
4. Variables toevoegen:
   - `GROQ_API_KEY` = je Groq key
   - `APP_PIN` = pincode voor de app (bijvoorbeeld 4 of 6 cijfers)
   - `DATA_DIR` = `/data`
5. Voeg een Volume toe aan de service met mount path `/data`. Daar worden prijzen, bedrijfsgegevens en het offertenummer bewaard. Zonder volume raak je die kwijt bij elke nieuwe deploy.
6. Settings > Networking > Generate Domain. Of koppel een eigen subdomein, bijvoorbeeld offerte.kgntotaalservice.nl, via een CNAME.

Met de Railway CLI kan het ook: `railway init` en daarna `railway up` in deze map.

## Installeren op de telefoon
- iPhone: open de link in Safari, tik op Deel en kies "Zet op beginscherm".
- Android: open de link in Chrome, tik op het menu en kies "App installeren" of "Toevoegen aan startscherm".

## Goed om te weten
- Zonder `GROQ_API_KEY` werkt de app ook, met de eenvoudige trefwoordherkenning en de spraakherkenning van de browser.
- De gratis Groq-tier heeft limieten. Bij een paar offertes per dag merk je daar niets van.
- Prijzen in de prijslijst zijn voorbeeldprijzen. Pas ze aan in de app, ze worden op de server bewaard voor alle toestellen.
- Lokaal draaien: `npm install` en `GROQ_API_KEY=... APP_PIN=1234 CHROME_PATH=/pad/naar/chrome node server.js`.
