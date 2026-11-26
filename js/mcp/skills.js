/*
 * Agent skills served over MCP, transport-neutral: the "Skills over MCP" extension, io.modelcontextprotocol/skills
 * (https://modelcontextprotocol.io/extensions/skills/overview; specified against base revision 2026-07-28 in
 * github.com/modelcontextprotocol/ext-skills, specification skills.mdx). A server that declares it declares
 * `resources` too, and answers:
 *   skills/list  -> { skills: [Skill], ttlMs, cacheScope }   every skill, each manifest whole (one page: no cursor)
 *   skills/get   { uri } -> { skill: Skill, ttlMs, cacheScope }; an unknown uri is -32602, as resources/read's is
 *   resources/read { uri } -> { contents: [{ uri, mimeType, text }] } for every file a manifest lists
 * Skill = { uri: "skill://<name>/SKILL.md", frontmatter: {...SKILL.md's YAML, verbatim}, resources: [{ uri, digest:
 * "sha256:<hex>", size }] }, the manifest complete (SKILL.md and every supporting file), so a host can check each file
 * it reads against its size and digest. No directory reads (resources/directory/read is optional; directoryRead false).
 *
 * The skills are CLOADM's own, skills/<name>/ in the repository (skills/cloadm/, the one the plugin ships), read by the
 * host: cli/skill-files.js loads a folder (sizes and sha-256 digests from its bytes) for the stdio server (cli/mcp.js)
 * and for connector/build.js, which writes them into the Worker's generated views. Nothing here reads a file, so the
 * same table serves both: one source, the skill's own files, byte for byte.
 */
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
export const SKILL_SCHEME = 'skill://';
// a skill only changes with the server that serves it (a new release, or a new checkout)
export const SKILL_TTL_MS = 3600000;
const MIME = { md: 'text/markdown', txt: 'text/plain', json: 'application/json' };
export const mimeOf = (file) => MIME[(/\.([a-z0-9]+)$/i.exec(file) || [])[1]?.toLowerCase()] || null;

export class SkillError extends Error {
  constructor(message) { super(message); this.code = -32602; }   // Invalid params: an unknown skill or file
}

// SKILL.md's YAML frontmatter -> { key: value }. The skills here hold flat `key: value` lines only; anything else (a
// nested map, a list, a block scalar) is refused rather than guessed at, so a skill that outgrows this fails its tests.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error('SKILL.md has no YAML frontmatter (--- lines)');
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_-]+):[ \t]+(\S.*)$/.exec(line);
    if (!kv || /^[|>[{&*!]/.test(kv[2])) throw new Error(`SKILL.md frontmatter: only flat "key: value" lines are read here, not ${JSON.stringify(line)}`);
    let v = kv[2].trimEnd();
    if (/^"(?:[^"\\]|\\.)*"$/.test(v)) v = JSON.parse(v);
    else if (/^'(?:[^']|'')*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, '\'');
    else if (/^["']/.test(v) || / #/.test(v) || /: /.test(v)) throw new Error(`SKILL.md frontmatter: ${kv[1]} is not a plain or quoted scalar`);
    if (Object.hasOwn(out, kv[1])) throw new Error(`SKILL.md frontmatter: ${kv[1]} given twice`);
    out[kv[1]] = v;
  }
  return out;
}

// skills: [{ name, files: [{ path, text, size, digest }] }] (cli/skill-files.js) -> the extension's methods. Each
// skill's files include SKILL.md; its frontmatter name must be the skill's name (the spec: the URI's last path
// segment is frontmatter.name).
export function createSkillServer(skills) {
  const byUri = new Map(), list = [];
  for (const s of skills) {
    if (!/^[a-z0-9-]+$/.test(s.name)) throw new Error(`skill name ${JSON.stringify(s.name)}: lowercase letters, digits and hyphens only`);
    const main = s.files.find((f) => f.path === 'SKILL.md');
    if (!main) throw new Error(`skill ${s.name} has no SKILL.md`);
    const fm = frontmatter(main.text);
    if (fm.name !== s.name) throw new Error(`skill ${s.name}: its SKILL.md is named ${JSON.stringify(fm.name)}`);
    if (typeof fm.description !== 'string' || !fm.description) throw new Error(`skill ${s.name}: its SKILL.md has no description`);
    const resources = [];
    for (const f of s.files) {
      if (!mimeOf(f.path)) throw new Error(`skill ${s.name}: ${f.path} is not a text file this server serves (.md, .txt, .json)`);
      if (!/^sha256:[0-9a-f]{64}$/.test(f.digest) || !Number.isInteger(f.size)) throw new Error(`skill ${s.name}: ${f.path} has no size and sha-256 digest`);
      const uri = `${SKILL_SCHEME}${s.name}/${f.path}`;
      if (byUri.has(uri)) throw new Error(`${uri} twice`);
      byUri.set(uri, { file: f, mimeType: mimeOf(f.path) });
      resources.push({ uri, digest: f.digest, size: f.size });
    }
    list.push({ uri: `${SKILL_SCHEME}${s.name}/SKILL.md`, frontmatter: fm, resources });
  }
  const skillOf = (uri) => list.find((s) => s.uri === uri);
  const cache = { ttlMs: SKILL_TTL_MS, cacheScope: 'public' };
  return {
    // the capability's settings object, for capabilities.extensions
    capability: () => ({}),
    list: () => Object.assign({ skills: list.map((s) => structuredClone(s)) }, cache),
    get(params) {
      const uri = params && params.uri;
      if (typeof uri !== 'string') throw new SkillError('skills/get needs params.uri, a skill\'s SKILL.md URI');
      const s = skillOf(uri);
      if (!s) throw new SkillError(`No skill is served at ${uri}`);
      return Object.assign({ skill: structuredClone(s) }, cache);
    },
    // a skill file's resources/read result, or null when the URI is not one (the transport may serve other resources)
    read(uri) {
      const r = typeof uri === 'string' && byUri.get(uri);
      if (!r) return null;
      return Object.assign({ contents: [{ uri, mimeType: r.mimeType, text: r.file.text }] }, cache);
    },
    // resources/list entries for the skill files
    resources: () => [...byUri].map(([uri, r]) => ({ uri, name: uri.slice(SKILL_SCHEME.length), mimeType: r.mimeType, size: r.file.size })),
    isSkillUri: (uri) => typeof uri === 'string' && uri.startsWith(SKILL_SCHEME),
  };
}
