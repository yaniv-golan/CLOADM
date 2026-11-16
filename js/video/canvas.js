/*
 * Presenters: draw a Frame into a <canvas>. The page uses the WebGL presenter (the CRT look, or the pixels as
 * they are), and the Canvas 2D one where WebGL is not available (the pixels only).
 *   present(frame, display, width, height): display = the Display tab's settings (Session.display); width and
 *   height = the picture's size in CSS pixels.
 */
import { frameToRGBA } from './frame.js';

class CanvasPresenter {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    this.pixels = null;
    this.crt = false;           // no CRT look without WebGL
    this.restores = 0;          // (a 2D canvas keeps its pixels: never restored)
  }
  present(frame) {
    const c = this.canvas;
    if (!this.image || c.width !== frame.width || c.height !== frame.height) {
      c.width = frame.width; c.height = frame.height;
      this.image = this.ctx.createImageData(frame.width, frame.height);
      this.pixels = new Uint32Array(this.image.data.buffer);
    }
    frameToRGBA(frame, this.pixels);
    this.ctx.putImageData(this.image, 0, 0);
  }
}

// The CRT look. The picture's lines become horizontal beams with a soft vertical profile (so dark gaps show
// between them; with fewer than three display pixels per line the gaps fade out, as they would only alias into
// bands on a curved screen), pixels blur slightly along each line, a wider blur is added as phosphor
// glow, the tube's face bends outwards (curvature) and darkens towards the edges. Sharp: each frame pixel
// drawn as a block (nearest sampling), nothing else.
const VERTEX = `attribute vec2 pos; varying vec2 uv;
void main() { uv = vec2(pos.x, -pos.y) * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`;
const FRAGMENT = `precision mediump float;
uniform sampler2D tex; uniform vec2 texSize; uniform float crt, curv, glow, lineScale;
varying vec2 uv;
vec3 px(vec2 p) { return texture2D(tex, p).rgb; }
void main() {
  if (crt < 0.5) { gl_FragColor = vec4(px(uv), 1.0); return; }
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + curv * vec2(c.y * c.y, c.x * c.x);
  vec2 p = c * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float y = p.y * texSize.y - 0.5, y0 = floor(y), f = y - y0;
  vec3 a = px(vec2(p.x, (y0 + 0.5) / texSize.y)), b = px(vec2(p.x, (y0 + 1.5) / texSize.y));
  vec3 beams = (a * exp(-f * f * 5.0) + b * exp(-(1.0 - f) * (1.0 - f) * 5.0)) * 1.2;
  vec3 col = mix(px(p), beams, clamp((lineScale - 1.5) / 1.5, 0.0, 1.0));
  vec2 d = 1.5 / texSize;
  vec3 g = px(p + vec2(d.x, 0.0)) + px(p - vec2(d.x, 0.0)) + px(p + vec2(0.0, d.y)) + px(p - vec2(0.0, d.y))
    + px(p + 2.0 * d) + px(p - 2.0 * d) + px(p + 2.0 * vec2(d.x, -d.y)) + px(p + 2.0 * vec2(-d.x, d.y));
  col += g / 8.0 * glow * 0.6;
  col *= 1.0 - 0.18 * dot(c * c, vec2(0.5));
  gl_FragColor = vec4(min(col, 1.0), 1.0);
}`;

class GlPresenter {
  // a GlPresenter, or null where the browser has no WebGL
  static create(canvas) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    return gl ? new GlPresenter(canvas, gl) : null;
  }
  constructor(canvas, gl) {
    this.canvas = canvas; this.gl = gl;
    this.crt = true;
    this.lost = false;
    this.restores = 0;          // context restores so far: a restored canvas is blank until the picture is drawn again
    // The context can be lost at any time (a GPU reset, a mobile tab evicted, a laptop waking). Cancelling the
    // event asks the browser to restore it; restored, everything the context held (program, buffer, texture) is
    // gone and is built again. Meanwhile present() draws nothing.
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.setup(); this.lost = false; this.restores++; });
    this.setup();
  }
  // the program, the quad and the texture (again after a context restore)
  setup() {
    const gl = this.gl;
    const shader = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, 'pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['texSize', 'crt', 'curv', 'glow', 'lineScale']) this.u[n] = gl.getUniformLocation(prog, n);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.pixels = null; this.bytes = null; this.filter = null;
    this.texW = 0; this.texH = 0;   // the texture's storage size: allocated once per size, then updated in place
  }
  present(frame, display, width, height) {
    if (this.lost) return;
    const gl = this.gl, c = this.canvas, ratio = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    const n = frame.width * frame.height;
    if (!this.pixels || this.pixels.length !== n) { this.pixels = new Uint32Array(n); this.bytes = new Uint8Array(this.pixels.buffer); }
    frameToRGBA(frame, this.pixels);
    const crt = display.view === 'crt', filter = crt ? gl.LINEAR : gl.NEAREST;
    if (filter !== this.filter) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      this.filter = filter;
    }
    if (frame.width !== this.texW || frame.height !== this.texH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, frame.width, frame.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.bytes);
      this.texW = frame.width; this.texH = frame.height;
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, this.bytes);
    gl.uniform2f(this.u.texSize, frame.width, frame.height);
    gl.uniform1f(this.u.crt, crt ? 1 : 0);
    gl.uniform1f(this.u.curv, display.curvature / 100 * 0.12);
    gl.uniform1f(this.u.glow, display.glow / 100);
    gl.uniform1f(this.u.lineScale, h / frame.height);   // device pixels per line
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

export { CanvasPresenter, GlPresenter };
