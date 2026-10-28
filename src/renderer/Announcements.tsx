import React from "react";

import "./Announcements.css";
import { SongLines } from "./UpNext";
import type { Announcement } from "./useSongPlayer";

// The top right corner: a song starting, queued or failing, each for a few
// seconds (App.tsx takes them away), with the song's title, artist and
// singer as the up-next strip shows them, but with the singer's whole
// nickname beside the initial. Text from the phones goes in as text, never
// as markup.
export default function Announcements(props: {
  items: (Announcement & { id: number })[];
}) {
  if (props.items.length === 0) return null;
  return (
    <div className="announcements" role="status">
      {props.items.map((item) => (
        <div key={item.id} className="announcement">
          {/* The spaces make the lines one sentence as text. */}
          <p className={`announcementLabel ${item.tone ?? ""}`}>
            {item.label}
          </p>{" "}
          <SongLines song={item.song} />{" "}
          {item.detail ? (
            <p className="announcementDetail">{item.detail}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
