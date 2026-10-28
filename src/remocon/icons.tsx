import React from "react";

// The remote's icons, copied from react-icons 5.7.0 (which ships tens of
// thousands of them) and drawn as it drew them: 1em square, in the text
// color. The names are react-icons', whose prefix says where each comes from:
//   Bi  Boxicons (MIT)
//   Bs  Bootstrap Icons (MIT)
//   Fa  Font Awesome Free 5 (CC BY 4.0, https://fontawesome.com/license/free)
//   Md  Material Design icons by Google (Apache 2.0)

const Svg = ({ children, ...attrs }: React.SVGProps<SVGSVGElement>) => (
  <svg
    fill="currentColor"
    height="1em"
    width="1em"
    xmlns="http://www.w3.org/2000/svg"
    {...attrs}
  >
    {children}
  </svg>
);

export const BiLoaderAlt = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M12 22c5.421 0 10-4.579 10-10h-2c0 4.337-3.663 8-8 8s-8-3.663-8-8c0-4.336 3.663-8 8-8V2C6.579 2 2 6.58 2 12c0 5.421 4.579 10 10 10z" />
  </Svg>
);

export const BsMusicPlayerFill = () => (
  <Svg viewBox="0 0 16 16">
    <path d="M8 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2" />
    <path d="M4 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2zm1 2h6a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1m3 12a3 3 0 1 1 0-6 3 3 0 0 1 0 6" />
  </Svg>
);

export const FaAngleDown = () => (
  <Svg viewBox="0 0 320 512">
    <path d="M143 352.3L7 216.3c-9.4-9.4-9.4-24.6 0-33.9l22.6-22.6c9.4-9.4 24.6-9.4 33.9 0l96.4 96.4 96.4-96.4c9.4-9.4 24.6-9.4 33.9 0l22.6 22.6c9.4 9.4 9.4 24.6 0 33.9l-136 136c-9.2 9.4-24.4 9.4-33.8 0z" />
  </Svg>
);

export const FaAngleUp = () => (
  <Svg viewBox="0 0 320 512">
    <path d="M177 159.7l136 136c9.4 9.4 9.4 24.6 0 33.9l-22.6 22.6c-9.4 9.4-24.6 9.4-33.9 0L160 255.9l-96.4 96.4c-9.4 9.4-24.6 9.4-33.9 0L7 329.7c-9.4-9.4-9.4-24.6 0-33.9l136-136c9.4-9.5 24.6-9.5 34-.1z" />
  </Svg>
);

export const FaSmile = () => (
  <Svg viewBox="0 0 496 512">
    <path d="M248 8C111 8 0 119 0 256s111 248 248 248 248-111 248-248S385 8 248 8zm80 168c17.7 0 32 14.3 32 32s-14.3 32-32 32-32-14.3-32-32 14.3-32 32-32zm-160 0c17.7 0 32 14.3 32 32s-14.3 32-32 32-32-14.3-32-32 14.3-32 32-32zm194.8 170.2C334.3 380.4 292.5 400 248 400s-86.3-19.6-114.8-53.8c-13.6-16.3 11-36.7 24.6-20.5 22.4 26.9 55.2 42.2 90.2 42.2s67.8-15.4 90.2-42.2c13.4-16.2 38.1 4.2 24.6 20.5z" />
  </Svg>
);

export const MdArrowBack = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" />
  </Svg>
);

export const MdClose = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </Svg>
);

export const MdEdit = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z" />
  </Svg>
);

export const MdHome = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
  </Svg>
);

export const MdPause = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M6 19h4V5H6zm8-14v14h4V5z" />
  </Svg>
);

export const MdPerson = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4m0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4" />
  </Svg>
);

export const MdPlayArrow = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M8 5v14l11-7z" />
  </Svg>
);

export const MdReplay = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8" />
  </Svg>
);

export const MdSearch = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14" />
  </Svg>
);

export const MdSkipNext = () => (
  <Svg viewBox="0 0 24 24">
    <path d="m6 18 8.5-6L6 6zM16 6v12h2V6z" />
  </Svg>
);

export const MdTranslate = () => (
  <Svg viewBox="0 0 24 24">
    <path d="m12.87 15.07-2.54-2.51.03-.03A17.5 17.5 0 0 0 14.07 6H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2zm-2.62 7 1.62-4.33L19.12 17z" />
  </Svg>
);

export const MdVerticalAlignTop = () => (
  <Svg viewBox="0 0 24 24">
    <path d="M8 11h3v10h2V11h3l-4-4zM4 3v2h16V3z" />
  </Svg>
);

export const MdDragIndicator = () => (
  <svg fill="currentColor" height="1em" width="1em" viewBox="0 0 24 24">
    <path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
  </svg>
);
