const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const inputFile = process.argv[2];

if (!inputFile || !fs.existsSync(inputFile)) {
  console.error("Please provide a valid input file path.");
  process.exit(1);
}

const rootDir = process.cwd();

const outputs = [
  { path: path.join(rootDir, "apps/web/app/icon.png"), size: 512 },
  {
    path: path.join(rootDir, "apps/web/public/icons/icon-192x192.png"),
    size: 192,
  },
  {
    path: path.join(rootDir, "apps/web/public/icons/icon-512x512.png"),
    size: 512,
  },
  {
    path: path.join(rootDir, "apps/web/public/splash_screens/icon.png"),
    size: 512,
  },
  { path: path.join(rootDir, "docs/favicon.png"), size: 512 },
];

async function generateIcons() {
  for (const output of outputs) {
    try {
      await sharp(inputFile)
        .resize(output.size, output.size)
        .toFile(output.path);
      console.log(`Generated ${output.path} (${output.size}x${output.size})`);
    } catch (err) {
      console.error(`Error generating ${output.path}:`, err);
    }
  }
}

generateIcons();
