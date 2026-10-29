import { create } from "qrcode";
import React, { useEffect, useRef } from "react";

import "./QRCode.css";
import { addressText } from "./remoteAddress";

// The white border round the code, in modules. Cameras need light round
// the corner squares to find the code: with none it doesn't scan. The
// standard asks for 4; 2 is the least that held up over the pitch bars
// (OpenCV read the corner code at 1440p down to 40 % of its size with 2,
// but only to 75 % with 1).
const QUIET_ZONE = 2;

// Draws the code, with its border, as near the box's width as whole
// screen pixels per module allow, so its squares stay sharp at any size.
// The canvas is the white tile: it ends where the border does, its corners
// rounded by one module, which only takes from the border.
function draw(canvas: HTMLCanvasElement, text: string) {
  const box = canvas.parentElement;
  if (!box) return;
  const { modules } = create(text, { errorCorrectionLevel: "L" });
  const count = modules.size + QUIET_ZONE * 2;
  const ratio = window.devicePixelRatio || 1;
  const scale = Math.max(1, Math.round((box.clientWidth * ratio) / count));
  const pixels = count * scale;
  canvas.width = pixels;
  canvas.height = pixels;
  canvas.style.width = `${pixels / ratio}px`;
  canvas.style.height = `${pixels / ratio}px`;
  canvas.style.borderRadius = `${scale / ratio}px`;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = "#000";
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) {
        context.fillRect(
          (col + QUIET_ZONE) * scale,
          (row + QUIET_ZONE) * scale,
          scale,
          scale,
        );
      }
    }
  }
}

// The remote's QR code for url (http://192.168.1.20:8080, or a custom
// URL): big on the idle screen, with "Scan to join" and the address under
// it for typing; while a song plays, the code alone on a small tile in the
// top-left corner.
function QRCode(props: { url: string; corner?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Again when the box changes size (the window, the UI scale).
  useEffect(() => {
    const canvas = canvasRef.current;
    const tile = canvas?.parentElement;
    if (!canvas || !tile) return;
    const update = () => draw(canvas, props.url);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tile);
    return () => observer.disconnect();
  }, [props.url]);

  return (
    <div className={props.corner ? "join joinCorner" : "join"}>
      <div className="joinCode">
        <canvas
          ref={canvasRef}
          className="qrcode"
          role="img"
          aria-label="QR code for the remote"
        />
      </div>
      {props.corner ? null : (
        <>
          <p className="joinScan">Scan to join</p>
          <p className="joinAddress">{addressText(props.url)}</p>
        </>
      )}
    </div>
  );
}

export default QRCode;
