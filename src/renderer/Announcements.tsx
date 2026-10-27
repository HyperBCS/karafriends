import React from "react";

import "./Announcements.css";
import type { Announcement } from "./useSongPlayer";

// The top right corner: a song starting, queued or failing, each for a few
// seconds (App.tsx takes them away). Text from the phones goes in as text,
// never as markup.
export default function Announcements(props: {
  items: (Announcement & { id: number })[];
}) {
  if (props.items.length === 0) return null;
  return (
    <div className="announcements" role="status">
      {props.items.map((item) => (
        <div key={item.id} className="announcement">
          {/* The spaces make the three lines one sentence as text. */}
          <p className={`announcementLabel ${item.tone ?? ""}`}>
            {item.label}
          </p>{" "}
          <p className="announcementTitle">{item.title}</p>{" "}
          {item.detail ? (
            <p className="announcementDetail">{item.detail}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
