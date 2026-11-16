/*
 * Frame: the picture a video chip produces, as colour codes (one byte per pixel) plus a colour
 * table mapping codes to RGBA. Chips draw scanlines into it as the beam passes; presenters
 * (Canvas2D now, WebGL/composite later) turn it into pixels. Swapping the table (e.g. the CoCo 3's
 * RGB/composite monitor) needs no re-render.
 */
class Frame {
  // active: where the chip's picture area sits inside the border, { x, y, width, height } in frame pixels, when it
  // is fixed (the VDG's); null when it moves with the mode (the GIME's)
  constructor(width, height, aspect = 4 / 3, active = null) {
    this.width = width;
    this.height = height;
    this.aspect = aspect;                       // display aspect ratio of the whole frame
    this.active = active;
    this.data = new Uint8Array(width * height); // colour codes
    this.table = new Uint32Array(256);          // code -> 0xAABBGGRR (little-endian RGBA bytes)
  }
}
// the frame as RGBA pixels (Uint32 per pixel, little-endian RGBA bytes)
export const frameToRGBA = (frame, out = new Uint32Array(frame.width * frame.height)) => {
  const d = frame.data, t = frame.table;
  for (let i = 0; i < d.length; i++) out[i] = t[d[i]];
  return out;
};
export const rgb = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;

export { Frame };
