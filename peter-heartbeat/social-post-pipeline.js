'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SCHEDULE = '08:00';
const DEFAULT_OUTPUT_ROOT = path.join(__dirname, 'output', 'facebook-packs');
const DEFAULT_REFERENCE_COPY = path.join(process.env.HOME || '', '.openclaw', 'workspace', 'memory', 'DES-207-facebook-copy-deck', 'str-clinic-facebook-post-copy-deck.md');
const DEFAULT_BRAND_BRIEF = path.join(process.env.HOME || '', '.openclaw', 'workspace', 'design-references', 'str-clinic', 'STR-CLINIC-DESIGN-DOCTRINE.md');
const DEFAULT_BRANDON_CHAT_ID = '5821364140';

const POST_LIBRARY = [
  {
    id: 'post-01',
    title: 'Pricing vs positioning',
    creativeSource: path.join(process.env.HOME || '', '.openclaw', 'workspace', 'memory', 'DES-205-facebook-public-assets', 'des-205-post-01-positioning-before-price.png'),
    creativeFilename: '01-pricing-vs-positioning.png',
    headline: 'A pricing problem is often a positioning problem first.',
    hashtags: ['#AirbnbHost', '#UKHosts', '#ShortTermRental', '#AirbnbTips', '#HolidayLet', '#STRStrategy'],
    body: [
      'A lot of Airbnb hosts cut price when the real problem is positioning.',
      '',
      'When the calendar softens, the instinct is usually to shave a bit off the nightly rate.',
      '',
      'Sometimes that helps.',
      'A lot of the time, it just makes an average listing cheaper.',
      '',
      'Guests do not book on price alone.',
      'They book on whether the listing feels like the right fit, at the right standard, with enough confidence to say yes.',
      '',
      'So your real competition is not every nearby listing.',
      'It is the smaller group a guest would genuinely compare you against.',
      '',
      'In UK markets especially, hosts get this wrong all the time.',
      'They compare themselves to anything close by, then wonder why price drops are not improving conversion.',
      '',
      'If your photos feel sharper, your space feels easier to understand, and your title makes the value clear, you can often sit above the market.',
      '',
      'If your listing feels vague or forgettable, pricing near the best listings around you usually hurts.',
      '',
      'That is not a pricing issue.',
      'It is a positioning issue wearing a pricing hat.',
      '',
      'The hosts who hold rate better usually do one thing well:',
      'They make the stay feel worth it before the guest even opens the calendar.',
    ],
    insight: 'Helps UK hosts separate discounting from positioning weakness, especially in softer shoulder-season demand.',
  },
  {
    id: 'post-02',
    title: 'Photo order builds trust',
    creativeSource: path.join(process.env.HOME || '', '.openclaw', 'workspace', 'memory', 'DES-206-posts-2-and-3-rebuild', 'des-206-post-02-photo-order-trust-rebuild.png'),
    creativeFilename: '02-photo-order-builds-trust.png',
    headline: 'A strong first photo means less if the next ones weaken trust.',
    hashtags: ['#AirbnbPhotos', '#UKAirbnb', '#ShortStayHost', '#HolidayCottage', '#AirbnbAdvice', '#STRMarketing'],
    body: [
      'Your first photo gets the click. Your next few photos decide whether the guest trusts you.',
      '',
      'A lot of hosts think photo quality is the main thing.',
      'It matters, obviously.',
      'But photo order is where a lot of bookings get lost.',
      '',
      'Guests make fast decisions.',
      'Usually they are asking themselves, without even realising it:',
      '',
      '- does this place feel clean?',
      '- does it feel bright?',
      '- can I picture the stay easily?',
      '- does it feel worth the price?',
      '',
      'If photo 1 is strong but photos 2, 3 and 4 are weak, cluttered or in the wrong order, confidence drops quickly.',
      '',
      'I see this a lot with decent UK listings.',
      'The property itself is fine.',
      'The presentation sequence is what is doing the damage.',
      '',
      'A smart photo set usually does four things:',
      '- opens with the clearest selling image',
      '- follows with the room or feature that strengthens the promise',
      '- removes confusion early',
      '- helps the guest understand layout, quality and feel without effort',
      '',
      'Good photos are not just decoration.',
      'They are part of the sales argument.',
      '',
      'And when demand softens, weak photo order gets exposed very quickly.',
    ],
    insight: 'Useful for UK hosts relying on decent photography but losing conversion because the sequence does not build confidence.',
  },
  {
    id: 'post-03',
    title: 'Full calendar, wrong reason',
    creativeSource: path.join(process.env.HOME || '', '.openclaw', 'workspace', 'memory', 'DES-206-posts-2-and-3-rebuild', 'des-206-post-03-full-calendar-right-reasons-rebuild.png'),
    creativeFilename: '03-full-calendar-right-reasons.png',
    headline: 'A full calendar can still mean the price was too easy to say yes to.',
    hashtags: ['#AirbnbHosting', '#UKHolidayLets', '#RevenueStrategy', '#ShortTermRentalTips', '#AirbnbBusiness', '#HostEducation'],
    body: [
      'Being fully booked does not always mean your listing is well positioned.',
      '',
      'This catches a lot of hosts out.',
      'A full calendar feels like proof that everything is working.',
      'Sometimes it is.',
      'Sometimes it just means you were easy to say yes to.',
      '',
      'There is a difference between:',
      '- being fully booked because your listing is strong',
      '- being fully booked because your price sat safely below what the market would have paid',
      '',
      'That distinction matters.',
      '',
      'The best listings do not just fill nights.',
      'They make the stay feel clear, credible and worth the rate.',
      '',
      'That usually shows up in a few ways:',
      '- stronger first impression',
      '- better alignment between title, photos and price',
      '- less reliance on discounting',
      '- more consistency outside obvious peak dates',
      '',
      'In softer periods, this becomes even clearer.',
      'Average listings tend to chase occupancy.',
      'Better-positioned listings protect margin for longer.',
      '',
      'So yes, occupancy matters.',
      'But on its own, it is not the full story.',
      '',
      'A host can be busy and still be under-positioned.',
      'A host can be booked and still be leaving money on the table.',
      '',
      'The more useful question is not just, am I full?',
      'It is, am I full for the right reasons?',
    ],
    insight: 'Frames occupancy versus margin in a way that feels grounded for UK short-let hosts, without fluff or engagement bait.',
  },
];

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function getDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function formatLondonDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const day = parts.find((part) => part.type === 'day')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const year = parts.find((part) => part.type === 'year')?.value;

  return { year, month, day, isoDate: `${year}-${month}-${day}` };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveReferenceFile(...candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function copyFileStrict(source, destination) {
  if (!source || !fs.existsSync(source)) {
    throw new Error(`Required creative asset missing: ${source || 'unknown source'}`);
  }
  fs.copyFileSync(source, destination);
}

function buildPostText(post) {
  return [post.body.join('\n'), '', post.hashtags.join(' ')].join('\n');
}

function buildDeck(posts, context) {
  const header = [
    '# STR Clinic Daily Facebook Pack',
    '',
    `Date: ${context.isoDate}`,
    `Generated at: ${context.generatedAt}`,
    `Timezone: Europe/London`,
    '',
    'This pack contains exactly 3 Facebook posts and 3 matched creatives, ready for Brandon to use immediately.',
    '',
  ];

  const sections = posts.flatMap((post, index) => [
    `## Post ${index + 1}: ${post.title}`,
    `Matched creative: creatives/${post.creativeFilename}`,
    `Editorial angle: ${post.insight}`,
    '',
    buildPostText(post),
    '',
    '---',
    '',
  ]);

  return [...header, ...sections].join('\n');
}

function buildManifest(posts, context, outputDir) {
  return {
    generatedAt: context.generatedAt,
    timezone: 'Europe/London',
    date: context.isoDate,
    outputDir,
    posts: posts.map((post, index) => ({
      index: index + 1,
      id: post.id,
      title: post.title,
      textFile: `posts/${String(index + 1).padStart(2, '0')}-${post.id}.md`,
      creativeFile: `creatives/${post.creativeFilename}`,
      hashtags: post.hashtags,
      headline: post.headline,
    })),
  };
}

function createFacebookPack({ now = new Date(), outputRoot = DEFAULT_OUTPUT_ROOT, logger = console } = {}) {
  const context = formatLondonDateParts(now);
  const generatedAt = new Date(now).toISOString();
  const packDir = path.join(outputRoot, context.isoDate);
  const postsDir = path.join(packDir, 'posts');
  const creativesDir = path.join(packDir, 'creatives');

  ensureDir(postsDir);
  ensureDir(creativesDir);

  const selectedPosts = POST_LIBRARY.map((post) => ({ ...post }));

  selectedPosts.forEach((post, index) => {
    const postFile = path.join(postsDir, `${String(index + 1).padStart(2, '0')}-${post.id}.md`);
    const content = [
      `# ${post.title}`,
      '',
      `Creative headline: ${post.headline}`,
      '',
      buildPostText(post),
      '',
    ].join('\n');
    fs.writeFileSync(postFile, content);

    const creativeDestination = path.join(creativesDir, post.creativeFilename);
    copyFileStrict(post.creativeSource, creativeDestination);
  });

  const deckContent = buildDeck(selectedPosts, { ...context, generatedAt });
  fs.writeFileSync(path.join(packDir, 'facebook-copy-deck.md'), deckContent);

  const manifest = buildManifest(selectedPosts, { ...context, generatedAt }, packDir);
  fs.writeFileSync(path.join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const provenance = {
    generatedAt,
    date: context.isoDate,
    copyReference: resolveReferenceFile(DEFAULT_REFERENCE_COPY),
    brandReference: resolveReferenceFile(DEFAULT_BRAND_BRIEF),
    creativeSources: selectedPosts.map((post) => ({ id: post.id, source: post.creativeSource })),
    checksum: crypto.createHash('sha1').update(deckContent).digest('hex'),
  };
  fs.writeFileSync(path.join(packDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

  logger.log(`[social] Facebook pack created at ${packDir}`);

  return {
    packDir,
    postsDir,
    creativesDir,
    generatedAt,
    dateKey: context.isoDate,
    deckPath: path.join(packDir, 'facebook-copy-deck.md'),
    manifestPath: path.join(packDir, 'manifest.json'),
    posts: selectedPosts.map((post, index) => ({
      ...post,
      index: index + 1,
      postPath: path.join(postsDir, `${String(index + 1).padStart(2, '0')}-${post.id}.md`),
      creativePath: path.join(creativesDir, post.creativeFilename),
    })),
  };
}

async function notifyBrandonSuccess(pack, { sendTelegram }) {
  if (typeof sendTelegram !== 'function') return;

  const lines = [
    '📘 <b>STR Clinic Facebook pack ready</b>',
    '',
    `Date: ${pack.dateKey}`,
    `Posts: ${pack.posts.length}`,
    `Creatives: ${pack.posts.length}`,
    `Deck: <code>${pack.deckPath}</code>`,
    `Folder: <code>${pack.packDir}</code>`,
    '',
    ...pack.posts.map((post) => `• ${post.title} → <code>${post.creativePath}</code>`),
  ];

  await sendTelegram(lines.join('\n'), { chatId: process.env.BRANDON_TELEGRAM_CHAT_ID || DEFAULT_BRANDON_CHAT_ID });
}

async function notifyBrandonFailure(error, context, { sendTelegram }) {
  if (typeof sendTelegram !== 'function') return;

  const lines = [
    '❌ <b>STR Clinic Facebook pack failed</b>',
    '',
    `Date: ${context.dateKey || getDateKey(new Date())}`,
    `Error: ${String(error.message || error).slice(0, 400)}`,
  ];

  if (context.packDir) lines.push(`Folder: <code>${context.packDir}</code>`);

  await sendTelegram(lines.join('\n'), { chatId: process.env.BRANDON_TELEGRAM_CHAT_ID || DEFAULT_BRANDON_CHAT_ID });
}

async function runFacebookSocialPostJob({
  state,
  saveState,
  sendTelegram,
  logger = console,
  now = new Date(),
}) {
  const enabled = parseBoolean(process.env.FACEBOOK_SOCIAL_CRON_ENABLED || 'true');
  if (!enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  const dateKey = formatLondonDateParts(now).isoDate;
  state.lastFacebookPackRuns = state.lastFacebookPackRuns || {};
  if (state.lastFacebookPackRuns[dateKey]) {
    return { skipped: true, reason: 'already-ran-today', previous: state.lastFacebookPackRuns[dateKey] };
  }

  try {
    const pack = createFacebookPack({
      now,
      outputRoot: process.env.FACEBOOK_SOCIAL_OUTPUT_ROOT || DEFAULT_OUTPUT_ROOT,
      logger,
    });

    state.lastFacebookPackRuns[dateKey] = {
      ranAt: now.toISOString(),
      status: 'success',
      packDir: pack.packDir,
      deckPath: pack.deckPath,
      postCount: pack.posts.length,
      creativeCount: pack.posts.length,
    };
    saveState(state);

    await notifyBrandonSuccess(pack, { sendTelegram });

    return {
      skipped: false,
      pack,
    };
  } catch (error) {
    state.lastFacebookPackRuns[dateKey] = {
      ranAt: now.toISOString(),
      status: 'failed',
      error: error.message,
    };
    saveState(state);

    await notifyBrandonFailure(error, { dateKey }, { sendTelegram });
    throw error;
  }
}

function scheduleDailyFacebookSocialJob({ stateLoader, saveState, sendTelegram, logger = console }) {
  const schedule = process.env.FACEBOOK_SOCIAL_CRON_TIME || DEFAULT_SCHEDULE;
  const [hoursRaw, minutesRaw] = schedule.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    logger.error(`[social] Invalid FACEBOOK_SOCIAL_CRON_TIME: ${schedule}`);
    return;
  }

  const scheduleNextRun = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    logger.log(`[social] Facebook pack job scheduled in ${Math.round(delay / 60000)} minutes (at ${next.toISOString()})`);

    setTimeout(async () => {
      try {
        const state = stateLoader();
        await runFacebookSocialPostJob({
          state,
          saveState,
          sendTelegram,
          logger,
          now: new Date(),
        });
      } catch (error) {
        logger.error('[social] Facebook pack job failed:', error.message);
      } finally {
        scheduleNextRun();
      }
    }, delay);
  };

  scheduleNextRun();
}

module.exports = {
  DEFAULT_SCHEDULE,
  DEFAULT_OUTPUT_ROOT,
  POST_LIBRARY,
  createFacebookPack,
  runFacebookSocialPostJob,
  scheduleDailyFacebookSocialJob,
};
