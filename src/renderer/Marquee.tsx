import React from "react";

import useMarquee from "../common/hooks/useMarquee";

// One line, such as a song's title, that slides to show all of itself when
// it doesn't fit (.kfMarquee in ui.css). The className goes on the box,
// which clips; give it no padding.
export default function Marquee(props: {
  className?: string;
  children: React.ReactNode;
}) {
  const { box, text } = useMarquee();
  return (
    <span
      ref={box}
      className={props.className ? `kfMarquee ${props.className}` : "kfMarquee"}
    >
      <span ref={text} className="kfMarqueeText">
        {props.children}
      </span>
    </span>
  );
}
