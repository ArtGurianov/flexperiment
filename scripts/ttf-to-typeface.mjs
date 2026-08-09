// Converts a TTF file into the three.js "typeface.json" format consumed by
// FontLoader/TextGeometry. Mirrors the parsing logic of
// three/examples/jsm/loaders/TTFLoader.js, but runs at build time via
// opentype.js instead of at runtime via a CDN import, so the app has no
// external network dependency and no bundler-unfriendly URL import.
//
// Usage: node scripts/ttf-to-typeface.mjs <input.ttf> <output.json>

import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";

const [, , input, output] = process.argv;

if (!input || !output) {
  console.error("Usage: node scripts/ttf-to-typeface.mjs <input.ttf> <output.json>");
  process.exit(1);
}

const buffer = readFileSync(input);
const font = opentype.parse(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
);

const round = Math.round;
const glyphs = {};
const scale = 100000 / ((font.unitsPerEm || 2048) * 72);

const glyphIndexMap = font.encoding.cmap.glyphIndexMap;
const unicodes = Object.keys(glyphIndexMap);

for (const unicode of unicodes) {
  const glyph = font.glyphs.glyphs[glyphIndexMap[unicode]];
  if (glyph === undefined) continue;

  const token = {
    ha: round(glyph.advanceWidth * scale),
    x_min: round((glyph.xMin ?? 0) * scale),
    x_max: round((glyph.xMax ?? 0) * scale),
    o: "",
  };

  glyph.path.commands.forEach((command) => {
    if (command.type.toLowerCase() === "c") {
      command.type = "b";
    }

    token.o += command.type.toLowerCase() + " ";

    if (command.x !== undefined && command.y !== undefined) {
      token.o += round(command.x * scale) + " " + round(command.y * scale) + " ";
    }
    if (command.x1 !== undefined && command.y1 !== undefined) {
      token.o += round(command.x1 * scale) + " " + round(command.y1 * scale) + " ";
    }
    if (command.x2 !== undefined && command.y2 !== undefined) {
      token.o += round(command.x2 * scale) + " " + round(command.y2 * scale) + " ";
    }
  });

  if (Array.isArray(glyph.unicodes) && glyph.unicodes.length > 0) {
    glyph.unicodes.forEach((u) => {
      glyphs[String.fromCodePoint(u)] = token;
    });
  } else {
    glyphs[String.fromCodePoint(glyph.unicode)] = token;
  }
}

const typeface = {
  glyphs,
  familyName: font.getEnglishName("fullName"),
  ascender: round(font.ascender * scale),
  descender: round(font.descender * scale),
  underlinePosition: font.tables.post.underlinePosition,
  underlineThickness: font.tables.post.underlineThickness,
  boundingBox: {
    xMin: font.tables.head.xMin,
    xMax: font.tables.head.xMax,
    yMin: font.tables.head.yMin,
    yMax: font.tables.head.yMax,
  },
  resolution: 1000,
  original_font_information: font.tables.name,
};

writeFileSync(output, JSON.stringify(typeface));
console.log(`Wrote ${output} (${Object.keys(glyphs).length} glyphs)`);
