# KGN Offerte

Offerte-app voor KGN Totaalservice. Installeerbaar op iPhone en Android. Van inspreken of foto's tot getekende opdracht en betaalde factuur.

## Wat de app kan
- **Overzicht van alle offertes** met status (concept, verstuurd, bekeken, getekend, afgewezen, gefactureerd, betaald), zoeken, filters en cijfers: openstaand bedrag, binnengehaald dit jaar, nog te ontvangen en scoringskans.
- **Online laten tekenen**: de klant krijgt een link (WhatsApp, mail of sms), bekijkt de offerte op de telefoon en tekent met de vinger. De handtekening komt in de offerte en de PDF.
- **Meldingen**: een pushmelding zodra een klant de offerte opent, tekent, afwijst of betaalt. Op iPhone werkt dat als de app op het beginscherm staat.
- **Foto's met AI**: foto's maken van de situatie. De AI kijkt mee, stelt werkzaamheden en hoeveelheden voor en de foto's kunnen als bijlage in de offerte.
- **Inspreken in je eigen taal** (Nederlands, Engels, Pools, Turks en meer). De offerte komt altijd in het Nederlands.
- **Van offerte naar factuur** per termijn (uit de betaaltermijnen) of in een keer, met eigen nummering (F-2026-001), een QR-code om te betalen met de bank-app en een betaallink voor de klant. Met een Mollie-key kan de klant direct met iDEAL betalen en wordt de factuur vanzelf op betaald gezet.
- **Opvolgen**: offertes zonder reactie na 7 dagen en facturen over de vervaldatum komen bovenaan het overzicht, met een kant-en-klaar WhatsApp- of mailbericht.
- **Postcode en huisnummer** vullen het adres vanzelf in (PDOK). Eerdere klanten zijn op te zoeken.
- **Materiaallijst** per offerte voor de bouwmarkt, af te vinken en te delen.
- **Dupliceren** van een offerte voor een vergelijkbare klus.
- **Huisstijl**: eigen kleur en logo op offerte, factuur en klantpagina.

## Wat er in zit
- `public/index.html` de app (PWA).
- `public/o.html` de pagina die de klant ziet: offerte bekijken en tekenen, factuur bekijken en betalen.
- `server.js` de server: pincode, offertes en facturen bewaren, spraak naar tekst en tekst/foto's naar offerteregels (Groq), PDF maken, meldingen, adres opzoeken en Mollie.
- `Dockerfile` voor Railway (inclusief Chromium voor de PDF).

## Op Railway zetten
1. Maak een gratis Groq-account op console.groq.com en maak een API key aan.
2. Railway: New Project > Deploy from GitHub repo > kies deze repository. Railway gebruikt automatisch de Dockerfile.
3. Variables toevoegen:
   - `GROQ_API_KEY` = je Groq key
   - `APP_PIN` = pincode voor de app (bijvoorbeeld 4 of 6 cijfers)
   - `DATA_DIR` = `/data`
   - Optioneel `MOLLIE_API_KEY` = je Mollie live- of test-key, voor betalen met iDEAL
   - Optioneel `PUBLIC_URL` = het adres van de app, bijvoorbeeld `https://offerte.kgntotaalservice.nl` (anders wordt het adres uit de aanvraag gebruikt)
4. Voeg een **Volume** toe aan de service met mount path `/data`. Daar staan offertes, facturen, foto's, prijzen en instellingen. Zonder volume ben je alles kwijt bij elke nieuwe deploy.
5. Settings > Networking > Generate Domain. Of koppel een eigen subdomein, bijvoorbeeld offerte.kgntotaalservice.nl, via een CNAME.

## Eerste keer instellen in de app
- Bedrijfsgegevens invullen, vooral het **IBAN** (voor de betaal-QR op facturen), KvK- en btw-nummer.
- Eventueel huisstijlkleur en eigen logo.
- In het overzicht op **Meldingen aanzetten** tikken.

## Installeren op de telefoon
- iPhone: open de link in Safari, tik op Deel en kies "Zet op beginscherm". Open de app daarna vanaf het beginscherm (nodig voor meldingen).
- Android: open de link in Chrome, tik op het menu en kies "App installeren" of "Toevoegen aan startscherm".

## Goed om te weten
- Zonder `GROQ_API_KEY` werkt de app ook, met de eenvoudige trefwoordherkenning en de spraakherkenning van de browser. Foto-herkenning heeft de key wel nodig.
- De gratis Groq-tier heeft limieten. Bij een paar offertes per dag merk je daar niets van.
- Prijzen in de prijslijst en de materiaallijst zijn voorbeeldwaarden. Pas de prijzen aan in de app; ze worden op de server bewaard voor alle toestellen.
- Offline invullen kan; versturen, het overzicht en facturen werken alleen online.
- Lokaal draaien: `npm install` en `GROQ_API_KEY=... APP_PIN=1234 CHROME_PATH=/pad/naar/chrome node server.js`.
