// Composite matchup thumbnail generator for PeerTube plugin
// Usage: Call generateMatchupThumbnail with logo URLs and school IDs

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fetch = require('node-fetch');

const THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_HEIGHT = 720;
const LOGO_SIZE = 640; // Use more vertical space
const PLACEHOLDER_COLOR = { r: 230, g: 230, b: 230, alpha: 1 };
// Always resolve to the actual plugin install path in the container
const THUMBNAIL_DIR = path.join(__dirname, 'static', 'matchup-thumbnails');
const VS_IMAGE_PATH = path.join(__dirname, 'assets', 'versus-image.png'); // Use VS image from assets

function getMatchupKey(teamIdA, teamIdB) {
  const ids = [teamIdA || 'no_logo', teamIdB || 'no_logo'].sort();
  return `matchup_${ids[0]}_${ids[1]}.jpg`;
}

async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.buffer();
  } catch {
    return null;
  }
}

async function getPlaceholderBuffer(teamName = '') {
  // Create SVG with team name, auto-size and wrap
  const fontSize = 48;
  const maxWidth = LOGO_SIZE - 40;
  const maxHeight = LOGO_SIZE - 40;
  // Simple word wrap: split by space, try to fit lines
  function wrapText(text, maxChars) {
    if (!text || typeof text !== 'string') text = '';
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).trim().length > maxChars) {
        lines.push(line.trim());
        line = word;
      } else {
        line += ' ' + word;
      }
    }
    if (line) lines.push(line.trim());
    return lines;
  }
  const lines = wrapText(teamName, 18);
  const lineHeight = fontSize * 1.2;
  const svgHeight = Math.min(maxHeight, lines.length * lineHeight);
  const svg = `<svg width="${LOGO_SIZE}" height="${LOGO_SIZE}" viewBox="0 0 ${LOGO_SIZE} ${LOGO_SIZE}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white" />
    <g>
      ${lines.map((line, i) => {
    const y = (LOGO_SIZE - svgHeight) / 2 + (i + 1) * lineHeight - lineHeight / 4;
    return `<text x="50%" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" font-weight="bold" fill="#333">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>`;
  }).join('')}
    </g>
  </svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function generateMatchupThumbnail(homeLogoUrl, awayLogoUrl, homeId, awayId, homeName, awayName) {

  const matchupKey = getMatchupKey(homeId, awayId);
  const thumbnailPath = path.join(THUMBNAIL_DIR, matchupKey);

  // Ensure the directory exists
  if (!fs.existsSync(THUMBNAIL_DIR)) {
    fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
  }

  // 1. Check if cached image exists
  if (fs.existsSync(thumbnailPath)) {
    return thumbnailPath;
  }

  // 2. Download logos (use placeholder if missing)
  // If logo missing, use team name placeholder
  const homeLogo = await fetchImageBuffer(homeLogoUrl) || await getPlaceholderBuffer(homeName);
  const awayLogo = await fetchImageBuffer(awayLogoUrl) || await getPlaceholderBuffer(awayName);

  // Helper: detect background color from top-left 10x10 pixels
  async function detectCornerColor(imageBuffer) {
    const region = { left: 0, top: 0, width: 10, height: 10 };
    const { data, info } = await sharp(imageBuffer).extract(region).raw().toBuffer({ resolveWithObject: true });
    let rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
    }
    const pixelCount = data.length / info.channels;
    const avgR = rSum / pixelCount;
    const avgG = gSum / pixelCount;
    const avgB = bSum / pixelCount;
    // Use the actual detected average color for the background
    return { r: Math.round(avgR), g: Math.round(avgG), b: Math.round(avgB), alpha: 1 };
  }

  // Detect background color for each logo
  const homeBgColor = await detectCornerColor(homeLogo);
  const awayBgColor = await detectCornerColor(awayLogo);

  // 3. Resize logos and flatten transparency onto detected background
  const homeLogoResized = await sharp(homeLogo)
    .flatten({ background: homeBgColor })
    .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: homeBgColor })
    .flatten({ background: homeBgColor })
    .png()
    .toBuffer();
  const awayLogoResized = await sharp(awayLogo)
    .flatten({ background: awayBgColor })
    .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: awayBgColor })
    .flatten({ background: awayBgColor })
    .png()
    .toBuffer();

  // 4. Create base image with left/right backgrounds
  const leftHalf = await sharp({
    create: {
      width: THUMBNAIL_WIDTH / 2,
      height: THUMBNAIL_HEIGHT,
      channels: 4,
      background: homeBgColor
    }
  }).png().toBuffer();
  const rightHalf = await sharp({
    create: {
      width: THUMBNAIL_WIDTH / 2,
      height: THUMBNAIL_HEIGHT,
      channels: 4,
      background: awayBgColor
    }
  }).png().toBuffer();
  // Combine halves
  let base = await sharp({
    create: {
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite([
      { input: leftHalf, left: 0, top: 0 },
      { input: rightHalf, left: THUMBNAIL_WIDTH / 2, top: 0 }
    ])
    .png()
    .toBuffer();

  // 5. Composite: left logo, right logo, VS text (allow VS to overlap logos)
  const leftX = Math.round(THUMBNAIL_WIDTH * 0.18 - LOGO_SIZE / 2);
  const rightX = Math.round(THUMBNAIL_WIDTH * 0.82 - LOGO_SIZE / 2);
  const centerY = Math.round((THUMBNAIL_HEIGHT - LOGO_SIZE) / 2);

  let composite = await sharp(base)
    .composite([
      { input: homeLogoResized, left: leftX, top: centerY },
      { input: awayLogoResized, left: rightX, top: centerY }
    ])
    .jpeg()
    .toBuffer();

  // 6. Add VS PNG overlay (centered)
  const vsImageBuffer = await sharp(VS_IMAGE_PATH)
    .resize(Math.round(THUMBNAIL_WIDTH * 0.4)) // scale VS PNG to 40% of canvas width
    .png()
    .toBuffer();
  const vsLeft = Math.round((THUMBNAIL_WIDTH - Math.round(THUMBNAIL_WIDTH * 0.4)) / 2);
  const vsTop = Math.round((THUMBNAIL_HEIGHT - Math.round(THUMBNAIL_WIDTH * 0.4) * (422 / 600)) / 2); // keep aspect ratio
  composite = await sharp(composite)
    .composite([
      {
        input: vsImageBuffer,
        left: vsLeft,
        top: vsTop
      }
    ])
    .jpeg()
    .toBuffer();

  // 7. Save to cache
  fs.writeFileSync(thumbnailPath, composite);
  return thumbnailPath;
}

module.exports = {
  generateMatchupThumbnail,
  getMatchupKey,
  THUMBNAIL_DIR
};
