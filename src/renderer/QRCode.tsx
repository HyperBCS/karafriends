import { toCanvas } from "qrcode";
import React, { useEffect, useRef } from "react";

import "./QRCode.css";

// The remote's QR code with its address under it: big, with "Scan to
// join", on the idle screen; small in the top-left corner while a song
// plays.
function QRCode(props: { hostname: string; corner?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    function update() {
      if (!canvasRef.current) return;

      canvasRef.current.style.width = "100%";
      toCanvas(
        canvasRef.current,
        `http://${props.hostname}`,
        {
          errorCorrectionLevel: "L",
          width: canvasRef.current.clientWidth,
        },
        (error) => {
          if (error) {
            console.error(error);
          }
        },
      );
    }

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  });

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
      {props.corner ? null : <p className="joinScan">Scan to join</p>}
      <p className="joinAddress">{props.hostname}</p>
    </div>
  );
}

export default QRCode;
