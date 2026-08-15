# IDFinder1 frontend

React + TypeScript + Vite. Lost & found ID matching UI: browse public
listings, sign in to report a lost or found ID, get auto-filled details
from an ID photo via OCR.

## Local development

```bash
npm install
cp .env.example .env   # fill in with `terraform output` values after deploying
npm run dev
```

## Build

```bash
npm run build
```

Deployed environments get their `.env` values injected automatically by
Amplify Hosting -- see `../terraform/amplify.tf`. You shouldn't need to
edit `.env` outside of local development.

## Design system

Colors, type, and the ticket-stub card pattern are defined in
`src/index.css` and `tailwind.config.js` -- see those for the token
system if you're adding new UI.
