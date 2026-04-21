# Facebook social graphics drop zone

This folder is the manual asset handoff for the Facebook social cron pipeline.

## Contract
- Supply exactly 3 branded graphics per post run.
- Preferred filenames: `graphic-1.png`, `graphic-2.png`, `graphic-3.png`
- Supported formats: `.png`, `.jpg`, `.jpeg`, `.webp`
- The pipeline does **not** generate images automatically.
- If fewer than 3 graphics are present, the run is marked `awaiting-designer-assets` and placeholder attachment slots are emitted in the payload.

## Environment overrides
- `FACEBOOK_SOCIAL_GRAPHICS_DIR` to change the source directory
- `FACEBOOK_SOCIAL_GRAPHIC_COUNT` to change expected count (default `3`)
- `FACEBOOK_SOCIAL_WEBHOOK_URL` to send the assembled payload onward
- `FACEBOOK_SOCIAL_POST_TEXT` to define the text body used by the cron job
- `FACEBOOK_SOCIAL_CRON_ENABLED=true` to enable the scheduled run
- `FACEBOOK_SOCIAL_CRON_TIME=09:00` to change the daily schedule
