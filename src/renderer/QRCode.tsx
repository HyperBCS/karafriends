import { create } from "qrcode";
import React, { useEffect, useRef } from "react";

import "./QRCode.css";

// The white border round the code, in modules: the 2 phone cameras need,
// rather than the standard's 4, so the modules are bigger in the same
// space.
const QUIET_ZONE = 2;

// Draws the code with each module a whole number of the screen's pixels,
// as big as fits the tile, so its squares stay sharp at any size. The tile
// is white too, so what doesn't divide evenly widens the border.
function draw(canvas: HTMLCanvasElement, text: string) {
  const tile = canvas.parentElement;
  if (!tile) return;
  const { modules } = create(text, { errorCorrectionLevel: "L" });
  const count = modules.size + QUIET_ZONE * 2;
  const ratio = window.devicePixelRatio || 1;
  const scale = Math.max(1, Math.floor((tile.clientWidth * ratio) / count));
  const pixels = count * scale;
  canvas.width = pixels;
  canvas.height = pixels;
  canvas.style.width = `${pixels / ratio}px`;
  canvas.style.height = `${pixels / ratio}px`;

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

// The remote's QR code: big on the idle screen, with "Scan to join" and
// the address under it for typing; while a song plays, the code alone on a
// small tile in the top-left corner.
function QRCode(props: { hostname: string; corner?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Again when the tile changes size (the window, the UI scale).
  useEffect(() => {
    const canvas = canvasRef.current;
    const tile = canvas?.parentElement;
    if (!canvas || !tile) return;
    const update = () => draw(canvas, `http://${props.hostname}`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tile);
    return () => observer.disconnect();
  }, [props.hostname]);

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
          <p className="joinAddress">{props.hostname}</p>
        </>
      )}
    </div>
  );
}

export default QRCode;
