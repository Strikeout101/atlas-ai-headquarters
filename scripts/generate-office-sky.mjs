#!/usr/bin/env node

// A repeatable vector panorama. All cloud edges, buildings and windows are
// drawn at source resolution before the map is rasterized into Pixi tiles.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

let seed = 247314;
function random() {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 4294967296;
}
const pick = (items) => items[Math.floor(random() * items.length)];
const out = [];

out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1672" height="941" viewBox="0 0 1672 941">`);
out.push(`<defs>
  <linearGradient id="summerSky" x2="0" y2="1"><stop stop-color="#0878db"/><stop offset=".26" stop-color="#269cef"/><stop offset=".58" stop-color="#8ed4ff"/><stop offset="1" stop-color="#e4f7ff"/></linearGradient>
  <linearGradient id="cloudBody" x2="0" y2="1"><stop stop-color="#fffefa"/><stop offset=".52" stop-color="#e9f7ff"/><stop offset="1" stop-color="#8abfe8"/></linearGradient>
  <linearGradient id="farTower" x2="0" y2="1"><stop stop-color="#e0f5ff"/><stop offset="1" stop-color="#8bc4e9"/></linearGradient>
  <linearGradient id="cityTower" x2="0" y2="1"><stop stop-color="#bde7ff"/><stop offset=".48" stop-color="#4e9ed5"/><stop offset="1" stop-color="#23639d"/></linearGradient>
  <linearGradient id="nearTower" x2="0" y2="1"><stop stop-color="#3a8fc5"/><stop offset=".52" stop-color="#145c9b"/><stop offset="1" stop-color="#153c72"/></linearGradient>
  <linearGradient id="glassFace" x2="0" y2="1"><stop stop-color="#c2edff" stop-opacity=".9"/><stop offset="1" stop-color="#0c5c9e" stop-opacity=".7"/></linearGradient>
  <linearGradient id="greenBelt" x2="0" y2="1"><stop stop-color="#7dc2c5"/><stop offset=".55" stop-color="#459baf"/><stop offset="1" stop-color="#197ca0"/></linearGradient>
  <filter id="cloudEdge" x="-12%" y="-40%" width="124%" height="180%"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="3" seed="4" result="rough"/><feDisplacementMap in="SourceGraphic" in2="rough" scale="5" xChannelSelector="R" yChannelSelector="G"/></filter>
</defs>`);
out.push(`<rect width="1672" height="941" fill="url(#summerSky)"/>`);

// The small warm-edged billows follow the dense, uneven cloud banks in the
// reference instead of repeating a single cartoon cloud silhouette.
function cloud(cx, cy, width, height) {
  const left = cx - width / 2;
  const right = cx + width / 2;
  const bottom = cy + height * 0.34;
  const count = Math.max(8, Math.round(width / 18));
  let silhouette = `M${left.toFixed(1)} ${bottom.toFixed(1)}`;
  for (let i = 0; i < count; i++) {
    const x0 = left + (i / count) * width;
    const x1 = left + ((i + 1) / count) * width;
    const mid = (x0 + x1) / 2;
    const taper = Math.sin(((i + 0.5) / count) * Math.PI);
    const crest = cy - height * (0.14 + taper * (0.36 + random() * 0.35));
    silhouette += ` Q${mid.toFixed(1)} ${crest.toFixed(1)} ${x1.toFixed(1)} ${(cy - height * (0.04 + random() * 0.12)).toFixed(1)}`;
  }
  silhouette += ` L${right.toFixed(1)} ${bottom.toFixed(1)} Q${cx.toFixed(1)} ${(bottom + height * 0.19).toFixed(1)} ${left.toFixed(1)} ${bottom.toFixed(1)}Z`;
  out.push(`<g filter="url(#cloudEdge)" opacity=".85"><path d="${silhouette}" fill="url(#cloudBody)"/><path d="M${(left + width * 0.08).toFixed(1)} ${(bottom - height * 0.1).toFixed(1)}Q${cx.toFixed(1)} ${(bottom + height * 0.08).toFixed(1)} ${(right - width * 0.05).toFixed(1)} ${(bottom - height * 0.05).toFixed(1)}" fill="none" stroke="#79b5df" stroke-width="2" opacity=".35"/></g>`);
}
// The exposed top strip is an editable four-tone vector trace of the approved
// reference's clouds. Its paths are rasterized directly at map tile density.
out.push(await readFile(path.resolve("public/office-map/traced-clouds.svg"), "utf8"));
for (const [x, y, w, h] of [
  [25, 131, 95, 24],
  [1642, 127, 118, 26],
])
  cloud(x, y, w, h);

