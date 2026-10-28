import classnames from "classnames";
import React from "react";

import useMarquee from "../../../common/hooks/useMarquee";
import * as styles from "./Marquee.module.scss";

interface Props {
  children: React.ReactNode;
  // Goes on the box, which clips: give it no padding.
  className?: string;
}

// One line, such as a song's title, that slides to show all of itself when
// it doesn't fit: to its end, a pause, back, a pause, over and over. It
// stays still, ending in an ellipsis, when the phone asks for less motion.
export const Marquee = ({ children, className }: Props) => {
  const { box, text } = useMarquee();
  return (
    <span ref={box} className={classnames(styles.marquee, className)}>
      <span ref={text} className={styles.text}>
        {children}
      </span>
    </span>
  );
};
