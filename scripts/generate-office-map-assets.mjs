#!/usr/bin/env node

// Rasterize the editable vector source into GPU-safe tiles. Never rasterize the
// approved reference screenshot: the SVG files are independent scene artwork.
import { readFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve("public/office-map");
const output = path.join(root, "rendered");
const layers = ["sky", "building", "floor", "furniture", "foreground"];
const worldWidth = 1672;
const worldHeight = 941;
const force = process.argv.includes("--force");

await mkdir(output, { recursive: true });

async function renderLayer(layer, scale, columns, rows, destination) {
  await mkdir(destination, { recursive: true });
  const sourceFile = path.join(root, `${layer}.svg`);
  const source = await readFile(sourceFile, "utf8");
  const sourceModified = (await stat(sourceFile)).mtimeMs;
  if (!source.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')) {
    throw new Error(`${layer}.svg has an unexpected root element`);
  }

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const tileX = (column * worldWidth) / columns;
      const tileY = (row * worldHeight) / rows;
      const tileWidth = worldWidth / columns;
      const tileHeight = worldHeight / rows;
      const tileSvg = source.replace(
        /^<svg[^>]*>/,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${tileWidth}" height="${tileHeight}" viewBox="${tileX} ${tileY} ${tileWidth} ${tileHeight}">`,
      );
      const file = path.join(destination, `${layer}-${column}-${row}.png`);
      const expectedWidth = Math.round(tileWidth * scale);
      const expectedHeight = Math.round(tileHeight * scale);
      if (!force) {
        try {
          const target = await stat(file);
          if (target.mtimeMs >= sourceModified) {
            const metadata = await sharp(file).metadata();
            if (metadata.width === expectedWidth && metadata.height === expectedHeight) continue;
          }
        } catch {
          // A missing or unreadable tile is regenerated below.
        }
      }
      const result = await sharp(Buffer.from(tileSvg), { density: 72 * scale })
        .png({ compressionLevel: 6, palette: false })
        .toFile(file);
      if (result.width !== expectedWidth || result.height !== expectedHeight) {
        throw new Error(`${file} rendered at ${result.width}×${result.height}`);
      }
      process.stdout.write(`${path.relative(process.cwd(), file)}\n`);
    }
  }
}

// Matching 4×4 grids let each high-resolution tile replace one base tile
// without creating holes while its neighbors are still loading. Only visible
// detail tiles enter GPU memory at a physical pixel scale above the 3× base.
for (const layer of layers) await renderLayer(layer, 3, 4, 4, output);
for (const layer of layers) await renderLayer(layer, layer === "furniture" ? 8 : 7, 4, 4, path.join(root, "detail"));

const planter = await sharp(path.join(root, "sprites/lush-planter.svg"), { density: 576 })
  .png({ compressionLevel: 6 })
  .toFile(path.join(root, "sprites/lush-planter.png"));
if (planter.width !== 800 || planter.height !== 1200) {
  throw new Error(`Lounge planter rendered at ${planter.width}×${planter.height}`);
}
