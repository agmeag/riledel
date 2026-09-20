# Filedele

Local, phone-friendly media triage for an attached drive. Swipe right to keep, swipe left to move into a reviewable delete folder.

## Run

```bash
npm install
npm run dev
```

Open the Vite URL on the computer. On a phone connected to the same network, open `http://YOUR-COMPUTER-IP:5173`.

For the production-style single-server build:

```bash
npm run build
npm start
```

Then open `http://YOUR-COMPUTER-IP:3000`.

If port 3000 is already used, run `PORT=3100 npm start` and use that port instead.

Moved files are flattened into `.filedele/keep` and `.filedele/delete` inside the selected source. The scanner always excludes `.filedele`.
