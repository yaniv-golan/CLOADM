/* Picture size on the page (the Display tab's aspect and integer scaling), without a DOM. */

// The picture's displayed size in CSS pixels, inside an area of areaW x areaH.
//   aspect: the frame's display aspect (width / height, 4:3 on every machine); lines: its height in lines;
//   fill: use the whole area (the picture is stretched to it); integer: a whole number of display pixels per
//   line (the largest that fits; when not even one fits, the picture just fits the area).
export function fitPicture({ areaW, areaH, aspect, lines, fill = false, integer = false }) {
  if (fill) return { width: Math.floor(areaW), height: Math.floor(areaH) };
  let height = Math.min(areaH, areaW / aspect);
  if (integer) {
    const k = Math.floor(height / lines + 1e-9);
    if (k >= 1) height = k * lines;
  }
  return { width: Math.floor(height * aspect + 1e-9), height: Math.floor(height + 1e-9) };
}

// The picture with its border cut off (the chat on a phone): the frame's active area (frame.active, in frame
// pixels) is fitted to the area, and the whole frame is drawn at that same scale, larger than the area, for the
// area to clip. The pixels are the frame's, only scaled; nothing is reflowed. The active area must be centred in
// the frame (the VDG's is); a frame without one is fitted whole, as by fitPicture.
//   -> { width, height } of the whole frame in CSS pixels
export function fitActive({ areaW, areaH, frame, integer = false }) {
  const a = frame.active;
  if (!a) return fitPicture({ areaW, areaH, aspect: frame.aspect, lines: frame.height, integer });
  const fx = a.width / frame.width, fy = a.height / frame.height;
  const inner = fitPicture({ areaW, areaH, aspect: frame.aspect * fx / fy, lines: a.height, integer });
  return { width: Math.round(inner.width / fx), height: Math.round(inner.height / fy) };
}
