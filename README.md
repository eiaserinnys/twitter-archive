# Twitter Archive

Node.js 22 data import pipeline for the private account archive. Install dependencies with `npm install`.

## First local import

1. Apply the local D1 schema: `npx wrangler d1 migrations apply DB --local`.
2. Normalize an X archive zip or extracted directory: `npx tsx scripts/import-archive.ts --archive <archive> --data-dir ./data`.
3. Fill missing reply and quote context: `X_BEARER_TOKEN=... npx tsx scripts/fetch-context.ts --data-dir ./data --max-usd 40`.
4. Build scoring states or call Jev: `npx tsx scripts/score.ts --data-dir ./data --max-usd 2 --dry-run`.
5. Load tweets, scores, media metadata, topic seeds, and import metadata: `npx tsx scripts/load-d1.ts --data-dir ./data --local`.
6. Upload archive media to local R2 and set D1 keys: `npx tsx scripts/upload-media.ts --archive <archive> --data-dir ./data --local`.

For live scoring, provide `TYPESAFE_BASE_URL` and `TYPESAFE_API_KEY` in the shell. Do not commit their values.

`src/shared/topics.json` contains the initial v5 seed. After the first D1 load, the `topics` table is the canonical topic definition. Import data and generated scores stay under the ignored `data/` directory. Tests use synthetic archive records only.

This repository contains the Worker health endpoint and data registration pipeline. The archive UI, scheduled collection, search API, visibility fields, and period tags are later work.
