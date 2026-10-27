import React, { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import type { SharedQueueItem } from "../../common/api";
import { useLiveState } from "../../common/apiClient";
import useUserIdentity from "../hooks/useUserIdentity";
import isOwnSong from "../isOwnSong";

import Button from "../components/Button";
import { withLoader } from "../components/Loader";
import SearchFormWrapper from "../components/SearchFormWrapper";
import YouTubeInfo from "../components/YouTubeInfo";

export function getVideoId(videoQuery: string): string | null {
  try {
    const url = new URL(videoQuery);
    return url.hostname === "youtu.be"
      ? url.pathname.replace("/", "")
      : url.searchParams.get("v");
  } catch (e) {
    if (e instanceof Error && e.name !== "TypeError") {
      throw e;
    }
  }
  return videoQuery;
}

// Whether this phone's YouTube video with adhoc lyrics is playing, so its
// singer gets the lyrics controls.
export function isYouTubeVideoWithLyricsPlaying(
  currentSong: SharedQueueItem | null | undefined,
  videoId: string,
  nickname: string,
): boolean {
  return (
    currentSong?.kind === "youtube" &&
    currentSong.songId === videoId &&
    isOwnSong(currentSong, nickname) &&
    currentSong.hasAdhocLyrics
  );
}

type YouTubeParams = {
  videoId: string;
};

const YouTubePage = () => {
  const navigate = useNavigate();
  const { nickname } = useUserIdentity();
  const currentSong = useLiveState()?.currentSong;

  const params = useParams<YouTubeParams>();
  const inputRef = useRef<HTMLInputElement>(null);

  const [videoId, setVideoId] = useState<string>(params.videoId || "");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputRef.current) return;
    const newVideoId = getVideoId(inputRef.current.value);
    if (newVideoId !== null) {
      setVideoId(newVideoId);
      history.replaceState({}, "", `#/search/youtube/${newVideoId}`);
    }
  };

  if (
    isYouTubeVideoWithLyricsPlaying(
      currentSong,
      videoId || params.videoId || "",
      nickname,
    )
  ) {
    navigate(`/adhocLyrics/${videoId || params.videoId || ""}`);
  }

  return (
    <SearchFormWrapper>
      <h2>Add YouTube video</h2>
      <form onSubmit={onSubmit}>
        <input
          ref={inputRef}
          placeholder="YouTube video URL or ID"
          defaultValue={videoId}
        />
        <Button type="submit">Get Video Info</Button>
      </form>
      {videoId !== "" && <YouTubeInfo videoId={videoId} />}
    </SearchFormWrapper>
  );
};

export default withLoader(YouTubePage);
