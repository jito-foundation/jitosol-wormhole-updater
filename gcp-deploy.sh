#!/bin/zsh
npx tsup jitosol-updater/src/index.ts  -d .
gcloud config set project mev-data-341506
gcloud functions deploy jitosol-wormhole-update \
  --region us-central1 \
  --runtime nodejs20 \
  --trigger-http \
  --entry-point updater \
  --security-level secure-always \
  --env-vars-file .env.arbitrum.yaml
