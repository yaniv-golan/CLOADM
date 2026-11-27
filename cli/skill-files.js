// A skill folder (skills/<name>/ in this repository) as the files the MCP skills extension serves (js/mcp/skills.js):
// [{ path, text, size, digest }], sorted by path, each file's size and sha-256 from its bytes on disk. Used by the stdio
// server (cli/mcp.js) and by connector/build.js (the Worker's generated views), so both serve the same bytes.
// A file that is not UTF-8 text, a link or anything but a regular file is refused: the skill is markdown.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

function loadSkill(dir) {
  const files = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) throw new Error(`${path.join(dir, p)}: not a regular file`);
      const bytes = fs.readFileSync(path.join(dir, p));
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (err) { throw new Error(`${path.join(dir, p)}: not UTF-8 text`); }
      files.push({ path: p, text, size: bytes.length, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` });
    }
  };
  walk('');
  return { name: path.basename(dir), files };
}

// the skills this server serves: skills/cloadm/ (the plugin's skill, copied byte for byte to .agents/skills/cloadm/)
const servedSkills = () => [loadSkill(path.join(SKILLS_DIR, 'cloadm'))];

module.exports = { loadSkill, servedSkills, SKILLS_DIR };
