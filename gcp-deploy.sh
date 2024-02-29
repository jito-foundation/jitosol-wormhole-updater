#!/bin/zsh
npm run build
mv index.js function.js
gcloud config set project mev-data-341506
gcloud functions deploy jitosol-wormhole-update \
  --region us-central1 \
  --runtime nodejs20 \
  --trigger-http \
  --entry-point updater \
  --security-level secure-always \
  --env-vars-file .env.arbitrum.yaml