// Numerous distant, varied towers keep the city readable through every
// facade pane. Narrow highlights and unequal rooftops add depth at 3x zoom.
function tower(x, top, width, bottom, near = false) {
  const fill = near ? "url(#nearTower)" : "url(#cityTower)";
  const roof = top + 4;
  const roofStyle = Math.abs(Math.floor(Math.sin(x * 0.137) * 1000)) % 4;
  const roofLine =
    roofStyle === 0
      ? `V${top}H${x + width}`
      : roofStyle === 1
        ? `V${roof}L${x + width * 0.13} ${top}H${x + width * 0.87}L${x + width} ${roof}`
        : roofStyle === 2
          ? `V${roof}H${x + width * 0.24}V${top}H${x + width * 0.75}V${roof}H${x + width}`
          : `V${roof}L${x + width * 0.2} ${top + 2}L${x + width * 0.78} ${top}L${x + width} ${roof}`;
  out.push(
    `<g><path d="M${x} ${bottom}${roofLine}V${bottom}Z" fill="${fill}" stroke="${near ? "#174d80" : "#74aed5"}" stroke-width="1.1"/>`,
  );
  out.push(
    `<path d="M${x + width * 0.72} ${top + 5}H${x + width - 2}V${bottom}H${x + width * 0.72}Z" fill="#0d4f89" opacity="${near ? ".13" : ".08"}"/>`,
  );
  out.push(
    `<path d="M${x + 3} ${roof + 4}V${bottom}M${x + width - 4} ${roof + 4}V${bottom}" fill="none" stroke="#d4f3ff" stroke-width="1" opacity=".48"/>`,
  );
  if (width > 20)
    out.push(
      `<rect x="${x + width * 0.23}" y="${top + 7}" width="${width * 0.54}" height="${Math.max(4, bottom - top - 9)}" fill="url(#glassFace)" opacity=".18"/>`,
    );
  const cols = Math.max(1, Math.floor((width - 7) / (near ? 8 : 6)));
  const rows = Math.floor((bottom - top - 8) / (near ? 13 : 10));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (random() < 0.17) continue;
      const wx = x + 5 + col * ((width - 10) / cols);
      const wy = top + 10 + row * (near ? 13 : 10);
      out.push(
        `<rect x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="${near ? 3.2 : 2.3}" height="${near ? 5.5 : 3.5}" fill="${pick(near ? ["#8ac7e5", "#e4faff", "#3b94c2"] : ["#f2fdff", "#bfeaff", "#7dc8eb"])}" opacity="${near ? ".55" : ".72"}"/>`,
      );
    }
  }
  out.push(`</g>`);
}

// A luminous distant skyline and irregular tree belt match the original's
// mixture of blue high-rises and green ground beyond the tower.
out.push(`<path d="M0 313Q220 279 408 304T817 301T1246 294T1672 306V941H0Z" fill="#c5edfa"/>`);
for (let x = -16; x < 1690; ) {
  const w = 9 + Math.floor(random() * 22);
  const top = 208 + Math.floor(random() * 104);
  out.push(`<rect x="${x}" y="${top}" width="${w}" height="${326 - top}" fill="url(#farTower)" opacity=".78"/>`);
  if (random() < 0.34) out.push(`<path d="M${x + w / 2} ${top - 11}V${top}" stroke="#c5edfa" stroke-width="1"/>`);
  x += w + 3 + Math.floor(random() * 11);
}
out.push(
  `<path d="M0 333Q145 301 271 338Q428 302 579 326Q731 295 846 329Q1010 301 1153 335Q1334 295 1480 329Q1587 308 1672 322V941H0Z" fill="#7dc5cf" opacity=".84"/>`,
);
function crown(x, y, radius, fill, opacity) {
  const points = Array.from({ length: 9 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2;
    const roughness = 0.78 + Math.abs(Math.sin(x * 0.17 + i * 2.3)) * 0.29;
    return {
      x: x + Math.cos(angle) * radius * roughness,
      y: y + Math.sin(angle) * radius * 0.67 * roughness,
    };
  });
  let d = `M${((points[8].x + points[0].x) / 2).toFixed(1)} ${((points[8].y + points[0].y) / 2).toFixed(1)}`;
  for (let i = 0; i < 8; i++) {
    const next = points[i + 1];
    d += `Q${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)} ${((points[i].x + next.x) / 2).toFixed(1)} ${((points[i].y + next.y) / 2).toFixed(1)}`;
  }
  out.push(`<path d="${d}Z" fill="${fill}" opacity="${opacity}"/>`);
}
for (let x = -15; x < 1690; x += 12) {
  const y = 315 + Math.floor(random() * 37);
  crown(x, y, 6 + random() * 10, pick(["#5eb7bf", "#68c4bb", "#439eaf", "#95d1b7"]), ".86");
}

// These side panoramas stay visible around the cutaway walls. They are not
// duplicated inside the office floor or its window-frame layer.
for (const [start, end] of [
  [-15, 180],
  [1490, 1690],
]) {
  for (let x = start; x < end; ) {
    const width = 13 + Math.floor(random() * 22);
    const top = 352 + Math.floor(random() * 180);
    tower(x, top, width, 668);
    x += width + 2 + Math.floor(random() * 8);
  }
}

// Secondary skyline fills the lower glass levels. The office building's own
// glass tint and mullions remain separate foreground/building assets.
out.push(`<path d="M0 680Q360 652 726 670Q1135 647 1672 666V941H0Z" fill="#a3d9ed" opacity=".62"/>`);
for (let x = -10; x < 1690; ) {
  const width = 17 + Math.floor(random() * 39);
  const top = 611 + Math.floor(random() * 93);
  tower(x, top, width, 942);
  x += width + 4 + Math.floor(random() * 12);
}
out.push(
  `<path d="M0 754Q161 711 321 746Q468 711 619 738Q812 702 974 748Q1180 715 1341 736Q1510 704 1672 742V941H0Z" fill="url(#greenBelt)" opacity=".77"/>`,
);
for (let x = -7; x < 1685; x += 21) {
  const y = 744 + Math.floor(random() * 28);
  crown(x, y, 8 + random() * 15, pick(["#2e8d9d", "#4aa4a4", "#6fb7aa", "#3f97a4"]), ".79");
}
for (let x = -20; x < 1690; ) {
  const width = 22 + Math.floor(random() * 47);
  const top = 772 + Math.floor(random() * 116);
  tower(x, top, width, 942, true);
  x += width + 3 + Math.floor(random() * 13);
}
out.push(`<path d="M0 928Q370 902 747 928T1672 923V941H0Z" fill="#16527b" opacity=".45"/>`);
out.push(`</svg>`);

await writeFile(path.resolve("public/office-map/sky.svg"), out.join(""));
